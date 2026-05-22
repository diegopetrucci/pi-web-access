/**
 * request-guard-host-deny-literal.test.mjs
 *
 * Verifies that the request guard rejects literal IP addresses that fall
 * in any of the denied ranges (loopback, RFC1918, link-local, cloud metadata,
 * CGNAT, unspecified, ULA, IPv6 loopback/link-local).
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

/** IPv4 addresses that must be blocked (one representative per denied range) */
const DENIED_IPV4 = [
	["127.0.0.1",       "loopback"],
	["127.255.255.254", "loopback /8 boundary"],
	["10.0.0.1",        "RFC 1918 10/8"],
	["10.255.255.255",  "RFC 1918 10/8 boundary"],
	["172.16.0.1",      "RFC 1918 172.16/12"],
	["172.31.255.255",  "RFC 1918 172.31 boundary"],
	["192.168.0.1",     "RFC 1918 192.168/16"],
	["192.168.255.255", "RFC 1918 192.168 boundary"],
	["169.254.169.254", "cloud metadata (AWS/GCP/Azure IMDS)"],
	["169.254.0.1",     "link-local"],
	["0.0.0.1",         "unspecified /8"],
	["100.64.0.1",      "CGNAT 100.64/10"],
	["100.127.255.255", "CGNAT boundary"],
];

for (const [ip, label] of DENIED_IPV4) {
	test(`IPv4 denied — ${label}: http://${ip}`, async () => {
		const guard = createRequestGuard();
		await assert.rejects(
			() => guard.validate(`http://${ip}/`),
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
}

/** IPv6 addresses that must be blocked */
const DENIED_IPV6 = [
	["[::1]",      "loopback"],
	["[fe80::1]",  "link-local fe80::/10"],
	["[fe80::abcd:1234]", "link-local fe80::/10 variant"],
	["[fc00::1]",  "ULA fc00::/7"],
	["[fd12:3456:789a::1]", "ULA fd00::/8 (within fc00::/7)"],
	["[::]",       "unspecified ::/128"],
];

for (const [host, label] of DENIED_IPV6) {
	test(`IPv6 denied — ${label}: http://${host}`, async () => {
		const guard = createRequestGuard();
		await assert.rejects(
			() => guard.validate(`http://${host}/`),
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
}

/** IPv4-mapped IPv6 addresses for private ranges must be blocked */
const DENIED_IPV4_MAPPED = [
	["[::ffff:127.0.0.1]",   "IPv4-mapped loopback"],
	["[::ffff:10.0.0.1]",    "IPv4-mapped RFC1918 10/8"],
	["[::ffff:192.168.1.1]", "IPv4-mapped RFC1918 192.168/16"],
	["[::ffff:169.254.169.254]", "IPv4-mapped cloud metadata"],
];

for (const [host, label] of DENIED_IPV4_MAPPED) {
	test(`IPv4-mapped IPv6 denied — ${label}: http://${host}`, async () => {
		const guard = createRequestGuard();
		await assert.rejects(
			() => guard.validate(`http://${host}/`),
			(err) => {
				assert.ok(
					err instanceof HostDenied,
					`Expected HostDenied, got ${err?.constructor?.name}: ${err?.message}`,
				);
				return true;
			},
		);
	});
}
