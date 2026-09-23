import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	truncateSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";

import {
	boundExtractedText,
	extractContent,
	fetchAllContent,
} from "../extract.ts";
import { sanitizeInlineDataUris } from "../data-uri-sanitize.ts";
import { extractRSCContent } from "../rsc-extract.ts";
import { resetRequestOperations } from "../request-budget.ts";
import {
	clearResults,
	getFetchCacheDir,
	getResult,
	MAX_CACHE_ENTRY_BYTES,
	getAllResults,
	pruneExpiredFetchCache,
	restoreFromSession,
	storeFetchedContentResult,
	storeResult,
} from "../storage.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalDateNow = Date.now;
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];

function restoreEnvironment() {
	Date.now = originalDateNow;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	clearResults();
}

afterEach(restoreEnvironment);
after(() => {
	Date.now = originalDateNow;
});

async function profile(settings = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-ipvc-"));
	const settingsDir = join(root, "extensions", "pi-web-access");
	mkdirSync(settingsDir, { recursive: true });
	writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(settings));
	process.env.PI_CODING_AGENT_DIR = root;
	return root;
}

function restoreEntry(data) {
	restoreFromSession({
		sessionManager: {
			getBranch: () => [{ type: "custom", customType: "web-search-results", data }],
		},
	});
}

function fetchedData(id, content = "cached content") {
	return {
		id,
		type: "fetch",
		timestamp: Date.now(),
		urls: [{ url: `https://example.com/${id}`, title: id, content, error: null }],
	};
}

const successfulResponse = (body, contentType = "text/plain") =>
	new Response(body, { status: 200, headers: { "content-type": contentType } });

// Direct local extraction ---------------------------------------------------

test("extracts plain text and readable HTML through the guarded transport", async () => {
	await profile();
	resetRequestOperations();
	const fetch = async (url) => {
		if (String(url).endsWith("/text")) return successfulResponse("plain text\nsecond line");
		return successfulResponse(
			`<!doctype html><html><head><title>Readable</title></head><body><article><h1>Readable heading</h1><p>${"Readable article text. ".repeat(40)}</p></article></body></html>`,
			"text/html; charset=utf-8",
		);
	};

	const plain = await extractContent("https://example.com/text", undefined, { lookup, fetch });
	assert.equal(plain.error, null);
	assert.equal(plain.content, "plain text\nsecond line");
	assert.equal(plain.title, "text");

	resetRequestOperations();
	const html = await extractContent("https://example.com/html", undefined, { lookup, fetch });
	assert.equal(html.error, null);
	assert.equal(html.title, "Readable");
	assert.match(html.content, /Readable heading/);
});

test("recovers useful weak RSC content locally", async () => {
	await profile();
	resetRequestOperations();
	const article = "RSC article content survives the loading shell. ".repeat(20);
	const payload = `23:${JSON.stringify(["$", "article", null, { children: ["$", "p", null, { children: article }] }])}\n`;
	const fetch = async () => successfulResponse(
		`<!doctype html><html><head><title>RSC article</title></head><body><article>Loading...</article><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></body></html>`,
		"text/html",
	);

	const result = await extractContent("https://example.com/rsc", undefined, { lookup, fetch });
	assert.equal(result.error, null);
	assert.equal(result.title, "RSC article");
	assert.match(result.content, /RSC article content survives/);
});

test("uses Defuddle only as a local fallback and resolves document.location", async () => {
	await profile();
	resetRequestOperations();
	let fetchCalls = 0;
	const article = "Useful local Defuddle fallback content with enough detail. ".repeat(20);
	const fetch = async () => {
		fetchCalls += 1;
		return successfulResponse(
			`<!doctype html><html><head><title>Defuddle article</title><link rel="canonical" href="/relative-canonical"></head><body><aside><main>${article}</main></aside></body></html>`,
			"text/html",
		);
	};

	const result = await extractContent("https://example.com/defuddle", undefined, { lookup, fetch });
	assert.equal(fetchCalls, 1, "fallback must not make a hidden network request");
	assert.equal(result.error, null);
	assert.equal(result.title, "Defuddle article");
	assert.match(result.content, /Useful local Defuddle fallback content/);
});

