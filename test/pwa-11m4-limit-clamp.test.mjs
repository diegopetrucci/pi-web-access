import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, test } from "node:test";

import { clearResults, storeResult } from "../storage.ts";
import registerRuntime from "../web-tools.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

async function profile(settings = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-11m4-"));
	await mkdir(join(root, "extensions", "pi-web-access"), { recursive: true });
	await writeFile(join(root, "extensions", "pi-web-access", "settings.json"), JSON.stringify(settings));
	process.env.PI_CODING_AGENT_DIR = root;
}

function runtime() {
	const tools = new Map();
	registerRuntime({
		registerTool(definition) { tools.set(definition.name, definition); },
		on() {},
		appendEntry() {},
		sendMessage() {},
	});
	return tools.get("get_search_content");
}

function text(result) {
	return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

/** Store one search query and one fetched URL, each long enough to paginate. */
function storeLongResults({ searchId = "stored-search", fetchId = "stored-fetch" } = {}) {
	const source = Array.from({ length: 1_200 }, (_, index) => `line-${index} ${"content ".repeat(20)}`).join("\n");
	storeResult(searchId, {
		id: searchId,
		type: "search",
		timestamp: Date.now(),
		queries: [{ query: "stored query", error: null, results: [{ title: "Long result", url: "https://example.com/long", snippet: source }] }],
	});
	storeResult(fetchId, {
		id: fetchId,
		type: "fetch",
		timestamp: Date.now(),
		urls: [{ url: "https://example.com/long", title: "Long page", content: source, error: null }],
	});
	return [
		{ branch: "search", args: { responseId: searchId, queryIndex: 0 } },
		{ branch: "fetch", args: { responseId: fetchId, urlIndex: 0 } },
	];
}

afterEach(() => {
	clearResults();
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

test("get_search_content clamps an over-max limit to the configured maximum for both branches", async () => {
	await profile();
	const getContent = runtime();
	for (const { branch, args } of storeLongResults()) {
		const result = await getContent.execute("call", { ...args, limit: 20_000 });
		assert.equal(result.details.error, undefined, `${branch} should serve the clamped page`);
		assert.equal(result.details.limit, 12_000, `${branch} reports the effective limit`);
		assert.equal(result.details.requestedLimit, 20_000, `${branch} keeps the original request`);
		assert.ok(text(result).length <= 12_000, `${branch} page stays within the configured maximum`);
		assert.ok(result.details.returnedChars > 0, `${branch} returns source characters`);
		assert.equal(result.details.truncated, true);
		assert.match(text(result), /offset:\d+/, `${branch} keeps the continuation hint`);
		assert.doesNotMatch(text(result), /Invalid content limit/);
	}
});

test("get_search_content clamps relative to a raised configured maximum", async () => {
	await profile({ maxInlineContentChars: 20_000 });
	const getContent = runtime();
	for (const { branch, args } of storeLongResults()) {
		const result = await getContent.execute("call", { ...args, limit: 25_000 });
		assert.equal(result.details.limit, 20_000, `${branch} clamps to the raised setting`);
		assert.equal(result.details.requestedLimit, 25_000);
		assert.ok(text(result).length <= 20_000, `${branch} page respects the raised setting`);
		assert.equal(result.details.truncated, true);
	}
});

test("get_search_content leaves in-range limits unchanged for both branches", async () => {
	await profile();
	const getContent = runtime();
	for (const { branch, args } of storeLongResults()) {
		const result = await getContent.execute("call", { ...args, limit: 2_000 });
		assert.equal(result.details.error, undefined);
		assert.equal(result.details.limit, 2_000, `${branch} uses the requested limit`);
		assert.equal(result.details.requestedLimit, undefined, `${branch} adds no requestedLimit`);
		assert.ok(result.details.returnedChars > 0);
		assert.ok(result.details.returnedChars <= 2_000, `${branch} page carries at most the requested source characters`);
		assert.ok(text(result).length <= 12_000);
	}
});

test("get_search_content rejects below-min and non-integer limits and states the allowed range", async () => {
	await profile();
	const getContent = runtime();
	for (const { branch, args } of storeLongResults()) {
		for (const limit of [511, 1_024.5, "13000"]) {
			const result = await getContent.execute("call", { ...args, limit });
			assert.equal(result.details.error, "Invalid limit", `${branch} rejects ${String(limit)}`);
			assert.match(text(result), /^Error: Invalid content limit \(allowed 512-12000\)\.$/, `${branch} names the allowed range`);
			assert.equal(result.details.minLimit, 512);
			assert.equal(result.details.maxLimit, 12_000);
		}
	}
});

test("get_search_content error text reflects a 512 configured maximum", async () => {
	await profile({ maxInlineContentChars: 512 });
	const getContent = runtime();
	for (const { branch, args } of storeLongResults()) {
		const rejected = await getContent.execute("call", { ...args, limit: 511 });
		assert.match(text(rejected), /allowed 512-512/, `${branch} error matches the configured range`);
		const clamped = await getContent.execute("call", { ...args, limit: 1_024 });
		assert.equal(clamped.details.limit, 512);
		assert.equal(clamped.details.requestedLimit, 1_024);
		assert.ok(text(clamped).length <= 512);
	}
});
