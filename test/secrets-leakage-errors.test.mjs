/**
 * secrets-leakage-errors.test.mjs
 *
 * Verifies that the EXA_API_KEY never appears in thrown error messages.
 *
 * Two complementary layers:
 *   A. Unit tests for redact.ts helpers (redactKey, scrubKey) — these are the
 *      building blocks that prevent key leakage.
 *   B. Source-inspection tests — grep exa.ts to confirm scrubKey is applied at
 *      every error-construction site that could include the response body.
 *
 * This approach avoids importing exa.ts at test time, which would require
 * loading all of its peer TypeScript dependencies (activity.ts, extract.ts,
 * etc.) that are not available as plain .js files in the source tree.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

const KEY_MARKER = "exa-MARKER-do-not-leak-12345";
const REDACTED_FORM = "exa-***";

// ── A. Unit tests for redact helpers ──────────────────────────────────────────

test("redactKey: returns 'exa-***' for exa-prefixed keys", async () => {
	const redactUrl = pathToFileURL(join(ROOT, "redact.ts")).href + `?re=${Date.now()}`;
	const { redactKey } = await import(redactUrl);
	assert.strictEqual(redactKey(KEY_MARKER), REDACTED_FORM);
	assert.strictEqual(redactKey("exa-abc"), REDACTED_FORM);
	assert.strictEqual(redactKey("exa-"), REDACTED_FORM);
});

test("redactKey: returns '***' for non-exa keys", async () => {
	const redactUrl = pathToFileURL(join(ROOT, "redact.ts")).href + `?re2=${Date.now()}`;
	const { redactKey } = await import(redactUrl);
	assert.strictEqual(redactKey("sk-abcdef"), "***");
	assert.strictEqual(redactKey("pplx-abcdef"), "***");
	assert.strictEqual(redactKey("AIzaSomethinglong"), "***");
});

test("redactKey: returns '' for null, undefined, and empty string", async () => {
	const redactUrl = pathToFileURL(join(ROOT, "redact.ts")).href + `?re3=${Date.now()}`;
	const { redactKey } = await import(redactUrl);
	assert.strictEqual(redactKey(null), "");
	assert.strictEqual(redactKey(undefined), "");
	assert.strictEqual(redactKey(""), "");
	assert.strictEqual(redactKey("   "), "");
});

test("scrubKey: removes all occurrences of the key from text", async () => {
	const redactUrl = pathToFileURL(join(ROOT, "redact.ts")).href + `?sc=${Date.now()}`;
	const { scrubKey } = await import(redactUrl);

	const text = `invalid key ${KEY_MARKER} for request, key=${KEY_MARKER} again`;
	const result = scrubKey(text, KEY_MARKER);

	assert.ok(!result.includes(KEY_MARKER), `Raw key still present: ${result}`);
	// Both occurrences replaced with the redacted form
	assert.strictEqual((result.match(/exa-\*\*\*/g) ?? []).length, 2);
});

test("scrubKey: returns text unchanged when key is null or empty", async () => {
	const redactUrl = pathToFileURL(join(ROOT, "redact.ts")).href + `?sc2=${Date.now()}`;
	const { scrubKey } = await import(redactUrl);

	const text = "some text without any key";
	assert.strictEqual(scrubKey(text, null), text);
	assert.strictEqual(scrubKey(text, undefined), text);
	assert.strictEqual(scrubKey(text, ""), text);
});

test("scrubKey: correctly redacts key embedded in a JSON error response (Exa error body pattern)", async () => {
	const redactUrl = pathToFileURL(join(ROOT, "redact.ts")).href + `?sc3=${Date.now()}`;
	const { scrubKey } = await import(redactUrl);

	// Simulate the worst-case scenario: server echoes the key back in a 401 body
	const serverBody = `{"error":"invalid api key: ${KEY_MARKER}", "status": 401}`;
	const sliced = serverBody.slice(0, 300);
	const scrubbed = scrubKey(sliced, KEY_MARKER);

	assert.ok(!scrubbed.includes(KEY_MARKER), `Key still present after scrub: ${scrubbed}`);
	assert.ok(scrubbed.includes(REDACTED_FORM), `Redacted form absent: ${scrubbed}`);
	// Verify the rest of the JSON is preserved
	assert.ok(scrubbed.includes('"status": 401'), "Other JSON fields should be preserved");
});

// ── B. Source-inspection: confirm scrubKey is used at error sites ─────────────

test("exa.ts: scrubKey is imported from redact", () => {
	const src = readFileSync(join(ROOT, "exa.ts"), "utf-8");
	assert.ok(
		src.includes('from "./redact.js"') || src.includes("from './redact.js'"),
		"exa.ts should import from ./redact.js",
	);
	assert.ok(src.includes("scrubKey"), "exa.ts should reference scrubKey");
});

test("exa.ts: scrubKey is applied to both Exa API error response bodies", () => {
	const src = readFileSync(join(ROOT, "exa.ts"), "utf-8");

	// Both answer and search error paths must use scrubKey
	const scrubMatches = (src.match(/scrubKey\(errorText/g) ?? []).length;
	assert.ok(
		scrubMatches >= 2,
		`Expected at least 2 uses of scrubKey(errorText...) in exa.ts, found ${scrubMatches}`,
	);
});

test("exa.ts: raw apiKey is not used directly in template literals that throw", () => {
	const src = readFileSync(join(ROOT, "exa.ts"), "utf-8");

	// The raw apiKey variable must not appear unguarded in throw statements
	// Pattern: throw new Error(`...${apiKey}...`) — direct interpolation of the key
	const directApiKeyInThrow = /throw new Error\([^)]*\$\{apiKey\}[^)]*\)/.test(src);
	assert.ok(
		!directApiKeyInThrow,
		"apiKey must not be directly interpolated into a thrown error message",
	);
});