test("preserves weak Readability output when Defuddle reports an internal failure", async () => {
	await profile();
	resetRequestOperations();
	const article = "Weak readable output survives a failed local fallback. ".repeat(5);
	const fetch = async () => successfulResponse(
		`<!doctype html><html><head><title>Weak article</title></head><body><article><p>${article}</p></article><script type="application/ld+json">{bad</script></body></html>`,
		"text/html",
	);

	const result = await extractContent("https://example.com/weak", undefined, { lookup, fetch });
	assert.match(result.content, /Weak readable output survives/);
	assert.equal(result.error, "Extracted content appears incomplete");
	assert.doesNotMatch(JSON.stringify(result), /Defuddle|SyntaxError|position 1/);
});

test("removes data URI payloads before direct and batched results are returned", async () => {
	await profile();
	resetRequestOperations();
	const fetch = async () => successfulResponse(
		"Before ![diagram](data:image/png;base64,SGVsbG8=) after.",
	);

	const direct = await extractContent("https://example.com/data", undefined, { lookup, fetch });
	assert.equal(direct.error, null);
	assert.equal(direct.content, "Before ![diagram]([inline data omitted]) after.");
	assert.doesNotMatch(direct.content, /data:image|SGVsbG8=/i);

	resetRequestOperations();
	const batched = await fetchAllContent(["https://example.com/data"], undefined, { lookup, fetch });
	assert.doesNotMatch(batched[0].content, /SGVsbG8=/);
});

test("sanitizes quoted, parenthesized, bare, uppercase, malformed, and repeated data URIs", () => {
	const source = [
		`src="data:image/png;base64,QUOTED_SECRET"`,
		"src='data:text/plain,QUOTED_SECRET'",
		"![image](data:image/png;base64,MARKDOWN_SECRET)",
		"background: url(data:image/png;base64,CSS_SECRET)",
		"data:text/plain,BARE_SECRET",
		"DATA:IMAGE/PNG;BASE64,UPPER_SECRET",
		"data:image/png;base64,MALFORMED_SECRET",
		"data:text/plain,FIRST_SECRET data:text/plain,SECOND_SECRET",
	].join(" ");
	const sanitized = sanitizeInlineDataUris(source);
	assert.equal(sanitized.omissions.length, 9);
	assert.equal((sanitized.text.match(/\[inline data omitted\]/g) || []).length, 9);
	assert.doesNotMatch(sanitized.text, /data:|SECRET/i);
	assert.doesNotMatch(sanitized.text, /sha|hash|bytes|source=/i);
});

test("returns concise origin guidance for 404 and 410 without fallback calls", async () => {
	await profile();
	let calls = 0;
	const fetch = async (_url) => {
		calls += 1;
		return new Response("gone", { status: calls === 1 ? 404 : 410, statusText: calls === 1 ? "Not Found" : "Gone" });
	};

	resetRequestOperations();
	const missing = await extractContent("https://example.com/missing", undefined, { lookup, fetch, toolNames: { webSearch: "web_search", fetchContent: "fetch_content" } });
	assert.equal(missing.status, 404);
	assert.match(missing.error, /HTTP 404/);
	assert.match(missing.error, /origin says this page does not exist/);
	assert.match(missing.error, /web_search/);

	resetRequestOperations();
	const gone = await extractContent("https://example.com/gone", undefined, { lookup, fetch });
	assert.equal(gone.status, 410);
	assert.match(gone.error, /HTTP 410/);
	assert.equal(calls, 2, "404/410 must not invoke an extraction service");
});

test("enforces an extraction deadline independently of a stalled guarded request", async () => {
	await profile({ fetch: { timeout: 30 } });
	const fetch = async (_url, init) => new Promise((_, reject) => {
		init.signal.addEventListener("abort", () => reject(new Error("stalled transport")), { once: true });
	});
	resetRequestOperations();
	const started = Date.now();
	const result = await extractContent("https://example.com/slow", undefined, { lookup, fetch, timeoutMs: 10 });
	assert.equal(result.error, "The operation was aborted.");
	assert.ok(Date.now() - started < 1000);
});

test("bounds extracted output at a line boundary and falls back to a character slice", () => {
	const value = Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n");
	const bounded = boundExtractedText(value, 40);
	assert.ok(bounded.length <= 40);
	assert.match(bounded, /(?:Content truncated|\[truncated\])/);
	assert.equal(bounded.slice(0, bounded.indexOf("[truncated]")), "line-0\nline-1\nline-2\nline-3");

	const singleLine = boundExtractedText("single-line content ".repeat(20), 40);
	assert.equal(singleLine.length, 40);
	assert.equal(singleLine.slice(-11), "[truncated]");
	assert.match(singleLine.slice(0, -11), /^single-line content/);
});

