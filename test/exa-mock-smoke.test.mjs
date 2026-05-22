/**
 * exa-mock-smoke.test.mjs
 *
 * Mocked integration smoke test for the web_search → fetch_content →
 * get_search_content pipeline.
 *
 * Strategy:
 *   - Register a resolve hook so that relative `.js` imports inside project
 *     TypeScript files are remapped to `.ts` (necessary because Node 26's
 *     native type-stripping does not map `.js` specifiers to `.ts` files).
 *   - Use the REAL createRequestGuard() so scheme allowlist, host-deny, and
 *     size-cap enforcement run end-to-end.
 *   - Inject canned responses by replacing globalThis.fetch for the duration of
 *     each test, then restoring it.  The real guard's validate() runs (DNS check
 *     for hostnames; literal-IP check for banned addresses), but the actual
 *     HTTP transport is bypassed by the stub.
 *
 * Tests include:
 *   - Happy path: search → fetch → get_search_content with inline truncation.
 *   - Scheme rejection: file:// URL → recoverable error from fetchAllContent.
 *   - Host-deny: 169.254.169.254 literal IP → recoverable error.
 *   - Size-cap: Content-Length > configured cap → recoverable error.
 *   - Budget exhaustion: shared guard runs out → RequestBudgetExceeded thrown.
 *
 * Real-network counterpart:
 *   Set PI_WEB_ACCESS_LIVE=1 and a valid EXA_API_KEY to run live tests.
 *   See test/exa-live-smoke.test.mjs for the live counterpart (skipped in CI).
 */

import { registerHooks } from "node:module";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

// ── Module resolution hook ─────────────────────────────────────────────────────
// exa.ts and extract.ts use `import from './foo.js'` conventions (TypeScript
// ESM style) but the project ships only .ts sources.  Map project-internal
// .js specifiers → .ts so dynamic imports below can load these modules.
// Must be called before any dynamic import that transitively needs this mapping.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (
			specifier.endsWith(".js") &&
			context.parentURL?.includes("/pi-web-access/")
		) {
			try {
				return nextResolve(specifier.slice(0, -3) + ".ts", context);
			} catch {
				// Fall through to default resolution if .ts also doesn't exist
			}
		}
		return nextResolve(specifier, context);
	},
});

/** Matches MAX_INLINE_CONTENT in index.ts */
const MAX_INLINE_CONTENT = 30000;

// ── Environment isolation ──────────────────────────────────────────────────────
// Set PI_CODING_AGENT_DIR and EXA_API_KEY BEFORE any imports that read them.
// exa.ts lazily calls resolveProfilePaths() / loadConfig() at first invocation
// (not at import time), so setting env here is sufficient.

