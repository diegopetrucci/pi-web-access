import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	CACHE_RELATIVE_PATH,
	SETTINGS_RELATIVE_PATH,
	getCacheDir,
	getDomainPolicy,
	getFetchTimeoutMs,
	getSettingsPath,
	readSettings,
	requireAgentDir,
} from "../settings.ts";
import { Agent, fetch as dependencyFetch } from "undici";
import {
	DEFAULT_FETCH,
	fetchRemoteUrl,
	isBlockedAddress,
	MAX_RESPONSE_BYTES,
	validateRemoteUrl,
	USER_AGENT,
} from "../ssrf-protection.ts";
import {
	remainingRequestOperations,
	resetRequestOperations,
} from "../request-budget.ts";

async function profile(settings = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-tlh-security-"));
	const settingsDir = join(root, ...SETTINGS_RELATIVE_PATH.slice(0, -1));
	await mkdir(settingsDir, { recursive: true });
	await writeFile(join(settingsDir, SETTINGS_RELATIVE_PATH.at(-1)), JSON.stringify(settings) + "\n", "utf8");
	return root;
}

async function withProfile(root, fn) {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const publicFetchOptions = (fetch) => ({ lookup: publicLookup, fetch });

function assertBlocked(url) {
	return assert.rejects(
		validateRemoteUrl(url, { lookup: publicLookup }),
		/Blocked internal|Only HTTP|Blocked hostname/,
	);
}

test("default transport shares the declared Undici generation with its Agent", async () => {
	assert.equal(DEFAULT_FETCH, dependencyFetch);
	const server = createServer((_request, response) => response.end("undici-compatible"));
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const dispatcher = new Agent({ keepAliveTimeout: 1, maxCachedSessions: 0 });
	try {
		const response = await DEFAULT_FETCH(`http://127.0.0.1:${address.port}/`, { dispatcher });
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "undici-compatible");
	} finally {
		await dispatcher.close();
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});

test("TLH settings and cache paths never fall back to home or XDG", async () => {
	const root = await profile({ marker: "agent-only" });
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-home-trap-"));
	const xdg = await mkdtemp(join(tmpdir(), "pi-web-access-xdg-trap-"));
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		encoding: "utf8",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: root,
			HOME: home,
			XDG_CONFIG_HOME: xdg,
		},
		input: `
			const { readSettings, getSettingsPath, getCacheDir } = await import(${JSON.stringify(new URL("../settings.ts", import.meta.url).href)});
			console.log(JSON.stringify({ settings: readSettings(), settingsPath: getSettingsPath(), cacheDir: getCacheDir() }));
		`,
	});
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout);
	assert.deepEqual(output.settings, { marker: "agent-only" });
	assert.equal(output.settingsPath, getSettingsPath(root));
	assert.equal(output.cacheDir, getCacheDir(root));
	assert.equal(output.cacheDir.endsWith(join(...CACHE_RELATIVE_PATH)), true);
});

