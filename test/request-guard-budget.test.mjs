/**
 * request-guard-budget.test.mjs
 *
 * Verifies per-task fetch budget enforcement.
 *
 * Sections:
 *   A. Unit tests on the RequestGuard primitive (guard-instance-level budget).
 *   B. "Shared across tools" semantics: asserts that a single guard shared
 *      between web_search-style fetches and fetch_content-style fetches
 *      correctly enforces a joint budget (simulating Finding 1's requirement
 *      that counts are shared across tools within a single agent turn).
 *
 * Strategy (section A):
 *   1. Spin up a minimal HTTP server on 127.0.0.1 with a random port.
 *   2. Create a guard with maxFetches=2 and extraAllow=['127.0.0.1'] so the
 *      test server's address is not blocked by the loopback deny rule.
 *   3. Assert that the first 2 fetches succeed and the 3rd throws
 *      RequestBudgetExceeded.
 *
 * Strategy (section B):
 *   Simulate web_search consuming 4 fetches, then fetch_content attempting 3
 *   more against the same shared guard (maxFetches=6).  Assert the 7th fetch
 *   is rejected — the combined count across both "tools" is what matters.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

const { createRequestGuard, RequestBudgetExceeded } = await import(
	pathToFileURL(join(ROOT, "request-guard.ts")).href
);

let server;
let baseUrl;

before(async () => {
	await new Promise((resolve, reject) => {
		server = http.createServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("ok");
		});
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			baseUrl = `http://127.0.0.1:${port}`;
			resolve();
		});
		server.on("error", reject);
	});
});

after(async () => {
	await new Promise((resolve) => server.close(resolve));
});

test("first two fetches succeed, third throws RequestBudgetExceeded", async () => {
	const guard = createRequestGuard({
		maxFetches: 2,
		extraAllow: ["127.0.0.1"],
	});

	// First fetch — must succeed
	const r1 = await guard.fetch(`${baseUrl}/`);
	assert.strictEqual(r1.status, 200);
	const t1 = await r1.text();
	assert.strictEqual(t1, "ok");

	// Second fetch — must succeed
	const r2 = await guard.fetch(`${baseUrl}/`);
	assert.strictEqual(r2.status, 200);

	// Third fetch — must throw RequestBudgetExceeded
	await assert.rejects(
		() => guard.fetch(`${baseUrl}/`),
		(err) => {
			assert.ok(
				err instanceof RequestBudgetExceeded,
				`Expected RequestBudgetExceeded, got ${err?.constructor?.name}: ${err?.message}`,
			);
			assert.strictEqual(err.code, "budget_exceeded");
			return true;
		},
	);
});

test("budget is per-guard-instance (fresh guard has its own budget)", async () => {
	// Two fresh guards with maxFetches=1 each — both should succeed once
	const g1 = createRequestGuard({ maxFetches: 1, extraAllow: ["127.0.0.1"] });
	const g2 = createRequestGuard({ maxFetches: 1, extraAllow: ["127.0.0.1"] });

	const r1 = await g1.fetch(`${baseUrl}/`);
	assert.strictEqual(r1.status, 200);

	const r2 = await g2.fetch(`${baseUrl}/`);
	assert.strictEqual(r2.status, 200);

	// Both are now exhausted
	await assert.rejects(() => g1.fetch(`${baseUrl}/`), (err) => err instanceof RequestBudgetExceeded);
	await assert.rejects(() => g2.fetch(`${baseUrl}/`), (err) => err instanceof RequestBudgetExceeded);
});

// ── Section B: shared-guard "across tools" semantics ────────────────────────

test("shared guard: budget counted across web_search + fetch_content calls", async () => {
	// A shared guard as index.ts would create for a single agent turn.
	// maxFetches=6 is the default; we use maxFetches=6 explicitly for clarity.
	const sharedGuard = createRequestGuard({ maxFetches: 6, extraAllow: ["127.0.0.1"] });

	// Phase 1 — simulate web_search consuming 4 fetches (e.g. 1 answer API +
	// 3 result page fetches).
	for (let i = 0; i < 4; i++) {
		const r = await sharedGuard.fetch(`${baseUrl}/`);
		assert.strictEqual(r.status, 200, `Search-phase fetch ${i + 1} must succeed`);
	}

	// Phase 2 — simulate fetch_content consuming 2 more fetches (budget now at 6).
	for (let i = 0; i < 2; i++) {
		const r = await sharedGuard.fetch(`${baseUrl}/`);
		assert.strictEqual(r.status, 200, `Fetch-content fetch ${i + 1} must succeed`);
	}

	// Phase 3 — the 7th fetch (from either "tool") must be rejected.
	// The combined 4+3 = 7 exceeds maxFetches=6.
	await assert.rejects(
		() => sharedGuard.fetch(`${baseUrl}/`),
		(err) => {
			assert.ok(
				err instanceof RequestBudgetExceeded,
				`Expected RequestBudgetExceeded from the shared guard, got ${err?.constructor?.name}: ${err?.message}`,
			);
			assert.strictEqual(err.code, "budget_exceeded");
			return true;
		},
		"The 7th fetch across both tool phases must throw RequestBudgetExceeded",
	);
});

test("validate() does not count against the fetch budget", async () => {
	const guard = createRequestGuard({
		maxFetches: 1,
		extraAllow: ["127.0.0.1"],
	});

	// Multiple validate() calls should not consume budget
	await guard.validate(`${baseUrl}/`);
	await guard.validate(`${baseUrl}/`);
	await guard.validate(`${baseUrl}/`);

	// The single allowed fetch should still work
	const r = await guard.fetch(`${baseUrl}/`);
	assert.strictEqual(r.status, 200);

	// Now exhausted
	await assert.rejects(() => guard.fetch(`${baseUrl}/`), (err) => err instanceof RequestBudgetExceeded);
});