const tempDir = join(
	tmpdir(),
	`exa-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(tempDir, { recursive: true });

const origAgentDir = process.env["PI_CODING_AGENT_DIR"];
const origApiKey = process.env["EXA_API_KEY"];
process.env["PI_CODING_AGENT_DIR"] = tempDir;
process.env["EXA_API_KEY"] = "exa-test-fake-key-smoke-do-not-leak";

// ── Module imports ─────────────────────────────────────────────────────────────

const { searchWithExa } = await import(
	pathToFileURL(join(ROOT, "exa.ts")).href
);
const { fetchAllContent } = await import(
	pathToFileURL(join(ROOT, "extract.ts")).href
);
const { storeResult, getResult, clearResults, generateId } = await import(
	pathToFileURL(join(ROOT, "storage.ts")).href
);
// Import without cache-bust so RequestBudgetExceeded is the same class instance
// used internally by extract.ts (required for instanceof checks to work).
const { createRequestGuard, RequestBudgetExceeded } = await import(
	pathToFileURL(join(ROOT, "request-guard.ts")).href
);

// ── Cleanup ────────────────────────────────────────────────────────────────────

after(() => {
	// Ensure fetch is restored even if a test failed mid-stub
	globalThis.fetch = origFetch;

	if (origAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
	else process.env["PI_CODING_AGENT_DIR"] = origAgentDir;
	if (origApiKey === undefined) delete process.env["EXA_API_KEY"];
	else process.env["EXA_API_KEY"] = origApiKey;
	try {
		rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Non-fatal
	}
});

// ── globalThis.fetch stub infrastructure ──────────────────────────────────────
// Save the real fetch; individual tests install a per-test handler and always
// restore it so tests remain isolated from one another.

const origFetch = globalThis.fetch;

/**
 * Replace globalThis.fetch with a stub that dispatches to `handler`.
 * Returns a teardown function that restores the original.
 *
 * @param {(url: string) => Response | Promise<Response>} handler
 * @returns {() => void}
 */
function stubFetch(handler) {
	globalThis.fetch = async function stubbedFetch(input, _init) {
		const url = typeof input === "string" ? input : input.url;
		return handler(url);
	};
	return () => {
		globalThis.fetch = origFetch;
	};
}

// ── Response builders ──────────────────────────────────────────────────────────

function makeJsonResponse(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function makeHtmlResponse(html, status = 200) {
	return new Response(html, {
		status,
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

// ── Canned data ────────────────────────────────────────────────────────────────

const CANNED_EXA_ANSWER = {
	answer: "This is a synthesized answer from Exa about the test topic.",
	citations: [
		{ url: "https://example.com/page-a", title: "Page A: First Result" },
		{ url: "https://example.com/page-b", title: "Page B: Second Result" },
	],
};

// HTML with enough content to pass Readability's minimum useful content threshold
const CANNED_HTML_A = `<!DOCTYPE html><html lang="en">
<head><title>Page A: First Result</title></head>
<body>
<article>
  <h1>Page A: First Result</h1>
  <p>This is the main content of page A. It contains enough text to pass the
  minimum useful content threshold enforced by the extractor. The quick brown
  fox jumps over the lazy dog. Lorem ipsum dolor sit amet, consectetur
  adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna
  aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris
  nisi ut aliquip ex ea commodo consequat.</p>
  <p>Second paragraph with more substance. Duis aute irure dolor in
  reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.
  Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia
  deserunt mollit anim id est laborum. Additional unique content appears here
  to ensure the extractor judges the page as useful rather than JS-rendered.</p>
</article>
</body></html>`;

const CANNED_HTML_B = `<!DOCTYPE html><html lang="en">
<head><title>Page B: Second Result</title></head>
<body>
<article>
  <h1>Page B: Second Result</h1>
  <p>Page B has its own distinct content. Quisque malesuada placerat nisl.
  Aliquam erat volutpat. Nam dui mi, tincidunt quis, accumsan porttitor,
  facilisis luctus, metus. Phasellus ultrices nulla quis nibh. Quisque a
  lectus. Donec consectetuer ligula vulputate sem tristique cursus. Nam nulla
  quam, gravida non, commodo a, sodales sit amet, nisi.</p>
  <p>The quick brown fox jumps over the lazy dog again. Lorem ipsum dolor sit
  amet, consectetur adipiscing elit. Vivamus luctus urna sed urna ultricies
  ac tempor dui sagittis. In condimentum facilisis porta. Sed nec diam eu diam
  mattis viverra. Nulla fringilla, orci ac euismod semper, magna diam porttitor
  mauris, quis sollicitudin sapien justo in libero.</p>
</article>
</body></html>`;

// ── Shared safe resolver (avoids real DNS in tests that use public-looking URLs)
// Returns a stable public IP so validate() passes without hitting the network.
const safeResolver = async (_hostname, _opts) => [
	{ address: "93.184.216.34", family: 4 },
];

// ── Tests ──────────────────────────────────────────────────────────────────────

test("web_search: returns expected shape with two canned results and answer", async () => {
	const guard = createRequestGuard({ resolver: safeResolver });
	const restoreFetch = stubFetch((url) => {
		if (url.startsWith("https://api.exa.ai/answer")) return makeJsonResponse(CANNED_EXA_ANSWER);
		throw new Error(`Unexpected URL in stub: ${url}`);
	});

	try {
		const result = await searchWithExa("test query", {}, guard);

		// Must be a real result, not an exhausted-budget sentinel
		assert.ok(
			result !== null && !("exhausted" in result),
			"Expected a SearchResponse, not null or { exhausted: true }",
		);

		// Answer matches canned data
		assert.strictEqual(
			result.answer,
			CANNED_EXA_ANSWER.answer,
			"answer must match the canned Exa response",
		);

		// Two results
		assert.strictEqual(result.results.length, 2, "Expected exactly 2 results");

		// Each result has required fields
		for (const r of result.results) {
			assert.ok(
				typeof r.url === "string" && r.url.length > 0,
				`result.url must be non-empty string; got: ${String(r.url)}`,
			);
			assert.ok(typeof r.title === "string", "result.title must be a string");
		}

		// Citations include the URLs from the canned data
		const urls = result.results.map((r) => r.url);
		assert.ok(
			urls.includes("https://example.com/page-a"),
			`URL 'page-a' missing from citations; got: ${urls.join(", ")}`,
		);
		assert.ok(
			urls.includes("https://example.com/page-b"),
			`URL 'page-b' missing from citations; got: ${urls.join(", ")}`,
		);
	} finally {
		restoreFetch();
	}
});

test("fetch_content: returns extracted markdown from canned HTML bodies", async () => {
	const guard = createRequestGuard({ resolver: safeResolver });
	const restoreFetch = stubFetch((url) => {
		if (url === "https://example.com/page-a") return makeHtmlResponse(CANNED_HTML_A);
		if (url === "https://example.com/page-b") return makeHtmlResponse(CANNED_HTML_B);
		throw new Error(`Unexpected URL in stub: ${url}`);
	});

	try {
		const results = await fetchAllContent(
			["https://example.com/page-a", "https://example.com/page-b"],
			undefined,
			undefined,
			guard,
		);

		assert.strictEqual(results.length, 2, "Expected 2 fetch results");

		// Page A
		assert.strictEqual(results[0].url, "https://example.com/page-a");
		assert.strictEqual(
			results[0].error,
			null,
			`Page A must not have an error; got: ${results[0].error}`,
		);
		assert.ok(
			results[0].content.length >= 100,
			`Page A markdown must be non-trivial; got ${results[0].content.length} chars`,
		);

		// Page B
		assert.strictEqual(results[1].url, "https://example.com/page-b");
		assert.strictEqual(
			results[1].error,
			null,
			`Page B must not have an error; got: ${results[1].error}`,
		);
		assert.ok(
			results[1].content.length >= 100,
			`Page B markdown must be non-trivial; got ${results[1].content.length} chars`,
		);
	} finally {
		restoreFetch();
	}
});

test("scheme rejection: file:// URL returns recoverable error (SchemeDenied)", async () => {
	// No fetch stub needed: validate() rejects file:// before calling fetch.
	const guard = createRequestGuard();
	const results = await fetchAllContent(
		["file:///etc/passwd"],
		undefined,
		undefined,
		guard,
	);
	assert.strictEqual(results.length, 1, "Expected one result");
	assert.ok(
		typeof results[0].error === "string" && results[0].error.length > 0,
		`Expected a non-empty error string; got: ${results[0].error}`,
	);
	// SchemeDenied message contains "Scheme not allowed"
	assert.ok(
		results[0].error.toLowerCase().includes("scheme"),
		`Error must mention scheme; got: ${results[0].error}`,
	);
	assert.strictEqual(results[0].content, "", "Content must be empty on scheme denial");
});

test("host-deny: 169.254.169.254 literal IP returns recoverable error (HostDenied)", async () => {
	// No fetch stub needed: validate() rejects the literal cloud-metadata IP.
	const guard = createRequestGuard();
	const results = await fetchAllContent(
		["http://169.254.169.254/latest/meta-data/"],
		undefined,
		undefined,
		guard,
	);
	assert.strictEqual(results.length, 1, "Expected one result");
	assert.ok(
		typeof results[0].error === "string" && results[0].error.length > 0,
		`Expected a non-empty error string; got: ${results[0].error}`,
	);
	assert.ok(
		results[0].error.toLowerCase().includes("host denied") ||
		results[0].error.toLowerCase().includes("private") ||
		results[0].error.toLowerCase().includes("reserved"),
		`Error must indicate host is denied; got: ${results[0].error}`,
	);
	assert.strictEqual(results[0].content, "", "Content must be empty on host denial");
});

test("size-cap: response with Content-Length > cap returns recoverable error (ResponseTooLarge)", async () => {
	// 1 byte cap so any real response body exceeds it.
	const guard = createRequestGuard({ resolver: safeResolver, maxBodyBytes: 1 });
	const restoreFetch = stubFetch((_url) => {
		return new Response("this body is longer than 1 byte", {
			status: 200,
			headers: {
				"Content-Type": "text/html",
				"Content-Length": "31",
			},
		});
	});

	try {
		const results = await fetchAllContent(
			["https://example.com/large-page"],
			undefined,
			undefined,
			guard,
		);
		assert.strictEqual(results.length, 1);
		assert.ok(
			typeof results[0].error === "string" && results[0].error.length > 0,
			`Expected size-cap error; got: ${results[0].error}`,
		);
		assert.ok(
			results[0].error.toLowerCase().includes("size") ||
			results[0].error.toLowerCase().includes("large") ||
			results[0].error.toLowerCase().includes("cap"),
			`Error must mention size cap; got: ${results[0].error}`,
		);
		assert.strictEqual(results[0].content, "");
	} finally {
		restoreFetch();
	}
});

test("get_search_content: full body is retrievable for a stored result exceeding 30 KB", () => {
	clearResults();

	// Build content that exceeds the inline truncation threshold used by index.ts
	const largeBody = "Lorem ipsum dolor sit amet, consectetur adipiscing. ".repeat(800);
	assert.ok(
		largeBody.length > MAX_INLINE_CONTENT,
		`largeBody (${largeBody.length}) must exceed MAX_INLINE_CONTENT (${MAX_INLINE_CONTENT})`,
	);

	const id = generateId();
	storeResult(id, {
		id,
		type: "fetch",
		timestamp: Date.now(),
		urls: [
			{
				url: "https://example.com/large-page",
				title: "Large Page",
				content: largeBody,
				error: null,
			},
		],
	});

	// Retrieve via getResult() — exactly what get_search_content executes
	const stored = getResult(id);
	assert.ok(stored !== null, "Stored result must be retrievable by id");
	assert.strictEqual(stored.type, "fetch");
	assert.ok(Array.isArray(stored.urls), "stored.urls must be an array");

	const urlData = stored.urls[0];
	assert.strictEqual(urlData.url, "https://example.com/large-page");
	assert.strictEqual(
		urlData.content,
		largeBody,
		"Full body must be intact in storage (not truncated)",
	);
	assert.ok(
		urlData.content.length > MAX_INLINE_CONTENT,
		`Stored body (${urlData.content.length}) must exceed the inline threshold (${MAX_INLINE_CONTENT})`,
	);
	assert.strictEqual(urlData.error, null, "No error on stored large result");
});

test("per-task budget enforced via real guard: search + fetch exhaust budget; next throws RequestBudgetExceeded", async () => {
	// maxFetches=2: first fetch (search API) and second fetch (page-a) succeed;
	// third fetch (page-b) must be rejected by the REAL guard.
	const guard = createRequestGuard({ maxFetches: 2, resolver: safeResolver });
	const restoreFetch = stubFetch((url) => {
		if (url.startsWith("https://api.exa.ai/answer")) return makeJsonResponse(CANNED_EXA_ANSWER);
		if (url === "https://example.com/page-a") return makeHtmlResponse(CANNED_HTML_A);
		if (url === "https://example.com/page-b") return makeHtmlResponse(CANNED_HTML_B);
		throw new Error(`Unexpected URL in stub: ${url}`);
	});

	try {
		// Fetch 1 — web_search calls guard.fetch once (EXA answer API)
		const searchResult = await searchWithExa("budget test query", {}, guard);
		assert.ok(
			searchResult !== null && !("exhausted" in searchResult),
			"Search must succeed within budget",
		);

		// Fetch 2 — fetch_content on a single URL
		const fetchResults = await fetchAllContent(
			["https://example.com/page-a"],
			undefined,
			undefined,
			guard,
		);
		assert.strictEqual(
			fetchResults[0].error,
			null,
			`Content fetch must succeed; got: ${fetchResults[0].error}`,
		);

		// Fetch 3 — budget exceeded: must throw RequestBudgetExceeded
		await assert.rejects(
			() =>
				fetchAllContent(
					["https://example.com/page-b"],
					undefined,
					undefined,
					guard,
				),
			(err) => {
				assert.ok(
					err instanceof RequestBudgetExceeded,
					`Expected RequestBudgetExceeded, got ${err?.constructor?.name}: ${err?.message}`,
				);
				assert.strictEqual(err.code, "budget_exceeded");
				return true;
			},
			"Third fetch must throw RequestBudgetExceeded",
		);
	} finally {
		restoreFetch();
	}
});

test("inline content truncated at 30 KB; full body stored and retrievable via get_search_content", () => {
	clearResults();

	// Build a body that exceeds the inline threshold
	const fullBody = "word ".repeat(8000); // ~40 000 chars
	assert.ok(fullBody.length > MAX_INLINE_CONTENT);

	// Store it as fetch_content would after receiving a large response
	const responseId = generateId();
	storeResult(responseId, {
		id: responseId,
		type: "fetch",
		timestamp: Date.now(),
		urls: [
			{
				url: "https://example.com/big",
				title: "Big Page",
				content: fullBody,
				error: null,
			},
		],
	});

	// Simulate what index.ts's fetch_content does: truncate for inline display
	const stored = getResult(responseId);
	const rawContent = stored.urls[0].content;

	const truncated = rawContent.length > MAX_INLINE_CONTENT;
	assert.ok(truncated, "Large body should be flagged as truncated for inline display");

	const inline = truncated
		? rawContent.slice(0, MAX_INLINE_CONTENT) + "\n\n[Content truncated...]"
		: rawContent;

	assert.ok(
		inline.length <= MAX_INLINE_CONTENT + 30,
		"Inline display must be capped near MAX_INLINE_CONTENT",
	);

	// get_search_content retrieval returns the full, un-truncated body
	const retrieved = getResult(responseId);
	assert.strictEqual(
		retrieved.urls[0].content,
		fullBody,
		"get_search_content must return full un-truncated body",
	);
	assert.ok(
		retrieved.urls[0].content.length > MAX_INLINE_CONTENT,
		"Retrieved body must exceed the inline threshold",
	);
});
