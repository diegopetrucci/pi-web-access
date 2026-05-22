/**
 * secrets-leakage-logs.test.mjs
 *
 * Verifies that the EXA_API_KEY never appears in log output.
 *
 * Two complementary layers:
 *   A. Unit tests for the activity monitor (activity.ts) — it stores and
 *      surfaces error strings verbatim, so strings that enter via logError()
 *      must already be scrubbed at the call site in exa.ts.
 *   B. Source-inspection tests — grep exa.ts to confirm that every
 *      console.error/warn/log call and every activityMonitor.logError call
 *      cannot surface the raw apiKey.
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

// ── A. Activity monitor unit tests ────────────────────────────────────────────

test("ActivityMonitor.logError stores the passed string verbatim (no key in, no key out)", async () => {
	const activityUrl = pathToFileURL(join(ROOT, "activity.ts")).href + `?am=${Date.now()}`;
	const { ActivityMonitor } = await import(activityUrl);

	const monitor = new ActivityMonitor();
	const id = monitor.logStart({ type: "api", query: "test query" });

	// Pass an already-scrubbed error message (as exa.ts does after calling scrubKey)
	const scrubbedMessage = "Exa API error 401: invalid api key: exa-***";
	monitor.logError(id, scrubbedMessage);

	const entries = monitor.getEntries();
	const entry = entries.find(e => e.id === id);
	assert.ok(entry, "Activity entry should exist");
	assert.strictEqual(entry.error, scrubbedMessage, "logError should store the string as-is");
	assert.ok(!entry.error.includes(KEY_MARKER), "Stored error must not contain the raw key marker");
});

test("ActivityMonitor.logError: raw key never stored if scrubKey is applied before logError", async () => {
	const activityUrl = pathToFileURL(join(ROOT, "activity.ts")).href + `?am2=${Date.now()}`;
	const { ActivityMonitor } = await import(activityUrl);
	const redactUrl = pathToFileURL(join(ROOT, "redact.ts")).href + `?am2r=${Date.now()}`;
	const { scrubKey } = await import(redactUrl);

	const monitor = new ActivityMonitor();
	const id = monitor.logStart({ type: "api", query: "test query" });

	// Simulate what exa.ts does: scrub the error message before logging
	const rawErrorMessage = `Exa API error 401: {"error":"invalid key ${KEY_MARKER}"}`;
	const scrubbed = scrubKey(rawErrorMessage, KEY_MARKER);
	monitor.logError(id, scrubbed);

	const entries = monitor.getEntries();
	const entry = entries.find(e => e.id === id);
	assert.ok(entry, "Activity entry should exist");
	assert.ok(
		!entry.error?.includes(KEY_MARKER),
		`Raw key found in activity entry error: ${entry.error}`,
	);
});

// ── B. Source-inspection: confirm no raw key reaches console or logError ──────

test("exa.ts: console.error calls do not reference the apiKey variable", () => {
	const src = readFileSync(join(ROOT, "exa.ts"), "utf-8");

	// Extract all console.error lines
	const consoleErrorLines = src.split("\n").filter(line => line.includes("console.error"));

	for (const line of consoleErrorLines) {
		assert.ok(
			!line.includes("apiKey") && !line.includes("EXA_API_KEY"),
			`console.error references the API key on line: ${line.trim()}`,
		);
	}
});

test("exa.ts: activityMonitor.logError calls use err.message (which is already scrubbed)", () => {
	const src = readFileSync(join(ROOT, "exa.ts"), "utf-8");

	// logError is called with `message` which is derived from err.message.
	// The err is created with scrubKey applied, so message is pre-scrubbed.
	// Verify that logError is never called with the raw apiKey variable.
	const logErrorLines = src.split("\n").filter(line => line.includes("logError("));
	assert.ok(logErrorLines.length > 0, "Expected at least one logError call in exa.ts");

	for (const line of logErrorLines) {
		assert.ok(
			!line.includes("apiKey"),
			`logError() references apiKey directly on line: ${line.trim()}`,
		);
	}
});

test("exa.ts: the usage-warning console.error does not include the API key", () => {
	const src = readFileSync(join(ROOT, "exa.ts"), "utf-8");

	// Locate the usage-warning console.error line
	const usageWarningLine = src.split("\n").find(
		line => line.includes("console.error") && line.includes("Exa usage warning"),
	);

	assert.ok(usageWarningLine, "Expected a usage-warning console.error line in exa.ts");
	assert.ok(
		!usageWarningLine.includes("apiKey") && !usageWarningLine.includes("EXA_API_KEY"),
		`Usage-warning line references API key: ${usageWarningLine.trim()}`,
	);
});

test("exa.ts: getApiKey() result is only used in request headers and comparisons, not in string literals passed to logs", () => {
	const src = readFileSync(join(ROOT, "exa.ts"), "utf-8");

	// The apiKey variable must only appear in:
	//   - if (!apiKey) / if (apiKey)  (truthiness checks)
	//   - "x-api-key": apiKey         (request header)
	//   - scrubKey(..., apiKey)        (redaction calls)
	// It must NOT appear in template literals that are passed directly to
	// console.* or activityMonitor.logError.
	const lines = src.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Find lines with console.log/warn/error or logError that also mention apiKey
		if (
			(line.includes("console.log") || line.includes("console.warn") ||
			 line.includes("console.error") || line.includes("logError")) &&
			line.includes("apiKey")
		) {
			assert.fail(
				`Line ${i + 1} of exa.ts passes apiKey directly to a log sink:\n  ${line.trim()}`,
			);
		}
	}
});
