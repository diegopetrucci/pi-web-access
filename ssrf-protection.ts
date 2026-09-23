import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import {
	configuredSecrets,
	getDomainPolicy,
	getFetchTimeoutMs,
	readSettings,
	redactError,
	redactText,
	type DomainPolicy,
} from "./settings.ts";
import { consumeRequestOperation } from "./request-budget.ts";

export const MAX_REDIRECTS = 5;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const USER_AGENT = "pi-web-access-tlh";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_HOST_SUFFIXES = [
	"localhost",
	"local",
	"localdomain",
	"internal",
	"intranet",
	"lan",
	"home.arpa",
	"corp",
	"private",
	"svc",
	"cluster.local",
	"docker.internal",
	"onion",
] as const;

export type LookupAddress = { address: string; family: number };
export type Lookup = (hostname: string) => Promise<LookupAddress[]>;
export type FetchImplementation = typeof fetch;

/** The pinned dispatcher and transport must come from the same Undici release. */
export const DEFAULT_FETCH: FetchImplementation = undiciFetch as unknown as FetchImplementation;

export interface ValidationOptions {
	lookup?: Lookup;
	domainPolicy?: DomainPolicy;
	secrets?: readonly string[];
}

export interface FetchRemoteOptions extends ValidationOptions {
	fetch?: FetchImplementation;
	maxRedirects?: number;
	/** Additional values that must never occur in a transport/provider error. */
	secrets?: readonly string[];
}

interface RequestInitWithDispatcher extends RequestInit {
	dispatcher?: unknown;
}

interface PinnedDispatcher {
	dispatcher: Agent;
	close: () => Promise<void>;
}

function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function safeError(err: unknown, secrets: readonly string[] = []): Error {
	return redactError(err, secrets);
}

function deniedHostname(hostname: string): boolean {
	const normalized = normalizeHostname(hostname);
	return BLOCKED_HOST_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

function assertDomainPolicy(hostname: string, policy?: DomainPolicy): void {
	if (!policy) return;
	if (policy.deny.some((entry) => domainMatches(hostname, entry))) {
		throw new Error(`Blocked hostname by fetch_content domain policy: ${hostname}`);
	}
	if (policy.allow.length > 0 && !policy.allow.some((entry) => domainMatches(hostname, entry))) {
		throw new Error(`Hostname not allowed by fetch_content domain policy: ${hostname}`);
	}
}

function domainMatches(hostname: string, entry: string): boolean {
	const normalizedHost = normalizeHostname(hostname);
	const normalizedEntry = normalizeHostname(entry);
	return normalizedHost === normalizedEntry || normalizedHost.endsWith(`.${normalizedEntry}`);
}

function assertRemoteScheme(url: URL): void {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only HTTP and HTTPS URLs can be fetched remotely");
	}
	if (!url.hostname) throw new Error("URL must include a hostname");
	if (url.username || url.password) throw new Error("URL credentials are not allowed");
	if (url.toString().length > 8192) throw new Error("URL exceeds the 8192-character limit");
}

function ipv4ToBytes(address: string): Uint8Array | null {
	const parts = address.split(".");
	if (parts.length !== 4) return null;
	const bytes = new Uint8Array(4);
	for (let index = 0; index < parts.length; index++) {
		if (!/^\d+$/.test(parts[index])) return null;
		const value = Number(parts[index]);
		if (!Number.isInteger(value) || value < 0 || value > 255) return null;
		bytes[index] = value;
	}
	return bytes;
}