test("keeps RSC references cycle-safe and removes duplicate readable blocks", () => {
	const repeated = "Referenced RSC content is readable and intentionally repeated. ".repeat(4);
	const paragraph = ["$", "p", null, { children: repeated }];
	const main = ["$", "article", null, { children: ["$L1", paragraph, paragraph] }];
	const payload = [
		`23:${JSON.stringify(main)}`,
		`1:${JSON.stringify(["$", "p", null, { children: [repeated, "$L2"] }])}`,
		`2:${JSON.stringify(["$", "p", null, { children: "$L1" }])}`,
	].join("\n");
	const result = extractRSCContent(`<html><head><title>RSC refs</title></head><body><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></body></html>`);
	assert.equal(result.title, "RSC refs");
	assert.equal(result.content, repeated.trim());
	assert.ok(result.content.length < 1000000);
});

test("bounds adversarial RSC amplification with shared output, work, and depth budgets", () => {
	const large = "large referenced payload. ".repeat(12_000);
	const repeatedRefs = Array.from({ length: 80_000 }, () => "$L1");
	const repeatedPayload = [
		`23:${JSON.stringify(["$", "article", null, { children: repeatedRefs }])}`,
		`1:${JSON.stringify(["$", "p", null, { children: large }])}`,
	].join("\n");
	const repeatedResult = extractRSCContent(`<script>self.__next_f.push([1,${JSON.stringify(repeatedPayload)}])</script>`);
	assert.ok(repeatedResult);
	assert.ok(repeatedResult.content.length <= 1_000_000);

	const numerousChildren = Array.from({ length: 99_998 }, () => "n");
	numerousChildren.push("tail-marker");
	const numerousPayload = `23:${JSON.stringify(["$", "article", null, { children: numerousChildren }])}`;
	const numerousResult = extractRSCContent(`<script>self.__next_f.push([1,${JSON.stringify(numerousPayload)}])</script>`);
	assert.ok(numerousResult);
	assert.ok(numerousResult.content.length <= 1_000_000);
	assert.doesNotMatch(numerousResult.content, /tail-marker/);

	let deep = "deep tail";
	for (let index = 0; index < 2_000; index++) {
		deep = ["$", "div", null, { children: deep }];
	}
	const deepPayload = `23:${JSON.stringify(deep)}`;
	assert.equal(extractRSCContent(`<script>self.__next_f.push([1,${JSON.stringify(deepPayload)}])</script>`), null);
});

test("parser dependencies remain unloaded until extraction and Defuddle remains fallback-only", () => {
	const extractUrl = new URL("../extract.ts", import.meta.url).href;
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		encoding: "utf8",
		input: `
			import assert from "node:assert/strict";
			import { registerHooks } from "node:module";
			const loaded = [];
			registerHooks({
				resolve(specifier, context, nextResolve) {
					if (["linkedom", "@mozilla/readability", "turndown", "defuddle/node"].includes(specifier)) {
						loaded.push(specifier);
					}
					return nextResolve(specifier, context);
				},
			});
			process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(process.cwd())};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			assert.deepEqual(loaded, []);
			const plainFetch = async (_url) => new Response("plain", { headers: { "content-type": "text/plain" } });
			await extractContent("https://example.com/plain", undefined, { fetch: plainFetch, lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
			assert.deepEqual(loaded, []);
			const htmlFetch = async (_url) => new Response(
				'<html><head><title>Lazy HTML</title></head><body><article><p>' + 'readable text '.repeat(60) + '</p></article></body></html>',
				{ headers: { "content-type": "text/html" } },
			);
			await extractContent("https://example.com/html", undefined, { fetch: htmlFetch, lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
			assert.equal(loaded.includes("linkedom"), true);
			assert.equal(loaded.includes("@mozilla/readability"), true);
			assert.equal(loaded.includes("turndown"), true);
			assert.equal(loaded.includes("defuddle/node"), false);
			console.log(JSON.stringify(loaded));
		`,
	});
	assert.equal(child.status, 0, child.stderr);
	const loaded = JSON.parse(child.stdout.trim());
	assert.equal(loaded.includes("linkedom"), true);
	assert.equal(loaded.includes("@mozilla/readability"), true);
	assert.equal(loaded.includes("turndown"), true);
	assert.equal(loaded.includes("defuddle/node"), false);
});

