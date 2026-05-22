/**
 * request-guard.ts
 *
 * Code-side SSRF / budget / size guard for all outbound HTTP calls.
 *
 * Protection layers enforced in order:
 *  1. Scheme allowlist:     only http: and https: are permitted.
 *  2. Host-deny list:       enforced AFTER DNS resolution (DNS-rebinding resistant).
 *     Covers loopback, RFC 1918, link-local, cloud metadata (169.254.169.254),
 *     ULA, CGNAT, unspecified, and IPv4-mapped IPv6 addresses.
 *     Also blocks *.internal, *.local, *.localhost hostnames.
 *  3. Per-task fetch budget: max HTTP fetches per guard instance (default 6).
 *  4. Per-fetch size cap:    body streamed; aborted if size exceeds cap (default 5 MiB).
 *
 * DNS-rebinding TOCTOU mitigation:
 *  validate() resolves DNS to check the deny list before consuming budget.
 *  guardedFetch() ALSO re-validates the resolved IP at TCP connect time (via an
 *  undici Agent custom connect hook) to catch TTL=0 address flips that occur
 *  between validate() and the actual connection.  The resolved IP from the
 *  connect-time check is pinned as the TCP target so undici never re-resolves.
 *
 * @testability
 *  - `resolver` option: inject a custom DNS function to simulate DNS responses.
 *    Signature: (hostname, { all: true }) => Promise<Array<{address, family}>>
 *  - `extraAllow` option: array of IP strings explicitly allowed even when they
 *    match the host-deny list.  **USE ONLY IN TESTS** (e.g. allow `127.0.0.1`
 *    for a local HTTP test server).  Default: [].
 */

import dns from "node:dns";
import net from "node:net";
import { Agent, buildConnector } from "undici";

// Shared default connector (stateless; safe to reuse across calls).
const _defaultConnector = buildConnector({});

// ─── Error classes ────────────────────────────────────────────────────────────

export class SchemeDenied extends Error {
	readonly url: string;
	readonly code = "scheme_denied" as const;
	constructor(url: string) {
		super(`Scheme not allowed: ${redactUrl(url)}`);
		this.name = "SchemeDenied";
		this.url = url;
	}
}

export class HostDenied extends Error {
	readonly url: string;
	readonly code = "host_denied" as const;
	constructor(url: string) {
		super(`Host denied (private/reserved address): ${redactUrl(url)}`);
		this.name = "HostDenied";
		this.url = url;
	}
}

export class RequestBudgetExceeded extends Error {
	readonly url: string;
	readonly code = "budget_exceeded" as const;
	constructor(url: string) {
		super(`Request budget exceeded: ${redactUrl(url)}`);
		this.name = "RequestBudgetExceeded";
		this.url = url;
	}
}

export class ResponseTooLarge extends Error {
	readonly url: string;
	readonly code = "response_too_large" as const;
	constructor(url: string) {
		super(`Response body exceeded size cap: ${redactUrl(url)}`);
		this.name = "ResponseTooLarge";
		this.url = url;
	}
}

// ─── URL redaction ────────────────────────────────────────────────────────────

/** Redact a URL to scheme + host only (strips path, query, fragment). */
export function redactUrl(raw: string): string {
	try {
		const u = new URL(raw);
		return `${u.protocol}//${u.host}`;
	} catch {
		const m = raw.match(/^[a-z][a-z0-9+.\-]*:/i);
		return m ? `${m[0]}[redacted]` : "[redacted]";
	}
}

// ─── IPv4 helpers ─────────────────────────────────────────────────────────────

/** Denied IPv4 CIDR ranges as [base_uint32, prefix_bits] pairs. */
const DENIED_IPV4: ReadonlyArray<[number, number]> = [
	[0x7f000000, 8],   // 127.0.0.0/8      loopback
	[0x0a000000, 8],   // 10.0.0.0/8       RFC 1918
	[0xac100000, 12],  // 172.16.0.0/12    RFC 1918
	[0xc0a80000, 16],  // 192.168.0.0/16   RFC 1918
	[0xa9fe0000, 16],  // 169.254.0.0/16   link-local / cloud metadata
	[0x00000000, 8],   // 0.0.0.0/8        unspecified
	[0x64400000, 10],  // 100.64.0.0/10    CGNAT (RFC 6598)
];