function parseIPv6(address: string): number[] | null {
	let normalized = normalizeHostname(address);
	if (normalized.includes("%")) return null;
	if (normalized.includes(".")) {
		const lastColon = normalized.lastIndexOf(":");
		if (lastColon < 0) return null;
		const ipv4 = normalized.slice(lastColon + 1);
		const octets = ipv4ToBytes(ipv4);
		if (!octets) return null;
		normalized = `${normalized.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
	}

	const pieces = normalized.split("::");
	if (pieces.length > 2) return null;
	const left = pieces[0] ? pieces[0].split(":") : [];
	const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if (pieces.length === 1 && missing !== 0) return null;
	if (pieces.length === 2 && missing < 1) return null;
	const groups = [...left, ...Array(missing).fill("0"), ...right].map((part) => {
		if (!/^[0-9a-f]{1,4}$/i.test(part)) return -1;
		return parseInt(part, 16);
	});
	return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff) ? groups : null;
}

function isBlockedIPv4(address: string): boolean {
	const bytes = ipv4ToBytes(address);
	if (!bytes) return true;
	const [a, b, c] = bytes;
	return a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 88 && c === 99) ||
		(a === 192 && b === 2) ||
		(a === 198 && b >= 18 && b <= 19) ||
		(a === 198 && b === 51) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224;
}

function isBlockedIPv6(address: string): boolean {
	const groups = parseIPv6(address);
	if (!groups) return true;
	const first = groups[0];
	if (groups.every((group) => group === 0)) return true;
	if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
	if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
	if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
	if ((first & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
	if ((first & 0xff00) === 0xff00) return true; // ff00::/8
	if ((first & 0xffc0) === 0x2000 && groups[1] === 0x0db8) return true; // 2001:db8::/32
	if (first === 0x2001 && groups[1] === 0x0002) return true; // benchmark
	if (first === 0x2001 && groups[1] === 0x0010) return true; // ORCHID
	if (first === 0x2001 && groups[1] === 0x0020) return true; // ORCHIDv2
	if (first === 0x2001 && groups[1] === 0x0000) return true; // Teredo
	if (first === 0x2002) return true; // 6to4 can embed a private IPv4 address
	if (first === 0x0100 && groups[1] === 0x0000) return true; // discard-only 100::/64
	if (first === 0x0064 && groups[1] === 0xff9b) return true; // local-use NAT64

	const isMappedOrCompatible = groups.slice(0, 5).every((group) => group === 0) &&
		(groups[5] === 0 || groups[5] === 0xffff);
	if (isMappedOrCompatible) {
		const offset = groups[5] === 0xffff ? 6 : 6;
		const ipv4 = [groups[offset] >> 8, groups[offset] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
		return isBlockedIPv4(ipv4);
	}
	return false;
}

/** Exported for focused security tests and for the connector's final check. */
export function isBlockedAddress(address: string): boolean {
	const normalized = normalizeHostname(address);
	const version = net.isIP(normalized);
	return version === 4 ? isBlockedIPv4(normalized) : version === 6 ? isBlockedIPv6(normalized) : true;
}

function assertPublicAddress(address: string, hostname: string): void {
	const normalized = normalizeHostname(address);
	if (net.isIP(normalized) === 0 || isBlockedAddress(normalized)) {
		throw new Error(`Blocked internal address for ${hostname}: ${normalized}`);
	}
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
	return dnsLookup(hostname, { all: true, verbatim: true });
}

async function resolvePublicAddresses(hostname: string, lookup: Lookup, secrets: readonly string[] = []): Promise<LookupAddress[]> {
	const normalized = normalizeHostname(hostname);
	const version = net.isIP(normalized);
	if (version !== 0) {
		assertPublicAddress(normalized, normalized);
		return [{ address: normalized, family: version }];
	}

	let addresses: LookupAddress[];
	try {
		addresses = await lookup(normalized);
	} catch (err) {
		throw new Error(`Failed to resolve ${normalized}: ${redactText(errorText(err), secrets)}`);
	}
	if (!Array.isArray(addresses) || addresses.length === 0) {
		throw new Error(`Failed to resolve ${normalized}: no addresses returned`);
	}
	for (const item of addresses) {
		if (!item || typeof item.address !== "string") {
			throw new Error(`Failed to resolve ${normalized}: resolver returned a non-IP address`);
		}
		assertPublicAddress(item.address, normalized);
	}
	return addresses;
}

export async function validateRemoteUrl(rawUrl: string | URL, options: ValidationOptions = {}): Promise<URL> {
	let url: URL;
	try {
		url = rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(rawUrl);
	} catch {
		throw new Error("Invalid remote URL");
	}
	assertRemoteScheme(url);
	const hostname = normalizeHostname(url.hostname);
	if (deniedHostname(hostname)) throw new Error(`Blocked internal hostname: ${hostname}`);
	assertDomainPolicy(hostname, options.domainPolicy);
	await resolvePublicAddresses(hostname, options.lookup ?? defaultLookup, options.secrets);
	return url;
}

function normalizedRedirectLimit(value: number | undefined): number {
	if (value === undefined) return MAX_REDIRECTS;
	if (!Number.isInteger(value) || value < 0) return MAX_REDIRECTS;
	return Math.min(value, MAX_REDIRECTS);
}

function sameOrigin(left: URL, right: URL): boolean {
	return left.origin === right.origin;
}

function makeHeaders(init: RequestInit, stripCredentials = false): Headers {
	const headers = new Headers(init.headers);
	if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
	if (stripCredentials) {
		headers.delete("authorization");
		headers.delete("x-api-key");
	}
	return headers;
}

function timeoutError(timeoutMs: number): Error {
	return new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds`);
}