// External cache/session pipeline ------------------------------------------

test("stores full fetch content externally and publishes a compact session ref", async () => {
	const root = await profile();
	const content = "cached page content. ".repeat(4_000);
	const session = storeFetchedContentResult("compact", fetchedData("compact", content));
	assert.equal(session.urls, undefined);
	assert.ok(session.fetchCache?.key);
	assert.ok(JSON.stringify(session).length < 5_000);
	assert.doesNotMatch(JSON.stringify(session), /cached page content/);
	assert.equal(getFetchCacheDir(), join(root, "cache", "pi-web-access"));
	assert.equal(statSync(getFetchCacheDir()).mode & 0o777, 0o700);
	assert.equal(statSync(join(getFetchCacheDir(), session.fetchCache.key)).mode & 0o777, 0o600);
	assert.equal(readFileSync(join(getFetchCacheDir(), session.fetchCache.key), "utf8").includes(content), true);

	clearResults();
	restoreEntry(session);
	assert.equal(getResult("compact").urls[0].content, content);
});

test("hydrates cache files through a known-field projection", async () => {
	await profile();
	const original = fetchedData("projection", "stored content");
	const session = storeFetchedContentResult("projection", original);
	const cachePath = join(getFetchCacheDir(), session.fetchCache.key);
	writeFileSync(cachePath, JSON.stringify({
		id: original.id,
		type: "fetch",
		timestamp: original.timestamp,
		unknownRoot: { payload: "x".repeat(2_000_000) },
		fetchCache: { version: 1, key: "attacker.json", storedAt: 0 },
		urlMetadata: [{ url: "https://attacker.invalid", title: "attacker", error: null, contentLength: 0 }],
		urls: [{
			url: "https://example.com/projected",
			title: "Projected",
			content: "projected content",
			error: null,
			mimeType: "text/plain",
			status: 200,
			unknownNested: { payload: "x".repeat(2_000_000) },
		}],
	}));

	clearResults();
	restoreEntry(session);
	assert.deepEqual(getResult("projection"), {
		id: "projection",
		type: "fetch",
		timestamp: original.timestamp,
		urls: [{
			url: "https://example.com/projected",
			title: "Projected",
			content: "projected content",
			error: null,
			mimeType: "text/plain",
			status: 200,
		}],
		fetchCache: session.fetchCache,
		urlMetadata: session.urlMetadata,
	});
});

test("rejects cache files over the entry limit before parsing", async () => {
	await profile();
	const session = storeFetchedContentResult("oversized-cache", fetchedData("oversized-cache"));
	const cachePath = join(getFetchCacheDir(), session.fetchCache.key);
	truncateSync(cachePath, MAX_CACHE_ENTRY_BYTES + 1);

	clearResults();
	storeResult("oversized-cache", session);
	const loaded = getResult("oversized-cache");
	assert.equal(loaded.urls[0].content, "");
	assert.equal(loaded.urls[0].error, "Cached fetched content is invalid");
});

test("rejects writes above the serialized cache-entry limit", async () => {
	await profile();
	const session = storeFetchedContentResult(
		"oversized-write",
		fetchedData("oversized-write", "x".repeat(MAX_CACHE_ENTRY_BYTES)),
	);
	assert.equal(session.fetchCache, undefined);
	assert.equal(session.fetchCacheError, "Failed to write fetched content cache");
	assert.equal(existsSync(getFetchCacheDir()), false);
});

test("hydrates external entries beyond the legacy inline bound", async () => {
	await profile();
	const content = "x".repeat(5 * 1024 * 1024 + 1);
	const session = storeFetchedContentResult("external-boundary", fetchedData("external-boundary", content));
	assert.ok(session.fetchCache);

	clearResults();
	restoreEntry(session);
	assert.equal(getResult("external-boundary").urls[0].content, content);
});

test("restores bounded legacy inline records without persisting them", async () => {
	const root = await profile();
	const legacy = fetchedData("legacy", "legacy inline content");
	restoreEntry(legacy);
	assert.equal(getResult("legacy").urls[0].content, "legacy inline content");
	assert.equal(existsSync(join(root, "cache")), false);

	const oversized = fetchedData("oversized", "x".repeat(5 * 1024 * 1024 + 1));
	restoreEntry(oversized);
	assert.equal(getResult("oversized"), null);
});

