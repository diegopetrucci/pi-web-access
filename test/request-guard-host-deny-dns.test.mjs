/**
 * request-guard-host-deny-dns.test.mjs
 *
 * Verifies DNS-rebinding resistance: when a public-looking hostname resolves
 * to a denied IP address (simulated via an injected resolver), the guard must
 * throw HostDenied even though the hostname string itself looks safe.
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

test("rejects public hostname that DNS resolves to cloud-metadata IP (169.254.169.254)", async () => {
	const resolver = async (_hostname, _opts) => [
		{ address: "169.254.169.254", family: 4 },
	];
	const guard = createRequestGuard({ resolver });
	await assert.rejects(
		() => guard.validate("http://totally-public-looking.example.test/"),
		(err) => {
			assert.ok(
				err instanceof HostDenied,
				`Expected HostDenied, got ${err?.constructor?.name}: ${err?.message}`,
			);
			assert.strictEqual(err.code, "host_denied");
			return true;
		},
	);
});

test("rejects public hostname that DNS resolves to RFC1918 address (10.x.x.x)", async () => {
	const resolver = async (_hostname, _opts) => [
		{ address: "10.42.0.1", family: 4 },
	];
	const guard = createRequestGuard({ resolver });
	await assert.rejects(
		() => guard.validate("http://looks-legit.example.test/path?query=value"),
		(err) => err instanceof HostDenied,
	);
});

test("rejects when ANY resolved address is denied (multi-address DNS)", async () => {
	// First address is public, second is denied — should still be blocked
	const resolver = async (_hostname, _opts) => [
		{ address: "93.184.216.34", family: 4 }, // example.com public IP (benign)
		{ address: "192.168.1.100", family: 4 },  // RFC1918 (denied)
	];
	const guard = createRequestGuard({ resolver });
	await assert.rejects(
		() => guard.validate("http://mixed-resolution.example.test/"),
		(err) => err instanceof HostDenied,
	);
});

test("rejects public hostname that DNS resolves to loopback IPv6 (::1)", async () => {
	const resolver = async (_hostname, _opts) => [
		{ address: "::1", family: 6 },
	];
	const guard = createRequestGuard({ resolver });
	await assert.rejects(
		() => guard.validate("http://sneaky-rebind.example.test/"),
		(err) => err instanceof HostDenied,
	);
});

test("allows public hostname when DNS returns a non-denied address", async () => {
	// Resolver returns a genuinely public IP; guard should not throw HostDenied
	const resolver = async (_hostname, _opts) => [
		{ address: "93.184.216.34", family: 4 },
	];
	const guard = createRequestGuard({ resolver });
	// validate() should resolve without throwing HostDenied
	const result = await guard.validate("http://example.com/");
	assert.ok(result instanceof URL);
});

test("DNS failure is treated as non-blocking (fetch will fail naturally)", async () => {
	const resolver = async (_hostname, _opts) => {
		throw new Error("ENOTFOUND simulated");
	};
	const guard = createRequestGuard({ resolver });
	// Should NOT throw HostDenied — DNS failure is not a deny-list hit
	const result = await guard.validate("http://nxdomain.example.test/");
	assert.ok(result instanceof URL);
});