class RemoteDeadline {
	private readonly controller = new AbortController();
	private readonly failurePromise: Promise<never>;
	private failureReject: (reason: Error) => void = () => {};
	private readonly handlers = new Set<(reason: Error) => void>();
	private readonly timer: ReturnType<typeof setTimeout>;
	private readonly parentSignal?: AbortSignal;
	private readonly parentAbort: () => void;
	private failure: Error | null = null;
	private finished = false;

	constructor(timeoutMs: number, parentSignal?: AbortSignal | null) {
		this.parentSignal = parentSignal ?? undefined;
		this.failurePromise = new Promise<never>((_, reject) => {
			this.failureReject = reject;
		});
		// The rejection is also used by operations that start after headers. Mark it
		// handled here so an idle response body cannot create an unhandled rejection.
		void this.failurePromise.catch(() => undefined);
		this.parentAbort = () => this.fail(new Error("Request aborted"));
		if (this.parentSignal?.aborted) this.parentAbort();
		else this.parentSignal?.addEventListener("abort", this.parentAbort, { once: true });
		this.timer = setTimeout(() => this.fail(timeoutError(timeoutMs)), timeoutMs);
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get reason(): Error {
		return this.failure ?? new Error("Request aborted");
	}

	onAbort(handler: (reason: Error) => void): () => void {
		if (this.failure) {
			handler(this.failure);
			return () => undefined;
		}
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.failure) throw this.failure;
		const task = Promise.resolve().then(() => operation(this.signal));
		try {
			return await Promise.race([task, this.failurePromise]);
		} finally {
			void task.catch(() => undefined);
		}
	}

	finish(): void {
		if (this.finished) return;
		this.finished = true;
		clearTimeout(this.timer);
		this.parentSignal?.removeEventListener("abort", this.parentAbort);
		this.handlers.clear();
	}

	private fail(reason: Error): void {
		if (this.finished || this.failure) return;
		this.failure = reason;
		this.controller.abort(reason);
		this.failureReject(reason);
		for (const handler of this.handlers) handler(reason);
	}
}

async function callWithTimeout<T>(
	deadline: RemoteDeadline,
	operation: (signal: AbortSignal) => Promise<T>,
	secrets: readonly string[],
): Promise<T> {
	try {
		return await deadline.run(operation);
	} catch (err) {
		throw safeError(err, secrets);
	}
}

function contentLength(response: Response): number | null {
	const raw = response.headers.get("content-length");
	if (!raw || !/^\d+$/.test(raw.trim())) return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) ? value : null;
}

async function cancelResponse(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
	}
}

