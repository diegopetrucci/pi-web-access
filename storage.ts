import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, type Stats, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtractedContent } from "./extract.ts";
import type { SearchResult } from "./exa.ts";
import { getCacheDir } from "./settings.ts";

const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_CACHE_VERSION = 1;
const CACHE_KEY_PATTERN = /^[A-Za-z0-9_-]+\.json$/;
const CACHE_TMP_PATTERN = /^[A-Za-z0-9_-]+\.json\.\d+\.\d+(?:\.[a-f0-9]{32})?\.tmp$/;
const CACHE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_METADATA_TEXT = 8192;
const DEFAULT_CACHE_LIMITS = { maxEntries: 128, maxBytes: 128 * 1024 * 1024 };
export const MAX_CACHE_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_ITEMS = 128;
const MAX_SESSION_RESTORE_WINDOW = MAX_SESSION_ITEMS * 4;
const MAX_SESSION_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_LEGACY_INLINE_BYTES = 5 * 1024 * 1024;

// Keep these storage bounds synchronized with MAX_EXA_QUERIES,
// MAX_EXA_RESULTS, MAX_EXA_QUERY_CHARS, MAX_EXA_TITLE_CHARS,
// MAX_EXA_URL_CHARS, and MAX_EXA_TEXT_CHARS in exa.ts. They are deliberately
// local so restoring a session does not load the provider runtime just to
// validate untrusted historical data.
const MAX_RESTORED_QUERIES = 4;
const MAX_RESTORED_RESULTS = 10;
const MAX_RESTORED_QUERY_CHARS = 2048;
const MAX_RESTORED_TITLE_CHARS = 512;
const MAX_RESTORED_URL_CHARS = 2048;
const MAX_RESTORED_SNIPPET_CHARS = 3000;
const MAX_RESTORED_ERROR_CHARS = MAX_METADATA_TEXT;
const CACHE_WRITE_FAILURE = "Failed to write fetched content cache";
const CACHE_READ_FAILURE = "Cached fetched content is unavailable";
const O_DIRECTORY = process.platform === "win32" ? 0 : (constants.O_DIRECTORY ?? 0);
const O_NOFOLLOW = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);

interface FetchCacheLimits {
	maxEntries: number;
	maxBytes: number;
}

interface CacheFile {
	name: string;
	size: number;
	mtimeMs: number;
	dev: number;
	ino: number;
}

export interface QueryResultData {
	query: string;
	results: SearchResult[];
	error: string | null;
}

interface FetchCacheRef {
	version: typeof FETCH_CACHE_VERSION;
	key: string;
	storedAt: number;
}

interface StoredFetchUrlMetadata {
	url: string;
	title: string;
	error: string | null;
	contentLength: number;
	mimeType?: string;
	status?: number;
}

export interface StoredSearchData {
	id: string;
	type: "search" | "fetch";
	timestamp: number;
	queries?: QueryResultData[];
	urls?: ExtractedContent[];
	fetchCache?: FetchCacheRef;
	urlMetadata?: StoredFetchUrlMetadata[];
	fetchCacheError?: string;
}

const storedResults = new Map<string, StoredSearchData>();

export function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function getFetchCacheDir(): string {
	return getCacheDir();
}

function fetchCachePath(key: string): string | null {
	if (!CACHE_KEY_PATTERN.test(key)) return null;
	return join(getFetchCacheDir(), key);
}

function cacheKeyForId(id: string): string {
	if (!CACHE_ID_PATTERN.test(id)) {
		throw new Error(`Invalid fetched content cache id: ${id}`);
	}
	return `${id}.json`;
}

function truncateMetadataText(value: string | undefined): string {
	if (!value) return "";
	if (value.length <= MAX_METADATA_TEXT) return value;
	const suffix = "...";
	return `${value.slice(0, MAX_METADATA_TEXT - suffix.length)}${suffix}`;
}

