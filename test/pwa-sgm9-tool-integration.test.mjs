import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, test } from "node:test";

import { MAX_INLINE_CONTENT_CHARS, MIN_INLINE_CONTENT_CHARS, getMaxInlineContentChars } from "../settings.ts";
import { remainingRequestOperations, resetRequestOperations } from "../request-budget.ts";
import { clearResults, storeResult } from "../storage.ts";
import registerRuntime from "../web-tools.ts";

const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

async function profile(settings = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-sgm9-"));
	await mkdir(join(root, "extensions", "pi-web-access"), { recursive: true });
	await writeFile(join(root, "extensions", "pi-web-access", "settings.json"), JSON.stringify(settings));
	process.env.PI_CODING_AGENT_DIR = root;
	return root;
}

function runtime(fetch) {
	const tools = new Map();
	const events = new Map();
	const entries = [];
	const messages = [];
	registerRuntime({
		registerTool(definition) { tools.set(definition.name, definition); },
		on(event, handler) { events.set(event, handler); },
		appendEntry(type, data) { entries.push({ type, data }); },
		sendMessage(message) { messages.push(message); },
	}, fetch ? { fetch } : undefined);
	return { tools, events, entries, messages };
}

function text(result) {
	return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function installFetch({ searchResults = [], pages = new Map(), failing = false } = {}) {
	const fetch = async (url) => {
		const target = String(url);
		if (target === "https://api.exa.ai/search") {
			return new Response(JSON.stringify({ results: searchResults }), { status: 200 });
		}
		if (failing || target.includes("/failure")) {
			return new Response("provider-parser-diagnostic-secret", { status: 500, statusText: "Upstream failure" });
		}
		return new Response(pages.get(target) ?? "short page", {
			status: 200,
			headers: { "content-type": "text/plain" },
		});
	};
	globalThis.fetch = fetch;
	return fetch;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	clearResults();
	resetRequestOperations();
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

test("settings use a 12000 default, accept 512 through 30000, and reject malformed values", async () => {
	await profile();
	assert.equal(MIN_INLINE_CONTENT_CHARS, 512);
	assert.equal(getMaxInlineContentChars(), 12_000);
	assert.equal(MAX_INLINE_CONTENT_CHARS, 30_000);
	assert.equal(getMaxInlineContentChars({ maxInlineContentChars: 512 }), 512);
	for (const value of [0, 1, 511, -1, 30_001, 12.5, "12000", null, true, undefined]) {
		assert.throws(() => getMaxInlineContentChars({ maxInlineContentChars: value }), /maxInlineContentChars/);
	}
	assert.equal(getMaxInlineContentChars({ maxInlineContentChars: 30_000 }), 30_000);
});

test("runtime registers exactly three bounded schemas with integer limits and one literal findText", () => {
	const { tools } = runtime();
	assert.deepEqual([...tools.keys()], ["web_search", "fetch_content", "get_search_content"]);
	const search = tools.get("web_search").parameters.properties;
	const fetch = tools.get("fetch_content").parameters.properties;
	const get = tools.get("get_search_content").parameters.properties;
	assert.equal(search.queries.maxItems, 4);
	assert.equal(search.numResults.type, "integer");
	assert.equal(search.numResults.minimum, 1);
	assert.equal(search.numResults.maximum, 10);
	assert.equal(fetch.urls.maxItems, 6);
	assert.equal(get.limit.type, "integer");
	assert.equal(get.limit.minimum, 512);
	assert.equal(get.limit.maximum, 30_000);
	assert.equal(get.findText.type, "string");
	assert.equal(get.findText.maxLength, 500);
	assert.equal(get.findText.items, undefined);
	assert.doesNotMatch(JSON.stringify([...tools.values()]), /includeContent|source_check|code_search|aliases/);
});

test("fetch_content defaults to 12000, stays below its configured hard ceiling, and emits IDs only for omitted content", async () => {
	const page = Array.from({ length: 900 }, (_, index) => `line-${index} ${"content ".repeat(20)}`).join("\n");
	const pages = new Map([["https://93.184.216.34/long", page], ["https://93.184.216.34/short", "short content"]]);
	await profile();
	const fetch = installFetch({ pages });
	const { tools } = runtime(fetch);
	resetRequestOperations();
	const long = await tools.get("fetch_content").execute("call", { url: "https://93.184.216.34/long" });
	assert.ok(text(long).length <= 12_000);
	assert.equal(long.details.truncated, true);
	assert.ok(long.details.responseId);
	assert.match(text(long), /get_search_content/);
	assert.match(text(long), /line-\d+/);

	resetRequestOperations();
	const short = await tools.get("fetch_content").execute("call", { url: "https://93.184.216.34/short" });
	assert.equal(text(short), "short content");
	assert.equal(short.details.responseId, undefined);
	assert.equal(short.details.truncated, false);
});

test("fetch_content keeps the retrieval handle when the configured minimum truncates the first page", async () => {
	await profile({ maxInlineContentChars: 512 });
	const fetch = installFetch({ pages: new Map([["https://93.184.216.34/minimum", "minimum-source ".repeat(100)]]) });
	const { tools } = runtime(fetch);
	resetRequestOperations();
	const result = await tools.get("fetch_content").execute("call", { url: "https://93.184.216.34/minimum" });
	assert.equal(result.details.truncated, true);
	assert.ok(result.details.responseId);
	assert.ok(text(result).length <= 512);
	assert.match(text(result), /get_search_content/);
});

test("fetch_content honors a valid 30000 ceiling, caps six URLs, and keeps diagnostics out of model content", async () => {
	const page = "long line ".repeat(5_000);
	const pages = new Map([["https://93.184.216.34/long", page]]);
	await profile({ maxInlineContentChars: 30_000 });
	const fetch = installFetch({ pages });
	const { tools } = runtime(fetch);
	resetRequestOperations();
	const long = await tools.get("fetch_content").execute("call", { url: "https://93.184.216.34/long" });
	assert.ok(text(long).length <= 30_000);
	assert.equal(long.details.truncated, true);

	const urls = Array.from({ length: 7 }, (_, index) => `https://93.184.216.34/page-${index}`);
	resetRequestOperations();
	const batch = await tools.get("fetch_content").execute("call", { urls });
	assert.equal(batch.details.urlCount, 6);
	assert.equal(batch.details.successful, 6);
	assert.ok(batch.details.responseId);

	resetRequestOperations();
	const failed = await tools.get("fetch_content").execute("call", { url: "https://93.184.216.34/failure" });
	assert.equal(text(failed).includes("Upstream failure"), false);
	assert.equal(text(failed).includes("provider-parser-diagnostic-secret"), false);
	assert.match(failed.details.error, /HTTP 500/);
});

test("continuation slices progress with long title prefixes and bounded metadata", async () => {
	await profile({ maxInlineContentChars: 512 });
	const responseId = "long-title";
	const content = Array.from({ length: 180 }, (_, index) => `source-${index} ${"x".repeat(40)}`).join("\n");
	storeResult(responseId, {
		id: responseId,
		type: "fetch",
		timestamp: Date.now(),
		urls: [{
			url: "https://example.com/long-title",
			title: "T".repeat(4096),
			content,
			error: null,
		}],
	});
	const { tools } = runtime();
	let offset = 0;
	for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
		const page = await tools.get("get_search_content").execute("call", {
			responseId,
			urlIndex: 0,
			offset,
			limit: 512,
		});
		assert.ok(text(page).length <= 512);
		assert.ok(page.details.returnedChars > 0, `page ${pageNumber} returned no source characters`);
		const nextOffset = page.details.nextOffset;
		if (nextOffset === null) {
			assert.ok(page.details.returnedChars > 0);
			return;
		}
		assert.ok(nextOffset > offset, `page ${pageNumber} did not advance: ${offset} -> ${nextOffset}`);
		offset = nextOffset;
	}
	assert.fail("continuation did not finish within 100 advancing pages");
});

test("web_search caps four queries, keeps output near 16000, and conditionally exposes retrieval", async () => {
	const results = Array.from({ length: 10 }, (_, index) => ({
		title: `Result ${index}`,
		url: `https://example.com/${index}`,
		highlights: ["stored provider passage"],
	}));
	await profile({ exaApiKey: "test-key" });
	const fetch = installFetch({ searchResults: results });
	const { tools } = runtime(fetch);
	resetRequestOperations();
	const search = await tools.get("web_search").execute("call", {
		queries: ["one", "two", "three", "four", "five"],
		numResults: 10,
	});
	assert.equal(search.details.queries.length, 4);
	assert.ok(text(search).length <= 16_000);
	assert.ok(search.details.responseId, "omitted provider passages need retrieval");
	assert.match(text(search), /get_search_content/);

	const compactFetch = installFetch({ searchResults: [{ title: "No snippet", url: "https://example.com/no-snippet" }] });
	const { tools: compactTools } = runtime(compactFetch);
	resetRequestOperations();
	const compact = await compactTools.get("web_search").execute("call", { query: "focused" });
	assert.equal(compact.details.responseId, undefined);
	assert.doesNotMatch(text(compact), /get_search_content/);
});

test("get_search_content uses bounded line-aware pages and five case-insensitive literal passages", async () => {
	const content = Array.from({ length: 700 }, (_, index) => `context ${index} NEEDLE ${"x".repeat(20)}`).join("\n");
	await profile();
	const fetch = installFetch({ pages: new Map([["https://93.184.216.34/find", content]]) });
	const { tools } = runtime(fetch);
	resetRequestOperations();
	const fetched = await tools.get("fetch_content").execute("call", { url: "https://93.184.216.34/find" });
	const id = fetched.details.responseId;
	assert.ok(id);

	const first = await tools.get("get_search_content").execute("call", { responseId: id, urlIndex: 0 });
	assert.ok(text(first).length <= 12_000);
	assert.equal(first.details.truncated, true);
	assert.ok(first.details.nextOffset > 0);
	assert.match(text(first), /offset:/);

	const found = await tools.get("get_search_content").execute("call", { responseId: id, urlIndex: 0, findText: "needle" });
	assert.ok(text(found).length <= 8_000);
	assert.equal(found.details.matchCount, 700);
	assert.equal(found.details.returnedMatches, 5);
	assert.match(text(found), /NEEDLE/);

	const literal = await tools.get("get_search_content").execute("call", { responseId: id, urlIndex: 0, findText: "NEE.DLE" });
	assert.equal(literal.details.matchCount, 0);
	assert.match(text(literal), /No matching text/);
});

test("agent_start resets the shared six-operation budget once per run and no background turn is sent", async () => {
	await profile({ exaApiKey: "test-key" });
	const fetch = installFetch({ searchResults: [{ title: "one", url: "https://example.com/one" }] });
	const { tools, events, messages } = runtime(fetch);
	resetRequestOperations();
	for (let index = 0; index < 6; index += 1) {
		await (await import("../ssrf-protection.ts")).fetchRemoteUrl(`https://93.184.216.34/budget-${index}`, {}, {
			lookup: async () => [{ address: "93.184.216.34", family: 4 }],
			fetch: async () => new Response("ok"),
		});
	}
	assert.equal(remainingRequestOperations(), 0);
	events.get("agent_start")({ type: "agent_start" });
	assert.equal(remainingRequestOperations(), 6);
	await tools.get("web_search").execute("call", { query: "one" });
	assert.equal(messages.length, 0);
});

test("fetched session records remain compact while full content stays retrievable", async () => {
	const content = "cached content ".repeat(4_000);
	await profile();
	const fetch = installFetch({ pages: new Map([["https://93.184.216.34/cache", content]]) });
	const { tools, entries } = runtime(fetch);
	resetRequestOperations();
	const fetched = await tools.get("fetch_content").execute("call", { url: "https://93.184.216.34/cache" });
	const session = entries.at(-1).data;
	assert.equal(session.urls, undefined);
	assert.ok(JSON.stringify(session).length < 5_000);
	assert.ok(fetched.details.responseId, "truncated content needs a retrieval ID");
});