function maybeDecodeGzip(
	body: ReadableStream<Uint8Array>,
	shouldDecode: boolean,
): ReadableStream<Uint8Array> {
	if (!shouldDecode) return body;
	const sourceReader = body.getReader();
	let outputReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	let firstChunk: Uint8Array | null = null;
	let initialized = false;

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				if (!initialized) {
					initialized = true;
					const first = await sourceReader.read();
					if (first.done) {
						controller.close();
						return;
					}
					firstChunk = first.value;
					const isGzip = firstChunk.byteLength >= 2 && firstChunk[0] === 0x1f && firstChunk[1] === 0x8b;
					if (isGzip) {
						const compressed = new ReadableStream<Uint8Array>({
							start: (inner) => inner.enqueue(firstChunk!),
							async pull(inner) {
								const next = await sourceReader.read();
								if (next.done) inner.close();
								else inner.enqueue(next.value);
							},
							cancel: (reason) => sourceReader.cancel(reason),
						});
						outputReader = compressed.pipeThrough(
							new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
						).getReader();
					} else {
						controller.enqueue(firstChunk);
						firstChunk = null;
						return;
					}
				}
				if (!outputReader) {
					const next = await sourceReader.read();
					if (next.done) controller.close();
					else controller.enqueue(next.value);
					return;
				}
				const result = await outputReader.read();
				if (result.done) controller.close();
				else controller.enqueue(result.value);
			} catch (err) {
				controller.error(err);
			}
		},
		async cancel(reason) {
			try {
				await outputReader?.cancel(reason);
			} finally {
				await sourceReader.cancel(reason);
			}
		},
	});
}

function cappedBody(
	body: ReadableStream<Uint8Array>,
	deadline: RemoteDeadline,
	onClose: () => void,
	secrets: readonly string[],
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	let size = 0;
	let closed = false;
	let aborted = false;
	let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
	let removeAbortHandler: () => void = () => {};
	const close = () => {
		if (closed) return;
		closed = true;
		removeAbortHandler();
		deadline.finish();
		onClose();
	};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller;
		},
		async pull(controller) {
			try {
				if (aborted) return;
				const result = await deadline.run(() => reader.read());
				if (result.done) {
					close();
					controller.close();
					return;
				}
				const chunk = result.value;
				size += chunk.byteLength;
				if (size > MAX_RESPONSE_BYTES) {
					void reader.cancel();
					close();
					controller.error(new Error("Response too large (5 MiB limit)"));
					return;
				}
				controller.enqueue(chunk);
			} catch (err) {
				close();
				try {
					controller.error(safeError(err, secrets));
				} catch {
				}
			}
		},
		async cancel(reason) {
			try {
				await deadline.run(() => reader.cancel(reason));
			} catch (err) {
				throw safeError(err, secrets);
			} finally {
				close();
			}
		},
	});
	removeAbortHandler = deadline.onAbort((reason) => {
		aborted = true;
		void reader.cancel(reason);
		try {
			streamController?.error(reason);
		} catch {
		}
		close();
	});
	return stream;
}