test("rejects hostile search session shapes and retains only bounded known fields", async () => {
	await profile();
	const timestamp = Date.now();
	const result = { title: "title", url: "https://example.com", snippet: "snippet" };
	const query = { query: "bounded", results: [result], error: null };
	const hostileCases = [
		{
			id: "huge-title",
			type: "search",
			timestamp,
			queries: [{ ...query, results: [{ ...result, title: "x".repeat(2_000_000) }] }],
		},
		{
			id: "non-array-results",
			type: "search",
			timestamp,
			queries: [{ ...query, results: { 0: result } }],
		},
		{
			id: "too-many-queries",
			type: "search",
			timestamp,
			queries: Array.from({ length: 5 }, () => query),
		},
		{
			id: "too-many-results",
			type: "search",
			timestamp,
			queries: [{ ...query, results: Array.from({ length: 11 }, () => result) }],
		},
		{
			id: "malformed-fields",
			type: "search",
			timestamp,
			queries: [{ query: 42, results: [result], error: null }],
		},
		{
			id: "malformed-error",
			type: "search",
			timestamp,
			queries: [{ ...query, error: { message: "not a string" } }],
		},
	];
	for (const data of hostileCases) {
		restoreEntry(data);
		assert.equal(getResult(data.id), null, data.id);
	}

	const bounded = {
		id: "bounded-search",
		type: "search",
		timestamp,
		unknownRoot: "x".repeat(2_000_000),
		queries: [{
			query: "q".repeat(2048),
			results: [{
				title: "t".repeat(512),
				url: "u".repeat(2048),
				snippet: "s".repeat(3000),
				unknownResult: "x".repeat(2_000_000),
			}],
			error: "e".repeat(8192),
			unknownQuery: { payload: "x".repeat(2_000_000) },
		}],
	};
	restoreEntry(bounded);
	const restored = getResult("bounded-search");
	assert.ok(restored);
	assert.deepEqual(restored, {
		id: "bounded-search",
		type: "search",
		timestamp,
		queries: [{
			query: "q".repeat(2048),
			results: [{ title: "t".repeat(512), url: "u".repeat(2048), snippet: "s".repeat(3000) }],
			error: "e".repeat(8192),
		}],
	});
	assert.ok(JSON.stringify(restored).length < 20_000);
});

test("normalizes compact and legacy fetch records before retaining them", async () => {
	await profile();
	const timestamp = Date.now();
	const compact = {
		id: "normalized-compact",
		type: "fetch",
		timestamp,
		unknownRoot: "x".repeat(2_000_000),
		fetchCache: { version: 1, key: "normalized-compact.json", storedAt: timestamp, unknown: "drop" },
		urlMetadata: [{
			url: "https://example.com",
			title: "Example",
			error: null,
			contentLength: 0,
			unknown: "x".repeat(2_000_000),
		}],
	};
	restoreEntry(compact);
	assert.deepEqual(getAllResults(), [{
		id: compact.id,
		type: compact.type,
		timestamp,
		fetchCache: { version: 1, key: "normalized-compact.json", storedAt: timestamp },
		urlMetadata: [{ url: "https://example.com", title: "Example", error: null, contentLength: 0 }],
	}]);

	const legacy = fetchedData("normalized-legacy", "legacy content");
	legacy.unknownRoot = "x".repeat(2_000_000);
	legacy.urls[0].unknown = "x".repeat(2_000_000);
	restoreEntry(legacy);
	assert.deepEqual(getResult("normalized-legacy"), {
		id: "normalized-legacy",
		type: "fetch",
		timestamp: legacy.timestamp,
		urls: [{ url: legacy.urls[0].url, title: "normalized-legacy", content: "legacy content", error: null }],
	});
});

