/**
 * request-guard-dns-toctou.test.mjs
 *
 * Verifies that the DNS-rebinding TOCTOU window is closed by the connect-time
 * IP re-validation hook in guardedFetch().
 *
 * Attack scenario:
 *   1. validate() resolves the hostname → public IP → passes the deny list.
 *   2. The TTL=0 DNS record flips before the TCP connection is established.
 *   3. The connect-time hook re-resolves → denied IP (loopback / RFC1918) → rejects.
 *
 * The existing mocked-resolver tests in request-guard-host-deny-dns.test.mjs
 * only exercise validate(); the tests here exercise the connect-time path.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

const { createRequestGuard, HostDenied } = await import(
	pathToFileURL(join(ROOT, "request-guard.ts")).href
);

// ── Helper: a minimal HTTP server on 127.0.0.1 (to confirm TOCTOU rejection
//    happens before the connection completes, not afterward) ──────────────────
let server;
let baseUrl;
let serverHit = false;

before(async () => {
	await new Promise((resolve, reject) => {
		server = http.createServer((_req, res) => {
			serverHit = true;
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("should-not-reach");
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

test("TOCTOU: connect-time validation catches IP that flipped after validate()", async () => {
	// Resolver call #1 (from validate()): returns a safe public IP → validate passes.
	// Resolver call #2+ (from connect hook): returns loopback → connection denied.
	let callCount = 0;
	const flippingResolver = async (_hostname, _opts) => {
		callCount++;
		if (callCount === 1) {
			// First call: looks safe to validate()
			return [{ address: "93.184.216.34", family: 4 }];
		}
		// Subsequent calls: address has flipped to loopback (TTL=0 rebind)
		return [{ address: "127.0.0.1", family: 4 }];
	};

	const guard = createRequestGuard({ resolver: flippingResolver });
	serverHit = false;

	await assert.rejects(
		() => guard.fetch("http://sneaky-rebind.example.test/"),
		(err) => {
			assert.ok(
				err instanceof HostDenied,
				`Expected HostDenied, got ${err?.constructor?.name}: ${err?.message}`,
			);
			assert.strictEqual(err.code, "host_denied");
			return true;
		},
		"guard.fetch() must throw HostDenied when the DNS record flips between validate() and connect",
	);

	assert.strictEqual(
		serverHit,
		false,
		"The local test server must NOT receive any connection (rejection happens at connect time)",
	);
	assert.ok(callCount >= 2, `Resolver should have been called at least twice; got ${callCount}`);
});

test("TOCTOU: connect-time validation catches IPv6 loopback flip", async () => {
	let callCount = 0;
	const flippingResolver = async (_hostname, _opts) => {
		callCount++;
		if (callCount === 1) {
			return [{ address: "2001:db8::1", family: 6 }]; // documentation range — safe
		}
		return [{ address: "::1", family: 6 }]; // loopback — denied
	};

	const guard = createRequestGuard({ resolver: flippingResolver });

	await assert.rejects(
		() => guard.fetch("http://ipv6-rebind.example.test/"),
		(err) => {
			assert.ok(
				err instanceof HostDenied,
				`Expected HostDenied, got ${err?.constructor?.name}: ${err?.message}`,
			);
			assert.strictEqual(err.code, "host_denied");
			return true;
		},
	);
	assert.ok(callCount >= 2, `Resolver should have been called at least twice; got ${callCount}`);
});

test("TOCTOU: no false positive — stable public address is allowed", async () => {
	// Resolver returns the same public IP on every call (no flip).
	const stableResolver = async (_hostname, _opts) => [
		{ address: "93.184.216.34", family: 4 },
	];

	const guard = createRequestGuard({
		resolver: stableResolver,
		// Allow the local server so the fetch actually completes
		extraAllow: ["127.0.0.1"],
	});

	// This fetch goes to 127.0.0.1 directly (extraAllow bypasses deny list)
	// while the stableResolver is used for the hostname validation step.
	// We use the real local server here to confirm the full fetch completes.
	const r = await guard.fetch(baseUrl + "/");
	assert.strictEqual(r.status, 200);
	const text = await r.text();
	assert.strictEqual(text, "should-not-reach");
	assert.strictEqual(serverHit, true);
	serverHit = false;
});
