/**
 * request-guard-suffix.test.mjs
 *
 * Verifies that the request guard rejects hostnames matching any of the
 * denied hostname-suffix patterns: *.internal, *.local, *.localhost, localhost.
 *
 * These checks run before DNS resolution (fast path).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

const { createRequestGuard, HostDenied } = await import(
	pathToFileURL(join(ROOT, "request-guard.ts")).href
);

const DENIED_HOSTS = [
	["http://foo.internal/",          ".internal suffix"],
	["http://service.corp.internal/", "deep .internal suffix"],
	["http://bar.local/",             ".local suffix (mDNS)"],
	["http://my-device.local/",       ".local suffix variant"],
	["http://baz.localhost/",         ".localhost suffix"],
	["http://app.baz.localhost/",     "deep .localhost suffix"],
	["http://localhost/",             "bare localhost"],
	["http://localhost:8080/",        "localhost with port"],
	["https://localhost/",            "https localhost"],
];

for (const [url, label] of DENIED_HOSTS) {
	test(`suffix-denied — ${label}: ${url}`, async () => {
		// Inject a resolver that should never be reached (suffix check is pre-DNS)
		let resolverCalled = false;
		const resolver = async (_hostname, _opts) => {
			resolverCalled = true;
			return [{ address: "93.184.216.34", family: 4 }];
		};
		const guard = createRequestGuard({ resolver });
		await assert.rejects(
			() => guard.validate(url),
			(err) => {
				assert.ok(
					err instanceof HostDenied,
					`Expected HostDenied, got ${err?.constructor?.name}: ${err?.message}`,
				);
				assert.strictEqual(err.code, "host_denied");
				// DNS should not have been consulted for suffix-denied hostnames
				assert.strictEqual(resolverCalled, false, "resolver must not be called for suffix-denied hosts");
				return true;
			},
		);
	});
}

test("does not block a hostname that ends with a non-denied suffix", async () => {
	const resolver = async (_hostname, _opts) => [
		{ address: "93.184.216.34", family: 4 },
	];
	const guard = createRequestGuard({ resolver });
	// 'notlocal.example.com' ends with 'local.example.com' but not '.local'
	const result = await guard.validate("http://notlocal.example.com/");
	assert.ok(result instanceof URL);
});