test("bounds aggregate session restore across legacy, search, and compact records", async () => {
	await profile();
	const timestamp = Date.now();
	const searchRecords = Array.from({ length: 140 }, (_, index) => ({
		id: index === 0 || index === 138 || index === 139 ? "duplicate-search" : `search-${index}`,
		type: "search",
		timestamp,
		queries: [{
			query: index === 139 ? "newest duplicate" : `query-${index}`,
			results: [{ title: `title-${index}`, url: `https://example.com/${index}`, snippet: `snippet-${index}` }],
			error: null,
		}],
	}));
	const compactRecords = Array.from({ length: 20 }, (_, index) => ({
		id: `compact-${index}`,
		type: "fetch",
		timestamp,
		fetchCache: { version: 1, key: `compact-${index}.json`, storedAt: timestamp },
		urlMetadata: [{ url: `https://example.com/compact-${index}`, title: `compact-${index}`, error: null, contentLength: 5 * 1024 * 1024 }],
	}));
	const legacyContent = "x".repeat(5 * 1024 * 1024);
	const legacyRecords = Array.from({ length: 8 }, (_, index) => fetchedData(`legacy-${index}`, legacyContent));
	const oldNoise = Array.from({ length: 1_000 }, () => ({ type: "message", data: { oversized: "ignored" } }));
	const entries = [...oldNoise, ...searchRecords, ...compactRecords, ...legacyRecords].map((data) => ({
		type: "custom",
		customType: "web-search-results",
		data,
	}));
	let indexedReads = 0;
	const branch = new Proxy(entries, {
		get(target, property, receiver) {
			if (typeof property === "string" && /^\d+$/.test(property)) indexedReads++;
			return Reflect.get(target, property, receiver);
		},
	});

	restoreFromSession({ sessionManager: { getBranch: () => branch } });
	const restored = getAllResults();
	assert.equal(restored.length, 128);
	assert.ok(indexedReads <= 128 * 4, `restore read ${indexedReads} branch entries`);
	assert.ok(indexedReads < entries.length, "restore must not traverse the whole oversized branch");
	assert.equal(restored.find((entry) => entry.id === "duplicate-search").queries[0].query, "newest duplicate");
	assert.deepEqual(restored.filter((entry) => entry.type === "fetch" && entry.fetchCache).map((entry) => entry.id), Array.from({ length: 20 }, (_, index) => `compact-${index}`));
	assert.deepEqual(restored.filter((entry) => entry.type === "fetch" && entry.urls).map((entry) => entry.id), ["legacy-5", "legacy-6", "legacy-7"]);
	assert.equal(restored.filter((entry) => entry.type === "search").length, 105);
	assert.equal(restored[0].id, "search-34");
	assert.ok(restored.at(-1).id === "legacy-7");

	const normalizedBytes = restored.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry), "utf8"), 0);
	assert.ok(normalizedBytes <= 16 * 1024 * 1024, `normalized restore is ${normalizedBytes} bytes`);
	assert.ok(restored.length <= 128);
});

test("uses exclusive atomic temp writes and leaves no temp artifacts", async () => {
	await profile();
	const session = storeFetchedContentResult("atomic", fetchedData("atomic", "atomic content"));
	const files = readdirSync(getFetchCacheDir());
	assert.deepEqual(files, [session.fetchCache.key]);
	assert.equal(JSON.parse(readFileSync(join(getFetchCacheDir(), session.fetchCache.key), "utf8")).urls[0].content, "atomic content");
});

test("cleans up temporary files when an atomic rename cannot replace the target", async () => {
	await profile();
	mkdirSync(getFetchCacheDir(), { recursive: true });
	mkdirSync(join(getFetchCacheDir(), "blocked.json"));
	const session = storeFetchedContentResult("blocked", fetchedData("blocked", "blocked content"));
	assert.equal(session.fetchCache, undefined);
	assert.match(session.fetchCacheError, /Failed to write fetched content cache/);
	assert.equal(readdirSync(getFetchCacheDir()).some((name) => name.endsWith(".tmp")), false);
});