test("missing PI_CODING_AGENT_DIR fails at tool time before runtime loading", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_CODING_AGENT_DIR;
	try {
		assert.throws(() => requireAgentDir(), /PI_CODING_AGENT_DIR/);
		const { default: register } = await import("../index.ts");
		const tools = [];
		register({ registerTool(definition) { tools.push(definition); }, on() {} });
		await assert.rejects(tools[0].execute("call", { query: "test" }), /PI_CODING_AGENT_DIR/);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("settings are read on every request and fetch.timeout validation is bounded", async () => {
	const root = await profile({ exaApiKey: "first", fetch: { timeout: 7 } });
	await withProfile(root, async () => {
		assert.equal(readSettings().exaApiKey, "first");
		assert.equal(getFetchTimeoutMs(), 7000);
		await writeFile(getSettingsPath(root), JSON.stringify({ exaApiKey: "second", fetch: { timeout: 121 } }), "utf8");
		assert.equal(readSettings().exaApiKey, "second");
		assert.throws(() => getFetchTimeoutMs(), /fetch\.timeout/);
		await writeFile(getSettingsPath(root), JSON.stringify({ fetch: null }), "utf8");
		assert.throws(() => getFetchTimeoutMs(), /fetch must be an object/);
		await writeFile(getSettingsPath(root), JSON.stringify({}), "utf8");
		assert.equal(getFetchTimeoutMs(), 30000);
	});
});

test("literal and DNS-resolved private and special ranges are fail-closed", async () => {
	for (const url of [
		"http://localhost/", "http://foo.local/", "http://foo.internal/",
		"http://127.0.0.1/", "http://2130706433/", "http://0177.0.0.1/",
		"http://10.0.0.1/", "http://172.16.0.1/", "http://192.168.1.1/",
		"http://169.254.169.254/", "http://100.64.0.1/", "http://198.18.0.1/",
		"http://192.0.2.1/", "http://198.51.100.1/", "http://203.0.113.1/",
		"http://224.0.0.1/", "http://[::1]/", "http://[fe80::1]/",
		"http://[fd00::1]/", "http://[ff02::1]/", "http://[::ffff:127.0.0.1]/",
		"http://[2001:db8::1]/", "http://[2001:20::1]/", "http://[100::1]/",
	]) {
		await assertBlocked(url);
	}
	assert.equal(isBlockedAddress("8.8.8.8"), false);
	assert.equal((await validateRemoteUrl("http://93.184.216.34/", { lookup: publicLookup })).hostname, "93.184.216.34");
});

test("deprecated IPv6 site-local addresses are blocked from literals and DNS answers", async () => {
	const cases = [
		["fec0::1", "site-local-lower.example"],
		["feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "site-local-upper.example"],
	];
	for (const [address, hostname] of cases) {
		assert.equal(isBlockedAddress(address), true);
		assert.equal(isBlockedAddress(address.toUpperCase()), true);
		await assert.rejects(
			validateRemoteUrl(`http://[${address}]/`, { lookup: publicLookup }),
			/Blocked internal address/,
		);
		await assert.rejects(
			validateRemoteUrl(`https://${hostname}/`, {
				lookup: async () => [{ address, family: 6 }],
			}),
			/Blocked internal address/,
		);
	}
	// Existing IPv6 denials remain blocked alongside the deprecated site-local range.
	assert.equal(isBlockedAddress("fe80::1"), true);
	assert.equal(isBlockedAddress("fc00::1"), true);
	assert.equal(isBlockedAddress("ff00::1"), true);
});

test("DNS errors, empty answers, and mixed answers fail closed", async () => {
	await assert.rejects(validateRemoteUrl("https://unresolved.example/", { lookup: async () => { throw new Error("resolver secret"); } }), /Failed to resolve unresolved\.example/);
	await assert.rejects(validateRemoteUrl("https://empty.example/", { lookup: async () => [] }), /no addresses returned/);
	await assert.rejects(validateRemoteUrl("https://mixed.example/", {
		lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.2", family: 4 }],
	}), /Blocked internal address/);
});

test("only HTTP and HTTPS are accepted", async () => {
	for (const url of ["file:///etc/passwd", "ftp://example.com/", "data:text/plain,secret", "javascript:alert(1)"]) {
		await assert.rejects(validateRemoteUrl(url), /Invalid remote URL|Only HTTP and HTTPS/);
	}
});

test("domain allow and deny policy is only fetchContent.domainPolicy", async () => {
	const root = await profile({ fetchContent: { domainPolicy: { allow: ["example.com"], deny: ["private.example.com"] } } });
	await withProfile(root, async () => {
		assert.deepEqual(getDomainPolicy(), { allow: ["example.com"], deny: ["private.example.com"] });
		assert.deepEqual(getDomainPolicy({ domainPolicy: { allow: ["wrong.example"], deny: [] } }), { allow: [], deny: [] });
		await validateRemoteUrl("https://www.example.com/", { lookup: publicLookup, domainPolicy: getDomainPolicy() });
		await assert.rejects(validateRemoteUrl("https://other.example/", { lookup: publicLookup, domainPolicy: getDomainPolicy() }), /not allowed/);
		await assert.rejects(validateRemoteUrl("https://private.example.com/", { lookup: publicLookup, domainPolicy: getDomainPolicy() }), /Blocked hostname by fetch_content domain policy/);
	});
});

test("redirects are manual, bounded, and revalidated per hop", async () => {
	const root = await profile();
	await withProfile(root, async () => {
		resetRequestOperations();
		const calls = [];
		const response = await fetchRemoteUrl("https://example.com/start", {}, publicFetchOptions(async (url, init) => {
			calls.push({ url: String(url), redirect: init.redirect });
			return calls.length === 1
				? new Response("", { status: 302, headers: { location: "https://example.com/next" } })
				: new Response("ok");
		}));
		assert.equal(await response.text(), "ok");
		assert.deepEqual(calls.map((call) => call.url), ["https://example.com/start", "https://example.com/next"]);
		assert.equal(calls.every((call) => call.redirect === "manual"), true);

		resetRequestOperations();
		let redirectCalls = 0;
		await assert.rejects(fetchRemoteUrl("https://example.com/start", {}, publicFetchOptions(async () => {
			redirectCalls += 1;
			return new Response("", { status: 302, headers: { location: `https://example.com/hop-${redirectCalls}` } });
		})), /Too many redirects/);
		assert.equal(redirectCalls, 6);
	});
});

test("redirect targets obey per-hop policy and private-address checks", async () => {
	const root = await profile();
	await withProfile(root, async () => {
		resetRequestOperations();
		const calls = [];
		await assert.rejects(fetchRemoteUrl("https://allowed.example/", {}, {
			lookup: publicLookup,
			domainPolicy: { allow: ["allowed.example", "denied.example"], deny: ["denied.example"] },
			fetch: async (url) => {
				calls.push(String(url));
				return new Response("", { status: 302, headers: { location: "https://denied.example/next" } });
			},
		}), /domain policy/);
		assert.deepEqual(calls, ["https://allowed.example/"]);

		resetRequestOperations();
		await assert.rejects(fetchRemoteUrl("https://example.com/", {}, publicFetchOptions(async () =>
			new Response("", { status: 302, headers: { location: "http://127.0.0.1/admin" } }),
		)), /Blocked internal address/);
	});
});

test("redirects strip credentials only when crossing origins", async () => {
	const root = await profile();
	await withProfile(root, async () => {
		resetRequestOperations();
		const calls = [];
		const response = await fetchRemoteUrl("https://one.example/start", {
			headers: { Authorization: "Bearer configured-secret", "x-api-key": "configured-secret" },
		}, {
			lookup: publicLookup,
			fetch: async (url, init) => {
				calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)) });
				if (calls.length === 1) return new Response("", { status: 302, headers: { location: "https://one.example/same" } });
				if (calls.length === 2) return new Response("", { status: 302, headers: { location: "https://two.example/cross" } });
				return new Response("done");
			},
		});
		assert.equal(await response.text(), "done");
		assert.equal(calls[1].headers.authorization, "Bearer configured-secret");
		assert.equal(calls[1].headers["x-api-key"], "configured-secret");
		assert.equal(calls[2].headers.authorization, undefined);
		assert.equal(calls[2].headers["x-api-key"], undefined);
		assert.equal(calls.every((call) => call.headers["user-agent"] === USER_AGENT), true);
	});
});