function ipv4ToUint32(ip: string): number | null {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;
	const nums = parts.map(Number);
	if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
	return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
}

/** Returns true if the IPv4 address string falls in any denied range. */
export function isIPv4Denied(ip: string): boolean {
	const addr = ipv4ToUint32(ip);
	if (addr === null) return false;
	return DENIED_IPV4.some(([base, bits]) => {
		const mask = bits === 0 ? 0 : ((~0 << (32 - bits)) >>> 0);
		return (addr & mask) >>> 0 === (base & mask) >>> 0;
	});
}

// ─── IPv6 helpers ─────────────────────────────────────────────────────────────

/**
 * Expand an IPv6 address string (with optional brackets) to a 128-bit BigInt.
 * Returns null on parse failure.
 */
function expandIPv6ToBigInt(ip: string): bigint | null {
	const s = ip.toLowerCase().replace(/^\[|\]$/g, "");

	// IPv4-mapped shorthand: ::ffff:a.b.c.d
	const v4m = s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
	if (v4m) {
		const v4 = ipv4ToUint32(v4m[1]);
		if (v4 === null) return null;
		return BigInt("0xffff00000000") | BigInt(v4);
	}

	const dci = s.indexOf("::");
	let groups: string[];
	if (dci >= 0) {
		const left = s.slice(0, dci).split(":").filter(Boolean);
		const right = s.slice(dci + 2).split(":").filter(Boolean);
		const fill = 8 - left.length - right.length;
		if (fill < 0) return null;
		groups = [...left, ...Array(fill).fill("0"), ...right];
	} else {
		groups = s.split(":");
	}

	if (groups.length !== 8) return null;

	let r = 0n;
	for (const g of groups) {
		const v = parseInt(g || "0", 16);
		if (!Number.isFinite(v) || v < 0 || v > 0xffff) return null;
		r = (r << 16n) | BigInt(v);
	}
	return r;
}

/** Returns true if the IPv6 address string falls in any denied range. */
export function isIPv6Denied(ip: string): boolean {
	const addr = expandIPv6ToBigInt(ip);
	if (addr === null) return false;

	if (addr === 0n) return true;               // ::/128  unspecified
	if (addr === 1n) return true;               // ::1     loopback

	// fe80::/10  link-local:   top 10 bits === 0b1111_1110_10 (0x3fa)
	if ((addr >> 118n) === 0x3fan) return true;

	// fc00::/7   ULA:          top 7 bits  === 0b1111_110  (0x7e)
	if ((addr >> 121n) === 0x7en) return true;

	// ::ffff:0:0/96  IPv4-mapped — re-check the embedded IPv4 address
	if ((addr >> 32n) === 0xffffn) {
		const v4n = Number(addr & 0xffffffffn);
		const v4s = [
			(v4n >>> 24) & 0xff,
			(v4n >>> 16) & 0xff,
			(v4n >>> 8) & 0xff,
			v4n & 0xff,
		].join(".");
		return isIPv4Denied(v4s);
	}

	return false;
}

// ─── Hostname suffix deny ─────────────────────────────────────────────────────

const DENIED_SUFFIXES = [".internal", ".local", ".localhost"] as const;

function isHostnameSuffixDenied(hostname: string): boolean {
	const h = hostname.toLowerCase();
	if (h === "localhost") return true;
	return DENIED_SUFFIXES.some((s) => h.endsWith(s));
}

// ─── Public types ─────────────────────────────────────────────────────────────