function metadataForUrls(urls: ExtractedContent[]): StoredFetchUrlMetadata[] {
	return urls.map((url) => ({
		url: truncateMetadataText(url.url),
		title: truncateMetadataText(url.title),
		error: url.error ? truncateMetadataText(url.error) : null,
		contentLength: url.content.length,
		...(url.mimeType ? { mimeType: truncateMetadataText(url.mimeType) } : {}),
		...(typeof url.status === "number" ? { status: url.status } : {}),
	}));
}

function isFetchCacheRef(value: unknown): value is FetchCacheRef {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const ref = value as Record<string, unknown>;
	return ref.version === FETCH_CACHE_VERSION &&
		typeof ref.key === "string" && CACHE_KEY_PATTERN.test(ref.key) &&
		typeof ref.storedAt === "number" && Number.isFinite(ref.storedAt);
}

function isStoredFetchUrlMetadata(value: unknown): value is StoredFetchUrlMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const meta = value as Record<string, unknown>;
	return typeof meta.url === "string" && meta.url.length <= MAX_METADATA_TEXT &&
		typeof meta.title === "string" && meta.title.length <= MAX_METADATA_TEXT &&
		(meta.error === null || (typeof meta.error === "string" && meta.error.length <= MAX_METADATA_TEXT)) &&
		typeof meta.contentLength === "number" && Number.isFinite(meta.contentLength) && meta.contentLength >= 0 &&
		(meta.mimeType === undefined || (typeof meta.mimeType === "string" && meta.mimeType.length <= MAX_METADATA_TEXT)) &&
		(meta.status === undefined || (typeof meta.status === "number" && Number.isFinite(meta.status)));
}

function isInlineFetchedUrl(value: unknown, maxBytes = DEFAULT_CACHE_LIMITS.maxBytes): value is ExtractedContent {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const url = value as Record<string, unknown>;
	if (typeof url.url !== "string" || url.url.length > MAX_METADATA_TEXT ||
		typeof url.title !== "string" || url.title.length > MAX_METADATA_TEXT ||
		typeof url.content !== "string" || Buffer.byteLength(url.content, "utf8") > maxBytes ||
		(url.error !== null && typeof url.error !== "string")) return false;
	if (url.error !== null && url.error.length > MAX_METADATA_TEXT) return false;
	return (url.mimeType === undefined || (typeof url.mimeType === "string" && url.mimeType.length <= MAX_METADATA_TEXT)) &&
		(url.status === undefined || (typeof url.status === "number" && Number.isFinite(url.status)));
}

function isInlineFetchData(
	data: StoredSearchData,
	maxBytes = DEFAULT_CACHE_LIMITS.maxBytes,
): data is StoredSearchData & { urls: ExtractedContent[] } {
	if (data.type !== "fetch" || !Array.isArray(data.urls) || data.urls.length > MAX_SESSION_ITEMS) return false;
	let totalBytes = 0;
	for (let index = 0; index < data.urls.length; index++) {
		const url = data.urls[index];
		if (!isInlineFetchedUrl(url, maxBytes)) return false;
		totalBytes += Buffer.byteLength(url.content, "utf8");
		if (totalBytes > maxBytes) return false;
	}
	return true;
}