test("DNS rebinding is rejected by the connect-time re-resolution", async () => {
	const root = await profile();
	await withProfile(root, async () => {
		resetRequestOperations();
		let lookups = 0;
		let fetches = 0;
		await assert.rejects(fetchRemoteUrl("https://rebind.example/", {}, {
			lookup: async () => {
				lookups += 1;
				return lookups === 1
					? [{ address: "93.184.216.34", family: 4 }]
					: [{ address: "127.0.0.1", family: 4 }];
			},
			fetch: async () => {
				fetches += 1;
				return new Response("unexpected");
			},
		}), /Blocked internal address/);
		assert.equal(fetches, 0);
		assert.equal(lookups >= 2, true);
	});
});

test("gzip responses are decoded and streamed responses are capped at 5 MiB", async () => {
	const root = await profile();
	await withProfile(root, async () => {
		resetRequestOperations();
		const compressed = await fetchRemoteUrl("https://example.com/gzip", {}, publicFetchOptions(async () =>
			new Response(gzipSync("compressed payload"), { headers: { "content-encoding": "gzip" } }),
		));
		assert.equal(await compressed.text(), "compressed payload");

		resetRequestOperations();
		const chunk = new Uint8Array(MAX_RESPONSE_BYTES);
		const oversized = await fetchRemoteUrl("https://example.com/large", {}, publicFetchOptions(async () =>
			new Response(new ReadableStream({
				start(controller) {
					controller.enqueue(chunk);
					controller.enqueue(new Uint8Array([1]));
					controller.close();
				},
			})),
		));
		await assert.rejects(oversized.text(), /Response too large/);
	});
});