test("sanitizes cache read and write failures before they reach stored results", async () => {
	const root = await profile();
	const failedWrite = storeFetchedContentResult("bad id", fetchedData("bad id", "content"));
	assert.equal(failedWrite.fetchCacheError, "Failed to write fetched content cache");
	assert.doesNotMatch(JSON.stringify(failedWrite), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

	const session = storeFetchedContentResult("corrupt", fetchedData("corrupt", "content"));
	writeFileSync(join(getFetchCacheDir(), session.fetchCache.key), "not json");
	clearResults();
	restoreEntry(session);
	const loaded = getResult("corrupt");
	assert.equal(loaded.urls[0].error, "Cached fetched content is unavailable");
	assert.doesNotMatch(JSON.stringify(loaded), /SyntaxError|ENOENT|not json/);
});

test("validates malformed cache references and refuses cache traversal", async () => {
	await profile();
	restoreEntry({
		id: "bad-ref",
		type: "fetch",
		timestamp: Date.now(),
		fetchCache: { version: 1, key: "../outside.json", storedAt: Date.now() },
		urlMetadata: [{ url: "https://example.com", title: "bad", error: null, contentLength: 0 }],
	});
	assert.equal(getResult("bad-ref"), null);
});

test("prunes expired files and in-memory fetch payloads at the one-hour boundary", async () => {
	const started = originalDateNow();
	Date.now = () => started;
	await profile();
	const session = storeFetchedContentResult("expired", fetchedData("expired", "expired content"));
	const cachePath = join(getFetchCacheDir(), session.fetchCache.key);
	utimesSync(cachePath, new Date(started), new Date(started));

	Date.now = () => started + 60 * 60 * 1000 - 1;
	pruneExpiredFetchCache();
	assert.equal(getResult("expired").urls[0].content, "expired content");

	Date.now = () => started + 60 * 60 * 1000;
	pruneExpiredFetchCache();
	assert.equal(readdirSync(getFetchCacheDir()).includes(session.fetchCache.key), false);
	const expired = getAllResults().find((entry) => entry.id === "expired");
	assert.equal(expired.urls[0].content, "");
	assert.equal(expired.urls[0].error, "Cached fetched content is missing or expired");
});

test("prunes oldest entries by count and aggregate bytes", async () => {
	await profile();
	const dir = getFetchCacheDir();
	mkdirSync(dir, { recursive: true });
	const now = originalDateNow();
	for (const [name, size, age] of [["old.json", 4, 30], ["middle.json", 6, 20], ["new.json", 8, 10]]) {
		const path = join(dir, name);
		writeFileSync(path, "x".repeat(size));
		utimesSync(path, new Date(now - age * 1000), new Date(now - age * 1000));
	}
	pruneExpiredFetchCache(now, { maxEntries: 2, maxBytes: 1024 });
	assert.deepEqual(readdirSync(dir).sort(), ["middle.json", "new.json"]);
	pruneExpiredFetchCache(now, { maxEntries: 10, maxBytes: 8 });
	assert.deepEqual(readdirSync(dir), ["new.json"]);

	for (const [name, age] of [["older.json", 20], ["newer.json", 10]]) {
		const path = join(dir, name);
		writeFileSync(path, "");
		truncateSync(path, 65 * 1024 * 1024);
		utimesSync(path, new Date(now - age * 1000), new Date(now - age * 1000));
	}
	pruneExpiredFetchCache(now);
	assert.equal(readdirSync(dir).includes("older.json"), false);
	assert.equal(readdirSync(dir).includes("newer.json"), true);
});

test("corrects cache permissions while pruning and rejects cache symlinks", { skip: process.platform === "win32" }, async () => {
	const root = await profile();
	const dir = getFetchCacheDir();
	mkdirSync(dir, { recursive: true });
	const entry = join(dir, "permissions.json");
	writeFileSync(entry, "{}");
	chmodSync(dir, 0o777);
	chmodSync(entry, 0o666);
	pruneExpiredFetchCache();
	assert.equal(statSync(dir).mode & 0o777, 0o700);
	assert.equal(statSync(entry).mode & 0o777, 0o600);

	const outside = join(root, "outside.json");
	writeFileSync(outside, JSON.stringify(fetchedData("outside")));
	unlinkSync(entry);
	symlinkSync(outside, entry);
	restoreEntry({
		id: "linked",
		type: "fetch",
		timestamp: Date.now(),
		fetchCache: { version: 1, key: "permissions.json", storedAt: Date.now() },
		urlMetadata: [{ url: "https://example.com/linked", title: "linked", error: null, contentLength: 10 }],
	});
	assert.equal(getResult("linked").urls[0].error, "Cached fetched content is unavailable");
	assert.match(readFileSync(outside, "utf8"), /outside/);

	const outsideDir = join(root, "outside-cache");
	unlinkSync(entry);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(outsideDir);
	symlinkSync(outsideDir, dir);
	const rejected = storeFetchedContentResult("dir-link", fetchedData("dir-link"));
	assert.equal(rejected.fetchCache, undefined);
	assert.equal(rejected.fetchCacheError, "Failed to write fetched content cache");
	assert.deepEqual(readdirSync(outsideDir), []);
});