function isBoundedLegacyFetchData(data: StoredSearchData): data is StoredSearchData & { urls: ExtractedContent[] } {
	return isInlineFetchData(data, MAX_LEGACY_INLINE_BYTES);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeFetchCacheRef(value: unknown): FetchCacheRef | null {
	if (!isFetchCacheRef(value)) return null;
	const ref = value as FetchCacheRef;
	return { version: FETCH_CACHE_VERSION, key: ref.key, storedAt: ref.storedAt };
}

function normalizeFetchUrlMetadata(value: unknown): StoredFetchUrlMetadata | null {
	if (!isStoredFetchUrlMetadata(value)) return null;
	const metadata = value as StoredFetchUrlMetadata;
	return {
		url: metadata.url,
		title: metadata.title,
		error: metadata.error,
		contentLength: metadata.contentLength,
		...(typeof metadata.mimeType === "string" ? { mimeType: metadata.mimeType } : {}),
		...(typeof metadata.status === "number" ? { status: metadata.status } : {}),
	};
}

function normalizeInlineFetchedUrl(value: unknown, maxBytes: number): ExtractedContent | null {
	if (!isInlineFetchedUrl(value, maxBytes)) return null;
	const url = value as ExtractedContent;
	return {
		url: url.url,
		title: url.title,
		content: url.content,
		error: url.error,
		...(typeof url.mimeType === "string" ? { mimeType: url.mimeType } : {}),
		...(typeof url.status === "number" ? { status: url.status } : {}),
	};
}

function normalizedStoredHeader(data: Record<string, unknown>): { id: string; timestamp: number } | null {
	if (typeof data.id !== "string" || !data.id || data.id.length > 256) return null;
	if (typeof data.timestamp !== "number" || !Number.isFinite(data.timestamp)) return null;
	return { id: data.id, timestamp: data.timestamp };
}

function normalizeSearchResult(value: unknown): SearchResult | null {
	if (!isRecord(value)) return null;
	if (typeof value.title !== "string" || value.title.length > MAX_RESTORED_TITLE_CHARS ||
		typeof value.url !== "string" || value.url.length > MAX_RESTORED_URL_CHARS ||
		typeof value.snippet !== "string" || value.snippet.length > MAX_RESTORED_SNIPPET_CHARS) {
		return null;
	}
	return { title: value.title, url: value.url, snippet: value.snippet };
}

function normalizeQueryResult(value: unknown): QueryResultData | null {
	if (!isRecord(value) || typeof value.query !== "string" || value.query.length > MAX_RESTORED_QUERY_CHARS ||
		!Array.isArray(value.results) || value.results.length > MAX_RESTORED_RESULTS ||
		(value.error !== null && (typeof value.error !== "string" || value.error.length > MAX_RESTORED_ERROR_CHARS))) {
		return null;
	}
	const results: SearchResult[] = [];
	for (let index = 0; index < value.results.length; index++) {
		const normalized = normalizeSearchResult(value.results[index]);
		if (!normalized) return null;
		results.push(normalized);
	}
	return { query: value.query, results, error: value.error };
}

function normalizeSearchRecord(data: Record<string, unknown>): StoredSearchData | null {
	const header = normalizedStoredHeader(data);
	if (!header || data.type !== "search" || !Array.isArray(data.queries) || data.queries.length > MAX_RESTORED_QUERIES) {
		return null;
	}
	const queries: QueryResultData[] = [];
	for (let index = 0; index < data.queries.length; index++) {
		const normalized = normalizeQueryResult(data.queries[index]);
		if (!normalized) return null;
		queries.push(normalized);
	}
	return { ...header, type: "search", queries };
}

function normalizeFetchRecord(
	data: Record<string, unknown>,
	maxBytes = MAX_LEGACY_INLINE_BYTES,
): StoredSearchData | null {
	const header = normalizedStoredHeader(data);
	if (!header || data.type !== "fetch") return null;

	if (data.urls !== undefined) {
		if (!Array.isArray(data.urls) || data.urls.length > MAX_SESSION_ITEMS) return null;
		const urls: ExtractedContent[] = [];
		let totalBytes = 0;
		for (let index = 0; index < data.urls.length; index++) {
			const url = normalizeInlineFetchedUrl(data.urls[index], maxBytes);
			if (!url) return null;
			totalBytes += Buffer.byteLength(url.content, "utf8");
			if (totalBytes > maxBytes) return null;
			urls.push(url);
		}
		return { ...header, type: "fetch", urls };
	}

	if (!Array.isArray(data.urlMetadata) || data.urlMetadata.length > MAX_SESSION_ITEMS) return null;
	const urlMetadata: StoredFetchUrlMetadata[] = [];
	for (let index = 0; index < data.urlMetadata.length; index++) {
		const metadata = normalizeFetchUrlMetadata(data.urlMetadata[index]);
		if (!metadata) return null;
		urlMetadata.push(metadata);
	}

	let fetchCache: FetchCacheRef | undefined;
	if (data.fetchCache !== undefined) {
		fetchCache = normalizeFetchCacheRef(data.fetchCache) ?? undefined;
		if (!fetchCache) return null;
	}
	let fetchCacheError: string | undefined;
	if (data.fetchCacheError !== undefined) {
		if (typeof data.fetchCacheError !== "string" || data.fetchCacheError.length > MAX_METADATA_TEXT) return null;
		fetchCacheError = data.fetchCacheError;
	}
	return {
		...header,
		type: "fetch",
		urlMetadata,
		...(fetchCache ? { fetchCache } : {}),
		...(fetchCacheError !== undefined ? { fetchCacheError } : {}),
	};
}

function normalizeRestoredData(value: unknown): StoredSearchData | null {
	if (!isRecord(value)) return null;
	if (value.type === "search") return normalizeSearchRecord(value);
	if (value.type === "fetch") return normalizeFetchRecord(value);
	return null;
}

// This is deliberately a cheap lower bound. It lets restore skip a legacy
// payload that cannot fit in the remaining aggregate budget without first
// measuring or serializing a multi-megabyte string. It only reads fields that
// the normalizers may retain; unknown branches are never traversed.
function normalizedPayloadLowerBound(value: Record<string, unknown>): number {
	let total = 0;
	const add = (field: unknown): void => {
		if (typeof field === "string") total += field.length;
	};
	add(value.id);
	add(value.type);

	if (value.type === "search") {
		if (!Array.isArray(value.queries) || value.queries.length > MAX_RESTORED_QUERIES) return 0;
		for (let queryIndex = 0; queryIndex < value.queries.length; queryIndex++) {
			const query = value.queries[queryIndex];
			if (!isRecord(query)) continue;
			add(query.query);
			add(query.error);
			if (!Array.isArray(query.results) || query.results.length > MAX_RESTORED_RESULTS) continue;
			for (let resultIndex = 0; resultIndex < query.results.length; resultIndex++) {
				const result = query.results[resultIndex];
				if (!isRecord(result)) continue;
				add(result.title);
				add(result.url);
				add(result.snippet);
			}
		}
	} else if (value.type === "fetch") {
		if (Array.isArray(value.urls)) {
			if (value.urls.length > MAX_SESSION_ITEMS) return 0;
			for (let index = 0; index < value.urls.length; index++) {
				const url = value.urls[index];
				if (!isRecord(url)) continue;
				add(url.url);
				add(url.title);
				add(url.content);
				add(url.error);
				add(url.mimeType);
			}
		} else if (Array.isArray(value.urlMetadata)) {
			if (value.urlMetadata.length > MAX_SESSION_ITEMS) return 0;
			for (let index = 0; index < value.urlMetadata.length; index++) {
				const metadata = value.urlMetadata[index];
				if (!isRecord(metadata)) continue;
				add(metadata.url);
				add(metadata.title);
				add(metadata.error);
				add(metadata.mimeType);
			}
		}
		if (isRecord(value.fetchCache)) {
			add(value.fetchCache.key);
		}
		add(value.fetchCacheError);
	}
	return total;
}

function normalizedPayloadBytes(data: StoredSearchData): number {
	return Buffer.byteLength(JSON.stringify(data), "utf8");
}

function cacheLimits(limits?: Partial<FetchCacheLimits>): FetchCacheLimits {
	const resolved = {
		maxEntries: limits?.maxEntries ?? DEFAULT_CACHE_LIMITS.maxEntries,
		maxBytes: limits?.maxBytes ?? DEFAULT_CACHE_LIMITS.maxBytes,
	};
	if (!Number.isFinite(resolved.maxEntries) || !Number.isInteger(resolved.maxEntries) || resolved.maxEntries <= 0 ||
		!Number.isFinite(resolved.maxBytes) || !Number.isInteger(resolved.maxBytes) || resolved.maxBytes <= 0) {
		throw new Error("Fetched content cache limits must be finite positive integers");
	}
	return resolved;
}

function enforceDirectoryMode(fd: number): void {
	try {
		fchmodSync(fd, 0o700);
	} catch (err) {
		if (process.platform !== "win32") throw err;
	}
}

function enforceFileMode(fd: number): void {
	try {
		fchmodSync(fd, 0o600);
	} catch (err) {
		if (process.platform !== "win32") throw err;
	}
}

function safeFetchCacheDir(create: true): string;
function safeFetchCacheDir(create: false): string | null;
function safeFetchCacheDir(create: boolean): string | null {
	const dir = getFetchCacheDir();
	const parent = dirname(dir);
	if (create) mkdirSync(parent, { recursive: true, mode: 0o700 });
	let parentInfo: Stats;
	try {
		parentInfo = lstatSync(parent);
	} catch (err) {
		if (!create && (err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
		throw new Error("Fetched content cache parent is not a safe directory");
	}
	if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
	let before: Stats;
	try {
		before = lstatSync(dir);
	} catch (err) {
		if (!create && (err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	if (before.isSymbolicLink() || !before.isDirectory()) {
		throw new Error("Fetched content cache path is not a safe directory");
	}
	if (process.platform === "win32") {
		const after = lstatSync(dir);
		if (after.isSymbolicLink() || !after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) {
			throw new Error("Fetched content cache directory changed while securing it");
		}
		return dir;
	}
	let fd: number | null = null;
	try {
		fd = openSync(dir, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
		const opened = fstatSync(fd);
		if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
			throw new Error("Fetched content cache directory changed while opening");
		}
		enforceDirectoryMode(fd);
		closeSync(fd);
		fd = null;
		const after = lstatSync(dir);
		if (after.isSymbolicLink() || !after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) {
			throw new Error("Fetched content cache directory changed while securing it");
		}
		return dir;
	} finally {
		if (fd !== null) try { closeSync(fd); } catch {}
	}
}

function openRegularFile(path: string): { fd: number; info: Stats } {
	const before = lstatSync(path);
	if (before.isSymbolicLink() || !before.isFile()) throw new Error("Fetched content cache entry is not a regular file");
	const fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) {
			throw new Error("Fetched content cache entry changed while opening");
		}
		return { fd, info };
	} catch (err) {
		closeSync(fd);
		throw err;
	}
}

type CacheUnlinkResult = "removed" | "missing" | "changed" | "error";

function unlinkCacheFile(dir: string, file: CacheFile): CacheUnlinkResult {
	try {
		const root = lstatSync(dir);
		if (root.isSymbolicLink() || !root.isDirectory()) return "changed";
		const path = join(dir, file.name);
		let current: Stats;
		try {
			current = lstatSync(path);
		} catch (err) {
			return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error";
		}
		if (current.isSymbolicLink() || !current.isFile() || current.dev !== file.dev || current.ino !== file.ino) return "changed";
		try {
			unlinkSync(path);
			return "removed";
		} catch (err) {
			return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error";
		}
	} catch {
		return "error";
	}
}

function pruneFetchCache(now: number, limits: FetchCacheLimits, preferredKey?: string, reservation?: { key: string; bytes: number }): boolean {
	let dir: string | null;
	try {
		dir = safeFetchCacheDir(false);
	} catch {
		return false;
	}
	if (!dir) return true;

	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return false;
	}

	const files: CacheFile[] = [];
	for (const entry of entries) {
		if (!CACHE_KEY_PATTERN.test(entry) && !CACHE_TMP_PATTERN.test(entry)) continue;
		const path = join(dir, entry);
		let opened: ReturnType<typeof openRegularFile>;
		try {
			opened = openRegularFile(path);
		} catch {
			continue;
		}
		try {
			enforceFileMode(opened.fd);
		} catch {
			closeSync(opened.fd);
			continue;
		}
		closeSync(opened.fd);
		const file = { name: entry, size: opened.info.size, mtimeMs: opened.info.mtimeMs, dev: opened.info.dev, ino: opened.info.ino };
		if (now - file.mtimeMs >= CACHE_TTL_MS) {
			const removed = unlinkCacheFile(dir, file);
			if (removed !== "removed" && removed !== "missing") return false;
			continue;
		}
		if (CACHE_KEY_PATTERN.test(entry)) files.push(file);
	}

	files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
	const projectedUsage = () => {
		const replaced = reservation ? files.find((file) => file.name === reservation.key) : undefined;
		return {
			entries: files.length + (reservation && !replaced ? 1 : 0),
			bytes: files.reduce((total, file) => total + file.size, 0) + (reservation ? reservation.bytes - (replaced?.size ?? 0) : 0),
		};
	};
	const attempted = new Set<string>();
	let usage = projectedUsage();
	while (usage.entries > limits.maxEntries || usage.bytes > limits.maxBytes) {
		const index = files.findIndex((file) => file.name !== preferredKey && !attempted.has(file.name));
		if (index < 0) break;
		const file = files[index];
		attempted.add(file.name);
		const removed = unlinkCacheFile(dir, file);
		if (removed === "removed" || removed === "missing") files.splice(index, 1);
		usage = projectedUsage();
	}
	return usage.entries <= limits.maxEntries && usage.bytes <= limits.maxBytes;
}

function writeFetchCache(data: StoredSearchData & { urls: ExtractedContent[] }): FetchCacheRef {
	const limits = DEFAULT_CACHE_LIMITS;
	const serialized = JSON.stringify(data);
	const size = Buffer.byteLength(serialized);
	if (size > MAX_CACHE_ENTRY_BYTES) throw new Error(`Fetched content cache entry exceeds ${MAX_CACHE_ENTRY_BYTES} bytes`);

	const key = cacheKeyForId(data.id);
	const dir = safeFetchCacheDir(true);
	if (!pruneFetchCache(Date.now(), limits, key, { key, bytes: size })) {
		throw new Error("Fetched content cache could not reserve space for a new entry");
	}
	const finalPath = join(dir, key);
	const tmpName = `${key}.${process.pid}.${Date.now()}.${randomBytes(16).toString("hex")}.tmp`;
	const tmpPath = join(dir, tmpName);
	let fd: number | null = null;
	let tmpFile: CacheFile | null = null;
	let renamed = false;
	try {
		fd = openSync(tmpPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_NOFOLLOW, 0o600);
		const tmpInfo = fstatSync(fd);
		tmpFile = { name: tmpName, size: tmpInfo.size, mtimeMs: tmpInfo.mtimeMs, dev: tmpInfo.dev, ino: tmpInfo.ino };
		enforceFileMode(fd);
		writeFileSync(fd, serialized, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = null;
		safeFetchCacheDir(false);
		renameSync(tmpPath, finalPath);
		renamed = true;
		const written = lstatSync(finalPath);
		if (!written.isFile() || written.dev !== tmpFile.dev || written.ino !== tmpFile.ino) {
			throw new Error("Fetched content cache entry changed after writing");
		}
		if (!pruneFetchCache(Date.now(), limits, key)) {
			throw new Error("Fetched content cache could not meet its limits after writing");
		}
	} catch (err) {
		if (fd !== null) try { closeSync(fd); } catch {}
		if (tmpFile) unlinkCacheFile(dir, { ...tmpFile, name: renamed ? key : tmpName });
		throw err;
	}
	return { version: FETCH_CACHE_VERSION, key, storedAt: Date.now() };
}

function cacheWriteError(_err: unknown): string {
	return CACHE_WRITE_FAILURE;
}

function createFetchSessionData(data: StoredSearchData & { urls: ExtractedContent[] }, ref: FetchCacheRef | null, cacheError?: string): StoredSearchData {
	return {
		id: data.id,
		type: "fetch",
		timestamp: data.timestamp,
		urlMetadata: metadataForUrls(data.urls),
		...(ref ? { fetchCache: ref } : {}),
		...(cacheError ? { fetchCacheError: truncateMetadataText(cacheError) } : {}),
	};
}

function fetchUrlMetadata(data: StoredSearchData): StoredFetchUrlMetadata[] {
	if (data.urlMetadata) return data.urlMetadata;
	return isInlineFetchData(data) ? metadataForUrls(data.urls) : [];
}

function unavailableFetchData(data: StoredSearchData, reason: string): StoredSearchData {
	return {
		...data,
		urls: fetchUrlMetadata(data).map((meta) => ({
			url: meta.url,
			title: meta.title,
			content: "",
			error: reason,
			...(meta.mimeType ? { mimeType: meta.mimeType } : {}),
			...(typeof meta.status === "number" ? { status: meta.status } : {}),
		})),
	};
}

function readBoundedCacheText(fd: number, initial: Stats, maxBytes: number): string | null {
	if (!initial.isFile() || !Number.isSafeInteger(initial.size) || initial.size < 0 || initial.size > maxBytes) return null;

	// Allocate only from the already validated size, with one extra byte to
	// detect growth before JSON.parse can see any unbounded input.
	const buffer = Buffer.allocUnsafe(initial.size + 1);
	let bytesRead = 0;
	while (bytesRead < buffer.length) {
		const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
		if (count === 0) break;
		bytesRead += count;
	}

	const final = fstatSync(fd);
	if (!final.isFile() || final.dev !== initial.dev || final.ino !== initial.ino ||
		final.size !== initial.size || bytesRead !== initial.size || final.size > maxBytes) return null;
	return buffer.toString("utf8", 0, bytesRead);
}

function readCachedFetchData(data: StoredSearchData, now = Date.now()): StoredSearchData {
	if (data.type !== "fetch") return data;
	if (now - data.timestamp >= CACHE_TTL_MS) {
		return unavailableFetchData(data, "Cached fetched content is missing or expired");
	}
	if (isInlineFetchData(data)) return data;
	if (!data.fetchCache) {
		return unavailableFetchData(data, CACHE_READ_FAILURE);
	}
	const path = fetchCachePath(data.fetchCache.key);
	if (!path) return unavailableFetchData(data, "Cached fetched content is missing or expired");
	let fd: number | null = null;
	try {
		if (!safeFetchCacheDir(false)) return unavailableFetchData(data, "Cached fetched content is missing or expired");
		const opened = openRegularFile(path);
		fd = opened.fd;
		enforceFileMode(fd);
		const text = readBoundedCacheText(fd, opened.info, MAX_CACHE_ENTRY_BYTES);
		if (text === null) return unavailableFetchData(data, "Cached fetched content is invalid");
		const parsed: unknown = JSON.parse(text);
		const normalized = isRecord(parsed) ? normalizeFetchRecord(parsed, MAX_CACHE_ENTRY_BYTES) : null;
		if (!normalized || normalized.type !== "fetch" || normalized.id !== data.id ||
			 normalized.timestamp !== data.timestamp || !normalized.urls) {
			return unavailableFetchData(data, "Cached fetched content is invalid");
		}
		return {
			id: normalized.id,
			type: "fetch",
			timestamp: normalized.timestamp,
			urls: normalized.urls,
			fetchCache: data.fetchCache,
			...(data.urlMetadata ? { urlMetadata: data.urlMetadata } : {}),
		};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return unavailableFetchData(data, "Cached fetched content is missing or expired");
		}
		return unavailableFetchData(data, CACHE_READ_FAILURE);
	} finally {
		if (fd !== null) try { closeSync(fd); } catch {}
	}
}

function pruneExpiredFetchedResults(now: number): void {
	for (const [id, data] of storedResults) {
		if (data.type === "fetch" && now - data.timestamp >= CACHE_TTL_MS) {
			storedResults.set(id, unavailableFetchData(data, "Cached fetched content is missing or expired"));
		}
	}
}

export function pruneExpiredFetchCache(now = Date.now(), requestedLimits?: Partial<FetchCacheLimits>): void {
	const limits = cacheLimits(requestedLimits);
	pruneExpiredFetchedResults(now);
	try { pruneFetchCache(now, limits); } catch {}
}

export function storeResult(id: string, data: StoredSearchData): void {
	storedResults.set(id, data);
}

export function storeFetchedContentResult(id: string, data: StoredSearchData & { type: "fetch"; urls: ExtractedContent[] }): StoredSearchData {
	pruneExpiredFetchedResults(Date.now());
	let ref: FetchCacheRef | null = null;
	let cacheError: string | undefined;
	try {
		ref = writeFetchCache(data);
	} catch (err) {
		cacheError = cacheWriteError(err);
	}
	storedResults.set(id, ref ? { ...data, fetchCache: ref, urlMetadata: metadataForUrls(data.urls) } : { ...data, fetchCacheError: cacheError });
	return createFetchSessionData(data, ref, cacheError);
}

export function getResult(id: string): StoredSearchData | null {
	const data = storedResults.get(id);
	if (!data) return null;
	const loaded = readCachedFetchData(data);
	if (loaded !== data) storedResults.set(id, loaded);
	return loaded;
}

export function getAllResults(): StoredSearchData[] {
	return Array.from(storedResults.values());
}

export function deleteResult(id: string): boolean {
	const data = storedResults.get(id);
	if (data?.fetchCache) {
		try {
			const dir = safeFetchCacheDir(false);
			const path = fetchCachePath(data.fetchCache.key);
			if (dir && path) {
				const info = lstatSync(path);
				if (!info.isSymbolicLink() && info.isFile()) {
					unlinkCacheFile(dir, { name: data.fetchCache.key, size: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino });
				}
			}
		} catch {}
	}
	return storedResults.delete(id);
}

export function clearResults(): void {
	storedResults.clear();
}

function isValidStoredData(data: unknown): data is StoredSearchData {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	if (typeof d.id !== "string" || !d.id || d.id.length > 256) return false;
	if (d.type !== "search" && d.type !== "fetch") return false;
	if (typeof d.timestamp !== "number" || !Number.isFinite(d.timestamp)) return false;
	if (d.type === "search" && (!Array.isArray(d.queries) || d.queries.length > MAX_SESSION_ITEMS)) return false;
	if (d.type === "fetch") {
		if (Array.isArray(d.urls)) return isBoundedLegacyFetchData({ ...d, type: "fetch" } as StoredSearchData);
		if (!Array.isArray(d.urlMetadata) || d.urlMetadata.length > MAX_SESSION_ITEMS || !d.urlMetadata.every(isStoredFetchUrlMetadata)) return false;
		return d.fetchCache === undefined
			? d.fetchCacheError === undefined || (typeof d.fetchCacheError === "string" && d.fetchCacheError.length <= MAX_METADATA_TEXT)
			: isFetchCacheRef(d.fetchCache);
	}
	return true;
}

export function restoreFromSession(ctx: ExtensionContext): void {
	storedResults.clear();
	const now = Date.now();
	pruneExpiredFetchCache(now);

	const branch = ctx.sessionManager.getBranch();
	if (!Array.isArray(branch)) return;

	const start = Math.max(0, branch.length - MAX_SESSION_RESTORE_WINDOW);
	const seenIds = new Set<string>();
	const accepted: Array<{ index: number; data: StoredSearchData }> = [];
	let totalBytes = 0;

	// Session branches are chronological. Walk only a bounded newest window so
	// an attacker cannot make restore traverse an unbounded history. Collect in
	// reverse order for newest-wins deduplication, then restore map order below.
	for (let index = branch.length - 1; index >= start; index--) {
		if (accepted.length >= MAX_SESSION_ITEMS) break;
		const entry = branch[index];
		if (!entry || entry.type !== "custom" || entry.customType !== "web-search-results" || !isRecord(entry.data)) continue;

		const header = normalizedStoredHeader(entry.data);
		if (!header || now - header.timestamp >= CACHE_TTL_MS || seenIds.has(header.id)) continue;
		if (normalizedPayloadLowerBound(entry.data) > MAX_SESSION_PAYLOAD_BYTES - totalBytes) continue;

		const data = normalizeRestoredData(entry.data);
		if (!data || now - data.timestamp >= CACHE_TTL_MS) continue;
		seenIds.add(data.id);
		const bytes = normalizedPayloadBytes(data);
		if (bytes > MAX_SESSION_PAYLOAD_BYTES - totalBytes) continue;

		accepted.push({ index, data });
		totalBytes += bytes;
	}

	accepted.sort((a, b) => a.index - b.index);
	for (const item of accepted) {
		// Store only the normalized projection. Legacy inline records remain in
		// memory only; new writes still publish compact cache references.
		storedResults.set(item.data.id, item.data);
	}
}
