import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const exaUrl = new URL("../exa.ts", import.meta.url).href;
const webToolsUrl = new URL("../web-tools.ts", import.meta.url).href;
const requestBudgetUrl = new URL("../request-budget.ts", import.meta.url).href;

function runChild(source) {
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: source,
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
		env: (() => {
			const env = { ...process.env };
			delete env.PI_CODING_AGENT_DIR;
			delete env.EXA_API_KEY;
			delete env.EXA_BASE_URL;
			return env;
		})(),
	});
}

function parseChild(child) {
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

const profileSetup = `
	const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-exa-ticket-"));
	const settingsDir = join(root, "extensions", "pi-web-access");
	await mkdir(settingsDir, { recursive: true });
	const settingsPath = join(settingsDir, "settings.json");
	process.env.PI_CODING_AGENT_DIR = root;
`;

test("Exa settings credentials take precedence and rotate per request", () => {
	const child = runChild(`
		${profileSetup}
		await writeFile(settingsPath, JSON.stringify({ exaApiKey: "settings-key-one" }));
		process.env.EXA_API_KEY = "environment-key";
		const calls = [];
		const fetch = async (url, init) => {
			calls.push({ url: String(url), key: new Headers(init.headers).get("x-api-key") });
			return new Response(JSON.stringify({ results: [] }), { status: 200 });
		};
		globalThis.fetch = fetch;
		const { searchWithExa } = await import(${JSON.stringify(exaUrl)});
		const { resetRequestOperations } = await import(${JSON.stringify(requestBudgetUrl)});
		resetRequestOperations();
		await searchWithExa("first", { fetch });
		await writeFile(settingsPath, JSON.stringify({ exaApiKey: "settings-key-two" }));
		await searchWithExa("second", { fetch });
		console.log(JSON.stringify(calls));
	`);
	const calls = parseChild(child);
	assert.deepEqual(calls, [
		{ url: "https://api.exa.ai/search", key: "settings-key-one" },
		{ url: "https://api.exa.ai/search", key: "settings-key-two" },
	]);
});

test("direct Exa uses only bounded /search payloads and gives concise 429 guidance", () => {
	const child = runChild(`
		${profileSetup}
		await writeFile(settingsPath, JSON.stringify({ exaApiKey: "direct-key", exaBaseUrl: "https://wrong.invalid" }));
		process.env.EXA_API_KEY = "environment-key";
		process.env.EXA_BASE_URL = "https://wrong-env.invalid";
		const calls = [];
		const fetch = async (url, init) => {
			calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) });
			if (calls.length === 1) {
				return new Response(JSON.stringify({ results: Array.from({ length: 12 }, (_, index) => ({
					title: "Result " + index,
					url: "https://example.com/" + index,
					highlights: ["highlight " + index],
				})) }), { status: 200 });
			}
			return new Response("provider body direct-key", { status: 429 });
		};
		globalThis.fetch = fetch;
		const { searchWithExa } = await import(${JSON.stringify(exaUrl)});
		const { resetRequestOperations } = await import(${JSON.stringify(requestBudgetUrl)});
		resetRequestOperations();
		const result = await searchWithExa("bounded", {
			numResults: 99,
			domainFilter: ["docs.example.com", "-spam.example.net"],
			recencyFilter: "week",
			fetch,
		});
		let rateLimit = "";
		try { await searchWithExa("rate limited", { fetch }); } catch (error) { rateLimit = error.message; }
		const { existsSync } = await import("node:fs");
		console.log(JSON.stringify({
			calls,
			count: result.results.length,
			rateLimit,
			usageFile: existsSync(join(root, "cache", "pi-web-access", "exa-usage.json")),
		}));
	`);
	const { calls, count, rateLimit, usageFile } = parseChild(child);
	assert.equal(count, 10);
	assert.equal(usageFile, false);
	assert.equal(calls[0].url, "https://api.exa.ai/search");
	assert.equal(calls[1].url, "https://api.exa.ai/search");
	assert.equal(calls[0].headers["x-api-key"], "direct-key");
	assert.equal(Object.keys(calls[0].headers).some((key) => key.startsWith("x-exa-")), false);
	assert.equal(calls[0].body.numResults, 10);
	assert.deepEqual(calls[0].body.includeDomains, ["docs.example.com"]);
	assert.deepEqual(calls[0].body.excludeDomains, ["spam.example.net"]);
	assert.match(calls[0].body.startPublishedDate, /^\d{4}-\d{2}-\d{2}T/);
	assert.equal(calls[0].body.contents.text.maxCharacters <= 3000, true);
	assert.equal(calls[0].body.contents.highlights.maxCharacters <= 3000, true);
	assert.match(rateLimit, /Exa API rate limit reached \(429\).*Retry later/);
	assert.equal(rateLimit.includes("direct-key"), false);
});

test("keyless MCP uses real advanced filters, bounded text, and basic compatibility fallback", () => {
	const child = runChild(`
		${profileSetup}
		await writeFile(settingsPath, JSON.stringify({}));
		const calls = [];
		const fetch = async (url, init) => {
			const body = JSON.parse(init.body);
			calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body });
			if (body.params.name === "web_search_advanced_exa") {
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "advanced tool missing" } }), { status: 200 });
			}
			return new Response(JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: "Title: Basic\\nURL: https://example.com/basic\\nText: basic result\\n---" }] },
			}), { status: 200 });
		};
		globalThis.fetch = fetch;
		const { searchWithExa } = await import(${JSON.stringify(exaUrl)});
		const { resetRequestOperations, remainingRequestOperations } = await import(${JSON.stringify(requestBudgetUrl)});
		resetRequestOperations();
		const result = await searchWithExa("raw query", { domainFilter: ["docs.example.com", "-spam.example.net"], recencyFilter: "day", numResults: 20, fetch });
		console.log(JSON.stringify({ calls, result, remaining: remainingRequestOperations() }));
	`);
	const { calls, result, remaining } = parseChild(child);
	assert.deepEqual(calls.map((call) => call.body.params.name), ["web_search_advanced_exa", "web_search_exa"]);
	assert.equal(calls.every((call) => call.url === "https://mcp.exa.ai/mcp"), true);
	assert.equal(calls.some((call) => Object.keys(call.headers).some((key) => key.startsWith("x-exa-"))), false);
	const advanced = calls[0].body.params.arguments;
	assert.equal(advanced.query, "raw query");
	assert.deepEqual(advanced.includeDomains, ["docs.example.com"]);
	assert.deepEqual(advanced.excludeDomains, ["spam.example.net"]);
	assert.match(advanced.startPublishedDate, /^\d{4}-\d{2}-\d{2}T/);
	assert.equal(advanced.enableHighlights, true);
	assert.equal(advanced.textMaxCharacters <= 3000, true);
	assert.equal("contextMaxCharacters" in advanced, false);
	assert.deepEqual(calls[1].body.params.arguments, { query: "raw query", numResults: 10 });
	assert.equal(result.results[0].snippet, "basic result");
	assert.equal(remaining, 4);
});

test("web_search caps four queries, runs at most three concurrently, and preserves order", () => {
	const child = runChild(`
		${profileSetup}
		await writeFile(settingsPath, JSON.stringify({ exaApiKey: "batch-key" }));
		let active = 0;
		let maximumActive = 0;
		const calls = [];
		const fetch = async (_url, init) => {
			const body = JSON.parse(init.body);
			calls.push(body.query);
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			const delay = { one: 45, two: 30, three: 15, four: 0 }[body.query] ?? 0;
			await new Promise((resolve) => setTimeout(resolve, delay));
			active -= 1;
			return new Response(JSON.stringify({ results: [{ title: body.query, url: "https://example.com/" + body.query, highlights: [body.query + " highlight"] }] }), { status: 200 });
		};
		globalThis.fetch = fetch;
		const { default: register } = await import(${JSON.stringify(webToolsUrl)});
		const tools = new Map();
		register({
			registerTool(definition) { tools.set(definition.name, definition); },
			on() {},
			appendEntry() {},
			sendMessage() {},
		}, { fetch });
		const { resetRequestOperations } = await import(${JSON.stringify(requestBudgetUrl)});
		resetRequestOperations();
		const result = await tools.get("web_search").execute("call", { queries: ["one", "two", "three", "four", "five"], numResults: 99 });
		console.log(JSON.stringify({ maximumActive, calls, details: result.details, text: result.content[0].text }));
	`);
	const { maximumActive, calls, details, text } = parseChild(child);
	assert.equal(maximumActive <= 3, true);
	assert.deepEqual(details.queries, ["one", "two", "three", "four"]);
	assert.deepEqual(calls.sort(), ["four", "one", "three", "two"]);
	assert.equal(text.indexOf('## Query: "one"') >= 0, true);
	assert.equal(text.indexOf('## Query: "one"') < text.indexOf('## Query: "two"'), true);
	assert.equal(text.indexOf('## Query: "two"') < text.indexOf('## Query: "three"'), true);
	assert.equal(text.indexOf('## Query: "three"') < text.indexOf('## Query: "four"'), true);
});

test("advanced MCP compatibility fallback does not mask non-compatibility failures", () => {
	const child = runChild(`
		${profileSetup}
		await writeFile(settingsPath, JSON.stringify({}));
		const tools = [];
		const fetch = async (_url, init) => {
			tools.push(JSON.parse(init.body).params.name);
			return new Response("upstream unavailable", { status: 503 });
		};
		globalThis.fetch = fetch;
		const { searchWithExa } = await import(${JSON.stringify(exaUrl)});
		const { resetRequestOperations, remainingRequestOperations } = await import(${JSON.stringify(requestBudgetUrl)});
		resetRequestOperations();
		let message = "";
		try { await searchWithExa("backend failure", { domainFilter: ["example.com"], fetch }); }
		catch (error) { message = error.message; }
		console.log(JSON.stringify({ tools, message, remaining: remainingRequestOperations() }));
	`);
	const { tools, message, remaining } = parseChild(child);
	assert.deepEqual(tools, ["web_search_advanced_exa"]);
	assert.match(message, /Exa MCP error 503/);
	assert.equal(remaining, 5);
});

test("MCP JSON-RPC rate limits use concise guidance without leaking provider text", () => {
	const child = runChild(`
		${profileSetup}
		await writeFile(settingsPath, JSON.stringify({}));
		let call = 0;
		const tools = [];
		const fetch = async (_url, init) => {
			tools.push(JSON.parse(init.body).params.name);
			call += 1;
			const payload = call === 1
				? { jsonrpc: "2.0", id: 1, error: { code: 429, message: "provider rate limit rpc-fixture" } }
				: { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "HTTP 429 rpc-fixture" }] } };
			return new Response(JSON.stringify(payload), { status: 200 });
		};
		globalThis.fetch = fetch;
		const { searchWithExa } = await import(${JSON.stringify(exaUrl)});
		const { resetRequestOperations } = await import(${JSON.stringify(requestBudgetUrl)});
		resetRequestOperations();
		const messages = [];
		for (let index = 0; index < 2; index += 1) {
			try { await searchWithExa("rate query", { domainFilter: ["example.com"], fetch }); }
			catch (error) { messages.push(error.message); }
		}
		console.log(JSON.stringify({ tools, messages }));
	`);
	const { tools, messages } = parseChild(child);
	assert.deepEqual(tools, ["web_search_advanced_exa", "web_search_advanced_exa"]);
	assert.deepEqual(messages, [
		"Exa MCP rate limit reached (429). Retry later or configure exaApiKey.",
		"Exa MCP rate limit reached (429). Retry later or configure exaApiKey.",
	]);
	assert.equal(messages.some((message) => message.includes("rpc-fixture")), false);
});

test("invalid credential sources raise instead of falling through to env or MCP", () => {
	const child = runChild(`
		${profileSetup}
		const calls = [];
		const fetch = async (_url, init) => {
			calls.push(new Headers(init.headers).get("x-api-key"));
			return new Response(JSON.stringify({ results: [] }), { status: 200 });
		};
		globalThis.fetch = fetch;
		const { searchWithExa } = await import(${JSON.stringify(exaUrl)});
		const { resetRequestOperations } = await import(${JSON.stringify(requestBudgetUrl)});
		const outcomes = [];
		async function attempt(settings, environment) {
			await writeFile(settingsPath, JSON.stringify(settings));
			if (environment === undefined) delete process.env.EXA_API_KEY;
			else process.env.EXA_API_KEY = environment;
			resetRequestOperations();
			try {
				await searchWithExa("credential check", { fetch });
				outcomes.push({ ok: true });
			} catch (error) {
				outcomes.push({ ok: false, message: error.message });
			}
		}
		await attempt({ exaApiKey: 123 }, "environment-key");
		await attempt({ exaApiKey: "x".repeat(4097) }, "environment-key");
		await attempt({}, "x".repeat(4097));
		await attempt({ exaApiKey: "" }, "environment-key");
		await attempt({ exaApiKey: "settings-key" }, "x".repeat(4097));
		console.log(JSON.stringify({ outcomes, calls }));
	`);
	const { outcomes, calls } = parseChild(child);
	assert.deepEqual(outcomes.slice(0, 3).map((outcome) => outcome.ok), [false, false, false]);
	assert.match(outcomes[0].message, /Invalid exaApiKey configuration/);
	assert.match(outcomes[1].message, /4096-character limit/);
	assert.match(outcomes[2].message, /Invalid EXA_API_KEY configuration/);
	assert.deepEqual(outcomes.slice(3), [{ ok: true }, { ok: true }]);
	assert.deepEqual(calls, ["environment-key", "settings-key"]);
});

test("provider boundary validates query and domain inputs and bounds result metadata", () => {
	const child = runChild(`
		${profileSetup}
		await writeFile(settingsPath, JSON.stringify({ exaApiKey: "boundary-key" }));
		const calls = [];
		const fetch = async (_url, init) => {
			const body = JSON.parse(init.body);
			calls.push(body);
			return new Response(JSON.stringify({ results: [{
				title: "T".repeat(1000),
				url: "https://example.com/" + "u".repeat(3000),
				highlights: ["h".repeat(5000)],
			}] }), { status: 200 });
		};
		globalThis.fetch = fetch;
		const { searchWithExa } = await import(${JSON.stringify(exaUrl)});
		const { resetRequestOperations } = await import(${JSON.stringify(requestBudgetUrl)});
		const errors = [];
		async function invalid(query, options) {
			resetRequestOperations();
			try { await searchWithExa(query, { ...options, fetch }); }
			catch (error) { errors.push(error.message); }
		}
		await invalid("q".repeat(2049), {});
		await invalid("valid", { domainFilter: Array.from({ length: 17 }, () => "example.com") });
		await invalid("valid", { domainFilter: ["a".repeat(254)] });
		await invalid("valid", { domainFilter: ["not/a-host"] });
		resetRequestOperations();
		const result = await searchWithExa("valid", { domainFilter: ["Docs.Example.COM", "-Spam.Example.COM"], fetch });
		console.log(JSON.stringify({ errors, calls, result }));
	`);
	const { errors, calls, result } = parseChild(child);
	assert.equal(errors.length, 4);
	assert.match(errors[0], /2048-character limit/);
	assert.match(errors[1], /limited to 16 entries/);
	assert.match(errors[2], /Invalid Exa domainFilter hostname/);
	assert.match(errors[3], /Invalid Exa domainFilter hostname/);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].query, "valid");
	assert.deepEqual(calls[0].includeDomains, ["docs.example.com"]);
	assert.deepEqual(calls[0].excludeDomains, ["spam.example.com"]);
	assert.equal(result.results[0].title.length <= 512, true);
	assert.equal(result.results[0].url.length <= 2048, true);
	assert.equal(result.results[0].snippet.length <= 3000, true);
});

test("Exa source has no answer endpoint, base URL override, or local usage accounting", () => {
	const source = readFileSync(new URL("../exa.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /\/answer|exaBaseUrl|EXA_BASE_URL|exa-usage|MONTHLY_LIMIT|WARNING_THRESHOLD|50000|x-exa-/);
});
