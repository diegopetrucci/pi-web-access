/**
 * tool-name-uniqueness.test.mjs
 *
 * Verifies that the registered tool surface of the extension is exactly:
 *   { web_search, fetch_content, get_search_content }
 * and that no tool name is registered more than once.
 *
 * Strategy: grep-based parse of index.ts.
 *
 * index.ts imports runtime packages (@mariozechner/pi-coding-agent,
 * @mariozechner/pi-tui, typebox, @mariozechner/pi-ai) that are not present
 * in the fork's node_modules (they are peer/runtime dependencies provided by
 * the Pi agent host).  Importing the module directly would fail, so we parse
 * the source text instead.
 *
 * The parser is intentionally simple: it scans for `pi.registerTool(` lines
 * and then for the first `name:` field within the following lines.  This
 * matches the coding convention used throughout index.ts and will catch any
 * accidental re-introduction of dropped tools (e.g. google_search,
 * perplexity_search) as well as duplicate registrations.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

const EXPECTED_TOOLS = new Set(["web_search", "fetch_content", "get_search_content"]);

/**
 * Extract registered tool names from index.ts source text.
 *
 * Scans lines sequentially; when it encounters `pi.registerTool(`, it enters
 * "in-block" mode and captures the first `name: "..."` or `name: '...'` line.
 */
function extractRegisteredToolNames(source) {
	const lines = source.split("\n");
	const names = [];
	let inBlock = false;

	for (const line of lines) {
		if (line.includes("pi.registerTool(")) {
			inBlock = true;
		}
		if (inBlock) {
			const match = line.match(/^\s+name:\s*["']([\w_]+)["']/);
			if (match) {
				names.push(match[1]);
				inBlock = false;
			}
		}
	}

	return names;
}

test("index.ts registers exactly { web_search, fetch_content, get_search_content }", () => {
	const source = readFileSync(join(ROOT, "index.ts"), "utf-8");
	const names = extractRegisteredToolNames(source);

	// Assert no duplicates
	const unique = new Set(names);
	assert.strictEqual(
		names.length,
		unique.size,
		`Duplicate tool registrations detected in index.ts: [${names.join(", ")}]`,
	);

	// Assert the exact set of tool names
	assert.deepStrictEqual(
		unique,
		EXPECTED_TOOLS,
		`Registered tools must be exactly ${[...EXPECTED_TOOLS].join(", ")}.\n` +
			`Found: ${[...unique].join(", ")}`,
	);
});

test("index.ts does not reference any dropped tool names", () => {
	const source = readFileSync(join(ROOT, "index.ts"), "utf-8");

	const DROPPED_TOOLS = [
		"google_search",
		"perplexity_search",
		"code_search",
		"web_curator",
		"web_browse",
	];

	for (const dropped of DROPPED_TOOLS) {
		// Look for dropped tool names appearing as string literals in registerTool context
		const pattern = new RegExp(`pi\\.registerTool\\b[\\s\\S]{0,200}?name:\\s*["']${dropped}["']`, "g");
		assert.ok(
			!pattern.test(source),
			`Dropped tool '${dropped}' must not appear in a registerTool call in index.ts`,
		);
	}
});
