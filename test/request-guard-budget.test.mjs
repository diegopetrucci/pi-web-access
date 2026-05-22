/**
 * request-guard-budget.test.mjs
 *
 * Verifies per-task fetch budget enforcement.
 *
 * Strategy:
 *   1. Spin up a minimal HTTP server on 127.0.0.1 with a random port.
 *   2. Create a guard with maxFetches=2 and extraAllow=['127.0.0.1'] so the
 *      test server's address is not blocked by the loopback deny rule.
 *   3. Assert that the first 2 fetches succeed and the 3rd throws
 *      RequestBudgetExceeded.
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