test("fetch timeout is end-to-end, settings-only, and provider secrets are redacted", async () => {
	const secret = "configured-secret-value";
	const root = await profile({ exaApiKey: secret, fetch: { timeout: 1 } });
	await withProfile(root, async () => {
		resetRequestOperations();
		const started = Date.now();
		await assert.rejects(fetchRemoteUrl("https://slow.example/", {}, publicFetchOptions((_url, init) =>
			new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error(`transport echoed ${secret}`)), { once: true })),
		)), (err) => {
			assert.match(err.message, /timed out/);
			assert.equal(err.message.includes(secret), false);
			return true;
		});
		assert.equal(Date.now() - started < 2500, true);

		resetRequestOperations();
		const response = await fetchRemoteUrl("https://stalled-body.example/", {}, publicFetchOptions(async () =>
			new Response(new ReadableStream({
				pull() {
					return new Promise(() => {});
				},
			})),
		));
		await assert.rejects(response.text(), (err) => {
			assert.match(err.message, /timed out/);
			return true;
		});
	});
});

test("one shared six-operation budget covers page/provider requests", async () => {
	const root = await profile();
	await withProfile(root, async () => {
		resetRequestOperations();
		const fetchImpl = async () => new Response("ok");
		for (let index = 0; index < 6; index++) {
			const response = await fetchRemoteUrl(`https://example.com/${index}`, {}, publicFetchOptions(fetchImpl));
			assert.equal(await response.text(), "ok");
		}
		assert.equal(remainingRequestOperations(), 0);
		await assert.rejects(fetchRemoteUrl("https://example.com/exhausted", {}, publicFetchOptions(fetchImpl)), /budget exhausted/);
		resetRequestOperations();
		assert.equal(remainingRequestOperations(), 6);
	});
});

test("request transport does not expose an environment proxy or range escape hatch", async () => {
	const root = await profile();
	await withProfile(root, async () => {
		const previous = process.env.HTTPS_PROXY;
		process.env.HTTPS_PROXY = "http://proxy.invalid:8080";
		try {
			resetRequestOperations();
			let captured;
			const response = await fetchRemoteUrl("https://example.com/", {}, publicFetchOptions(async (_url, init) => {
				captured = init;
				return new Response("ok");
			}));
			assert.equal(await response.text(), "ok");
			assert.equal("proxy" in captured, false);
			assert.equal("allowRanges" in captured, false);
		} finally {
			if (previous === undefined) delete process.env.HTTPS_PROXY;
			else process.env.HTTPS_PROXY = previous;
		}
	});
});