function wrapResponse(
	response: Response,
	deadline: RemoteDeadline,
	onClose: () => void,
	secrets: readonly string[],
): Response {
	const body = response.body;
	if (!body) {
		deadline.finish();
		onClose();
		return response;
	}
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	const contentEncoding = headers.get("content-encoding")?.toLowerCase() ?? "";
	if (contentEncoding.includes("gzip")) headers.delete("content-encoding");
	return new Response(cappedBody(
		maybeDecodeGzip(body, contentEncoding.includes("gzip")),
		deadline,
		onClose,
		secrets,
	), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

async function closeDispatcher(dispatcher: Agent | undefined): Promise<void> {
	if (!dispatcher) return;
	try {
		await dispatcher.close();
	} catch {
	}
}

function createPinnedDispatcher(lookup: Lookup, secrets: readonly string[]): PinnedDispatcher {
	const connector = buildConnector({ allowH2: false });
	const connect = (options: any, callback: (...args: any[]) => void) => {
		const hostname = normalizeHostname(String(options.hostname));
		void resolvePublicAddresses(hostname, lookup, secrets)
			.then((addresses) => {
				const address = addresses[0];
				connector({
					...options,
					hostname: address.address,
					host: address.address,
					servername: options.servername ?? hostname,
				}, callback);
			})
			.catch((err) => callback(safeError(err, secrets), null));
	};
	const dispatcher = new Agent({
		connect: connect as never,
		allowH2: false,
		pipelining: 0,
		maxRequestsPerClient: 1,
		keepAliveTimeout: 1,
		maxCachedSessions: 0,
	});
	return { dispatcher, close: () => closeDispatcher(dispatcher) };
}

function responseTooLarge(response: Response): Error | null {
	const length = contentLength(response);
	return length !== null && length > MAX_RESPONSE_BYTES
		? new Error("Response too large (5 MiB limit)")
		: null;
}

export async function fetchRemoteUrl(
	url: string | URL,
	init: RequestInit = {},
	options: FetchRemoteOptions = {},
): Promise<Response> {
	const settings = readSettings();
	const policy = options.domainPolicy ?? getDomainPolicy(settings);
	const secrets = [...new Set([
		...configuredSecrets(settings),
		...(options.secrets ?? []),
	])];
	const lookup = options.lookup ?? defaultLookup;
	const fetchImpl: FetchImplementation = options.fetch ?? DEFAULT_FETCH;
	if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable");

	consumeRequestOperation();

	const timeoutMs = getFetchTimeoutMs(settings);
	const deadline = new RemoteDeadline(timeoutMs, init.signal);
	const maxRedirects = normalizedRedirectLimit(options.maxRedirects);
	try {
		let current = await callWithTimeout(
			deadline,
			() => validateRemoteUrl(url, { lookup, domainPolicy: policy, secrets }),
			secrets,
		);
		let requestInit: RequestInit = { ...init };

		for (let redirects = 0; redirects <= maxRedirects; redirects++) {
			// Resolve immediately before handing the URL to transport as well as during
			// URL validation. This closes the preflight-to-connect rebinding window for
			// custom fetch implementations; the pinned connector repeats the check at
			// the socket connection itself.
			await callWithTimeout(
				deadline,
				() => resolvePublicAddresses(current.hostname, lookup, secrets),
				secrets,
			);
			const pinned = createPinnedDispatcher(lookup, secrets);
			const headers = makeHeaders(requestInit);
			const requestWithTransport: RequestInitWithDispatcher = {
				...requestInit,
				headers,
				redirect: "manual",
				dispatcher: pinned.dispatcher,
			};
			let response: Response;
			try {
				response = await callWithTimeout(
					deadline,
					(signal) => Promise.resolve(fetchImpl(current, { ...requestWithTransport, signal })),
					secrets,
				);
			} catch (err) {
				await pinned.close();
				throw err;
			}

			const tooLarge = responseTooLarge(response);
			if (tooLarge) {
				try {
					await callWithTimeout(deadline, () => cancelResponse(response), secrets);
				} finally {
					await pinned.close();
				}
				throw tooLarge;
			}

			if (!REDIRECT_STATUSES.has(response.status)) {
				return wrapResponse(response, deadline, () => void pinned.close(), secrets);
			}

			const location = response.headers.get("location");
			if (!location) return wrapResponse(response, deadline, () => void pinned.close(), secrets);
			try {
				await callWithTimeout(deadline, () => cancelResponse(response), secrets);
			} finally {
				await pinned.close();
			}
			if (redirects >= maxRedirects) {
				throw new Error(`Too many redirects fetching ${redactText(current.toString(), secrets)}`);
			}

			let next: URL;
			try {
				next = new URL(location, current);
			} catch {
				throw new Error("Redirect location is invalid");
			}
			const crossOrigin = !sameOrigin(current, next);
			current = await callWithTimeout(
				deadline,
				() => validateRemoteUrl(next, { lookup, domainPolicy: policy, secrets }),
				secrets,
			);

			if (response.status === 303 ||
				((response.status === 301 || response.status === 302) && requestInit.method?.toUpperCase() === "POST")) {
				const { body: _body, ...nextInit } = requestInit;
				requestInit = { ...nextInit, method: "GET" };
			}
			if (crossOrigin) {
				const nextHeaders = new Headers(requestInit.headers);
				nextHeaders.delete("authorization");
				nextHeaders.delete("x-api-key");
				requestInit = { ...requestInit, headers: nextHeaders };
			}
		}

		throw new Error(`Too many redirects fetching ${redactText(current.toString(), secrets)}`);
	} catch (err) {
		deadline.finish();
		throw safeError(err, secrets);
	}
}

export function loadFetchContentDomainPolicy(): DomainPolicy {
	return getDomainPolicy();
}

export { getDomainPolicy, getFetchTimeoutMs, redactText };
export type { DomainPolicy } from "./settings.ts";