export type DnsResolver = (
	hostname: string,
	options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

export interface RequestGuardOptions {
	/** Maximum outbound fetches allowed per guard instance. Default: 6. */
	maxFetches?: number;
	/** Maximum response body bytes before throwing ResponseTooLarge. Default: 5 MiB. */
	maxBodyBytes?: number;
	/**
	 * Custom DNS resolver for testing.  Inject a function that returns
	 * synthetic address records to simulate DNS rebinding or NXDOMAIN.
	 */
	resolver?: DnsResolver;
	/**
	 * IP addresses that bypass the host-deny list.
	 * **USE ONLY IN TESTS** — e.g. `['127.0.0.1']` to allow a local HTTP
	 * test server that would otherwise be blocked by the loopback deny rule.
	 * Default: [].
	 */
	extraAllow?: string[];
}

export interface RequestGuard {
	/**
	 * Validate a URL against the scheme allowlist and host-deny list.
	 * Returns the parsed URL on success.  Throws on any rejection.
	 */
	validate(url: string): Promise<URL>;
	/**
	 * Perform a guarded fetch: validate URL, count against the task budget,
	 * perform the HTTP request (with connect-time IP re-validation to close
	 * the DNS-rebinding TOCTOU window), and enforce the body size cap.
	 *
	 * Returns a new Response with the body fully buffered in memory
	 * (safe to consume with `.text()`, `.json()`, etc.).
	 * Throws if any guard policy is violated.
	 */
	fetch(url: string, init?: RequestInit): Promise<Response>;
}

// ─── Default DNS resolver ─────────────────────────────────────────────────────

function defaultResolver(hostname: string, options: { all: true }) {
	return dns.promises.lookup(hostname, options);
}

// ─── Guard factory ────────────────────────────────────────────────────────────

/**
 * Construct a fresh guard for a single task.
 *
 * Default values:
 *   maxFetches   = 6
 *   maxBodyBytes = 5 MiB  (5 * 1024 * 1024)
 *   resolver     = dns.promises.lookup with { all: true }
 *   extraAllow   = []
 */
export function createRequestGuard(opts?: RequestGuardOptions): RequestGuard {
	const maxFetches   = opts?.maxFetches   ?? 6;
	const maxBodyBytes = opts?.maxBodyBytes ?? 5 * 1024 * 1024;
	const resolver: DnsResolver = opts?.resolver ?? defaultResolver;
	const extraAllow   = new Set(opts?.extraAllow ?? []);

	let fetchCount = 0;

	async function validate(url: string): Promise<URL> {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new SchemeDenied(url);
		}

		// 1. Scheme allowlist
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new SchemeDenied(url);
		}

		const hostname = parsed.hostname;

		// 2a. Hostname suffix deny (fast path, before DNS)
		if (isHostnameSuffixDenied(hostname)) {
			throw new HostDenied(url);
		}

		// 2b. Literal IPv4
		if (net.isIPv4(hostname)) {
			if (!extraAllow.has(hostname) && isIPv4Denied(hostname)) {
				throw new HostDenied(url);
			}
			return parsed;
		}

		// 2c. Literal IPv6 (URLs use bracket notation: http://[::1]/)
		if (hostname.startsWith("[") && hostname.endsWith("]")) {
			const bare = hostname.slice(1, -1);
			if (net.isIPv6(bare)) {
				if (!extraAllow.has(bare) && isIPv6Denied(bare)) {
					throw new HostDenied(url);
				}
				return parsed;
			}
		}

		// 2d. DNS resolution — check every resolved address (rebind-resistant)
		let addresses: Array<{ address: string; family: number }>;
		try {
			addresses = await resolver(hostname, { all: true });
		} catch {
			// DNS failure → let the fetch fail naturally
			return parsed;
		}

		for (const { address, family } of addresses) {
			if (extraAllow.has(address)) continue;
			if (family === 4 && isIPv4Denied(address)) throw new HostDenied(url);
			if (family === 6 && isIPv6Denied(address)) throw new HostDenied(url);
		}

		return parsed;
	}

	async function guardedFetch(
		url: string,
		init?: RequestInit,
	): Promise<Response> {
		// Validate (scheme, host-deny) before consuming any budget
		await validate(url);

		// Per-task fetch budget
		fetchCount++;
		if (fetchCount > maxFetches) {
			throw new RequestBudgetExceeded(url);
		}

		// Create a per-request Agent whose connect hook re-validates the resolved
		// IP at TCP connect time.  This closes the DNS-rebinding TOCTOU window:
		// a TTL=0 record that flips after validate() is caught here before the
		// connection is established.  The resolved IP is pinned so undici never
		// issues a second DNS lookup for this connection.
		const agent = new Agent({
			connect(options, callback) {
				const hostname = options.hostname;

				// Literal IPv4 in the URL — just re-check it
				if (net.isIPv4(hostname)) {
					if (!extraAllow.has(hostname) && isIPv4Denied(hostname)) {
						callback(new HostDenied(url), null);
						return;
					}
					_defaultConnector(options, callback);
					return;
				}

				// Hostname — resolve and validate at connect time, then pin the IP
				resolver(hostname, { all: true }).then((addresses) => {
					for (const { address, family } of addresses) {
						if (extraAllow.has(address)) continue;
						if (family === 4 && isIPv4Denied(address)) {
							callback(new HostDenied(url), null);
							return;
						}
						if (family === 6 && isIPv6Denied(address)) {
							callback(new HostDenied(url), null);
							return;
						}
					}
					if (addresses.length > 0) {
						// Pin the connection to the validated IP.
						// Preserve the original hostname as TLS SNI so certificate
						// validation uses the correct server name, not the raw IP.
						_defaultConnector(
							{
								...options,
								host: addresses[0].address,
								hostname: addresses[0].address,
								servername: options.servername ?? hostname,
							},
							callback,
						);
					} else {
						_defaultConnector(options, callback);
					}
				}).catch(() => {
					// DNS failure at connect time — let the default connector handle it
					_defaultConnector(options, callback);
				});
			},
		});

		try {
			// `dispatcher` is a Node.js (undici-based) fetch extension not in the
			// standard RequestInit type; cast required.
			const response = await (globalThis.fetch as (
				input: string,
				init?: RequestInit & { dispatcher?: Agent },
			) => Promise<Response>)(url, { ...init, dispatcher: agent });

			// Pre-check Content-Length to short-circuit before reading the body
			const cl = response.headers.get("content-length");
			if (cl !== null) {
				const len = parseInt(cl, 10);
				if (Number.isFinite(len) && len > maxBodyBytes) {
					response.body?.cancel().catch(() => {});
					throw new ResponseTooLarge(url);
				}
			}

			// Stream body with a running byte counter; abort on cap exceeded
			const body = response.body;
			if (!body) {
				return new Response(null, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			}

			const reader = body.getReader();
			const chunks: Uint8Array[] = [];
			let total = 0;

			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					total += value.byteLength;
					if (total > maxBodyBytes) {
						reader.cancel().catch(() => {});
						throw new ResponseTooLarge(url);
					}
					chunks.push(value);
				}
			} catch (err) {
				if (!(err instanceof ResponseTooLarge)) reader.cancel().catch(() => {});
				throw err;
			}

			// Reconstruct a fresh Response from the buffered body
			const buf = new Uint8Array(total);
			let off = 0;
			for (const c of chunks) {
				buf.set(c, off);
				off += c.byteLength;
			}

			return new Response(buf, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		} catch (err) {
			// Undici wraps connect-time callback errors in TypeError("fetch failed")
			// with the original error as `.cause`.  Unwrap our HostDenied so
			// callers see the typed error rather than a generic TypeError.
			if (err instanceof TypeError && err.cause instanceof HostDenied) {
				throw err.cause;
			}
			throw err;
		} finally {
			agent.close().catch(() => {});
		}
	}

	return { validate, fetch: guardedFetch };
}
