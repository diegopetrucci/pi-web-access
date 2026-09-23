import { activityMonitor } from "./activity.ts";
import { fetchRemoteUrl, type FetchImplementation } from "./ssrf-protection.ts";
import {
	configuredSecrets,
	readSettings,
	redactError,
	redactText,
	type WebSettings,
} from "./settings.ts";
export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResponse {
	results: SearchResult[];
}

export interface SearchOptions {
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	signal?: AbortSignal;
	/** Explicit transport for focused provider/runtime integration tests. */
	fetch?: FetchImplementation;
}

/** Exa search limits owned by this provider boundary. */
export const MAX_EXA_QUERIES = 4;
export const DEFAULT_EXA_RESULTS = 5;
export const MAX_EXA_RESULTS = 10;

/** Bounds sent to Exa and applied again while normalizing provider output. */
export const MAX_EXA_TEXT_CHARS = 3000;
export const MAX_EXA_HIGHLIGHT_CHARS = 3000;

/** Conservative provider-boundary limits; tool schemas are not the trust boundary. */
export const MAX_EXA_QUERY_CHARS = 2048;
export const MAX_EXA_DOMAIN_FILTERS = 16;
export const MAX_EXA_DOMAIN_CHARS = 253;
export const MAX_EXA_TITLE_CHARS = 512;
export const MAX_EXA_URL_CHARS = 2048;
export const MAX_EXA_API_KEY_CHARS = 4096;

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const EXA_MCP_ADVANCED_TOOL = "web_search_advanced_exa";
const EXA_MCP_BASIC_TOOL = "web_search_exa";

interface WebSearchConfig extends WebSettings {
	exaApiKey?: unknown;
}

interface ExaSearchItem {
	title?: unknown;
	url?: unknown;
	publishedDate?: unknown;
	author?: unknown;
	text?: unknown;
	highlights?: unknown;
}

interface ExaSearchResponse {
	results?: ExaSearchItem[];
}

interface ExaMcpRpcResponse {
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	error?: {
		code?: number;
		message?: string;
	};
}

export type ExaSearchResult = SearchResponse | null;

type McpParsedResult = { title: string; url: string; content: string };

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortMessage(message: string): boolean {
	return /abort|cancel/i.test(message);
}

function loadConfig(): WebSearchConfig {
	// Settings are intentionally not cached: a rotated key must take effect on
	// the next request without restarting the extension.
	return readSettings() as WebSearchConfig;
}

function invalidCredential(name: string, reason: string): Error {
	return new Error(`Invalid ${name} configuration: ${reason}`);
}

function validateCredential(name: string, value: unknown): string | null {
	if (value === undefined) return null;
	if (typeof value !== "string") {
		throw invalidCredential(name, "expected a string");
	}
	const normalized = value.trim();
	if (normalized.length === 0) return null;
	if (normalized.length > MAX_EXA_API_KEY_CHARS) {
		throw invalidCredential(name, `exceeds the ${MAX_EXA_API_KEY_CHARS}-character limit`);
	}
	return normalized;
}

function configuredApiKey(settings: WebSearchConfig): string | null {
	if (!Object.prototype.hasOwnProperty.call(settings, "exaApiKey")) return null;
	return validateCredential("exaApiKey", settings.exaApiKey);
}

function environmentApiKey(): string | null {
	if (!Object.prototype.hasOwnProperty.call(process.env, "EXA_API_KEY")) return null;
	return validateCredential("EXA_API_KEY", process.env.EXA_API_KEY);
}

/** Isolated settings take precedence over the process environment. */
function getApiKey(): string | null {
	const configured = configuredApiKey(loadConfig());
	return configured ?? environmentApiKey();
}

function secretsFor(apiKey?: string | null): string[] {
	return [...new Set([
		...configuredSecrets(),
		...(apiKey ? [apiKey] : []),
	])];
}

function rateLimitMessage(provider: "API" | "MCP"): string {
	return provider === "API"
		? "Exa API rate limit reached (429). Retry later."
		: "Exa MCP rate limit reached (429). Retry later or configure exaApiKey.";
}

export function normalizeExaResultCount(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_EXA_RESULTS;
	const count = Math.floor(value);
	return Math.max(1, Math.min(count, MAX_EXA_RESULTS));
}

const RECENCY_FILTERS = new Set<NonNullable<SearchOptions["recencyFilter"]>>(["day", "week", "month", "year"]);
const HOSTNAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function normalizeQuery(query: unknown): string {
	if (typeof query !== "string") throw new Error("Exa query must be a string");
	const normalized = query.trim();
	if (normalized.length === 0) throw new Error("Exa query must not be empty");
	if (normalized.length > MAX_EXA_QUERY_CHARS) {
		throw new Error(`Exa query exceeds the ${MAX_EXA_QUERY_CHARS}-character limit`);
	}
	return normalized;
}

function normalizeDomainFilters(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("Exa domainFilter must be an array");
	if (value.length > MAX_EXA_DOMAIN_FILTERS) {
		throw new Error(`Exa domainFilter is limited to ${MAX_EXA_DOMAIN_FILTERS} entries`);
	}

	const normalized: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") throw new Error("Exa domainFilter entries must be strings");
		const entry = item.trim();
		if (entry.length === 0) continue;
		const excluded = entry.startsWith("-");
		const hostname = (excluded ? entry.slice(1) : entry).trim().toLowerCase();
		if (hostname.length === 0 || hostname.length > MAX_EXA_DOMAIN_CHARS || !HOSTNAME_PATTERN.test(hostname)) {
			throw new Error(`Invalid Exa domainFilter hostname (maximum ${MAX_EXA_DOMAIN_CHARS} characters)`);
		}
		normalized.push(excluded ? `-${hostname}` : hostname);
	}
	return normalized;
}

function normalizeSearchOptions(options: SearchOptions): SearchOptions {
	if (!options || typeof options !== "object" || Array.isArray(options)) {
		throw new Error("Exa search options must be an object");
	}
	const normalized: SearchOptions = {
		...options,
		domainFilter: normalizeDomainFilters(options.domainFilter),
	};
	if (options.recencyFilter !== undefined && !RECENCY_FILTERS.has(options.recencyFilter)) {
		throw new Error("Invalid Exa recencyFilter");
	}
	return normalized;
}

function recencyToStartDate(filter: NonNullable<SearchOptions["recencyFilter"]>): string {
	const offsets: Record<NonNullable<SearchOptions["recencyFilter"]>, number> = {
		day: 1,
		week: 7,
		month: 30,
		year: 365,
	};
	return new Date(Date.now() - offsets[filter] * 86400000).toISOString();
}

function mapDomainFilter(domainFilter: string[] | undefined): {
	includeDomains?: string[];
	excludeDomains?: string[];
} {
	if (!domainFilter?.length) return {};
	const includeDomains: string[] = [];
	const excludeDomains: string[] = [];
	for (const domain of domainFilter) {
		if (domain.startsWith("-")) excludeDomains.push(domain.slice(1));
		else includeDomains.push(domain);
	}
	return {
		...(includeDomains.length > 0 ? { includeDomains } : {}),
		...(excludeDomains.length > 0 ? { excludeDomains } : {}),
	};
}

function exaSearchArgs(query: string, options: SearchOptions): Record<string, unknown> {
	const recency = options.recencyFilter;
	return {
		query,
		type: "auto",
		numResults: normalizeExaResultCount(options.numResults),
		...mapDomainFilter(options.domainFilter),
		...(recency ? { startPublishedDate: recencyToStartDate(recency) } : {}),
	};
}

function boundedText(value: unknown, maximum: number): string {
	if (typeof value !== "string") return "";
	return value.replace(/\s+/g, " ").trim().slice(0, maximum);
}

function boundedMetadata(value: unknown, maximum: number): string {
	if (typeof value !== "string") return "";
	return value.trim().slice(0, maximum);
}

function resultTitle(value: unknown, fallbackIndex: number): string {
	return boundedText(value, MAX_EXA_TITLE_CHARS) || `Source ${fallbackIndex}`;
}

function resultUrl(value: unknown): string {
	return boundedMetadata(value, MAX_EXA_URL_CHARS);
}

function normalizeHighlights(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => boundedText(item, MAX_EXA_HIGHLIGHT_CHARS))
		.filter(Boolean);
}

function resultSnippet(item: ExaSearchItem): string {
	const highlights = normalizeHighlights(item.highlights);
	if (highlights.length > 0) {
		return boundedText(highlights.join(" "), MAX_EXA_HIGHLIGHT_CHARS);
	}
	return boundedText(item.text, MAX_EXA_TEXT_CHARS);
}

function mapResults(results: ExaSearchItem[] | undefined, limit: number): SearchResult[] {
	if (!Array.isArray(results)) return [];
	const mapped: SearchResult[] = [];
	for (const item of results.slice(0, limit)) {
		if (!item) continue;
		const url = resultUrl(item.url);
		if (!url) continue;
		mapped.push({
			title: resultTitle(item.title, mapped.length + 1),
			url,
			snippet: resultSnippet(item),
		});
	}
	return mapped;
}

function toSearchResponse(results: SearchResult[]): SearchResponse {
	return { results };
}

type McpErrorKind = "compatibility" | "rate-limit" | "provider";

class ExaMcpError extends Error {
	readonly kind: McpErrorKind;

	constructor(message: string, kind: McpErrorKind) {
		super(message);
		this.name = "ExaMcpError";
		this.kind = kind;
	}
}

function isCompatibilityMessage(message: string): boolean {
	return /(?:method|tool)\b.*(?:not found|not available|unavailable|unsupported|does not exist)|(?:unknown|unsupported)\s+(?:method|tool)|invalid[-\s]+(?:params?|parameters?|arguments?)/i.test(message);
}

function isMcpRateLimit(code: number | undefined, message: string): boolean {
	return code === 429 || /rate limit|too many requests|\b429\b/i.test(message);
}

function isCompatibilityFailure(error: unknown): boolean {
	return error instanceof ExaMcpError && error.kind === "compatibility";
}

function parseMcpResults(text: string): McpParsedResult[] | null {
	const blocks = text.split(/(?=^Title: )/m).filter((block) => block.trim().length > 0);
	const parsed = blocks.map((block) => {
		const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "";
		const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? "";
		let content = "";
		const textStart = block.indexOf("\nText: ");
		if (textStart >= 0) {
			content = block.slice(textStart + 7).trim();
		} else {
			const highlightsStart = block.match(/\nHighlights:\s*\n/);
			if (highlightsStart?.index != null) {
				content = block.slice(highlightsStart.index + highlightsStart[0].length).trim();
			}
		}
		content = content.replace(/\n---\s*$/, "").trim();
		return { title, url, content };
	}).filter((result) => result.url.length > 0);
	return parsed.length > 0 ? parsed : null;
}

function parseJsonMcpResults(text: string): ExaSearchItem[] | null {
	try {
		const parsed: unknown = JSON.parse(text);
		if (Array.isArray(parsed)) return parsed as ExaSearchItem[];
		if (!parsed || typeof parsed !== "object") return null;
		const results = (parsed as ExaSearchResponse).results;
		return Array.isArray(results) ? results : null;
	} catch {
		return null;
	}
}

function mapMcpResults(results: McpParsedResult[], limit: number): SearchResult[] {
	const mapped: SearchResult[] = [];
	for (const result of results.slice(0, limit)) {
		const url = resultUrl(result.url);
		if (!url) continue;
		mapped.push({
			title: resultTitle(result.title, mapped.length + 1),
			url,
			snippet: boundedText(result.content, MAX_EXA_TEXT_CHARS),
		});
	}
	return mapped;
}

function parseMcpPayload(text: string, limit: number): SearchResponse {
	const jsonResults = parseJsonMcpResults(text);
	if (jsonResults !== null) return toSearchResponse(mapResults(jsonResults, limit));
	const textResults = parseMcpResults(text);
	if (textResults) return toSearchResponse(mapMcpResults(textResults, limit));
	throw new ExaMcpError("Exa MCP returned an invalid search response", "provider");
}

/**
 * Send one MCP JSON-RPC request. The fixed endpoint and shared request guard
 * ensure MCP calls consume the same operation budget as direct Exa calls and
 * page fetches.
 */
export async function callExaMcp(
	toolName: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
	fetch?: FetchImplementation,
): Promise<string> {
	// Validate credential configuration even for the exported low-level MCP seam;
	// invalid values must never silently become keyless fallback.
	getApiKey();
	const secrets = secretsFor();
	const response = await fetchRemoteUrl(EXA_MCP_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Accept": "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: toolName,
				arguments: args,
			},
		}),
		signal,
	}, {
		secrets,
		domainPolicy: { allow: [], deny: [] },
		...(fetch ? { fetch } : {}),
	});

	if (!response.ok) {
		// Consume the bounded body so the guarded response deadline can close,
		// while keeping rate-limit guidance concise and body-free.
		const body = await response.text().catch(() => "");
		if (response.status === 429) throw new ExaMcpError(rateLimitMessage("MCP"), "rate-limit");
		const safeBody = redactText(body, secrets).slice(0, 300);
		const compatibility = response.status < 500 &&
			(response.status === 404 || isCompatibilityMessage(body));
		throw new ExaMcpError(
			`Exa MCP error ${response.status}: ${safeBody}`,
			compatibility ? "compatibility" : "provider",
		);
	}

	const body = redactText(await response.text(), secrets);
	const dataLines = body.split("\n").filter((line) => line.startsWith("data:"));

	let parsed: ExaMcpRpcResponse | null = null;
	for (const line of dataLines) {
		const payload = line.slice(5).trim();
		if (!payload) continue;
		try {
			const candidate = JSON.parse(payload) as ExaMcpRpcResponse;
			if (candidate && (candidate.result !== undefined || candidate.error !== undefined)) {
				parsed = candidate;
				break;
			}
		} catch {
			// SSE streams can include non-JSON event lines; continue to the next one.
		}
	}

	if (!parsed) {
		try {
			const candidate = JSON.parse(body) as ExaMcpRpcResponse;
			if (candidate && (candidate.result !== undefined || candidate.error !== undefined)) {
				parsed = candidate;
			}
		} catch {
		}
	}

	if (!parsed) throw new ExaMcpError("Exa MCP returned an empty response", "provider");

	if (parsed.error) {
		const codeValue = typeof parsed.error.code === "number" ? parsed.error.code : undefined;
		const rawMessage = parsed.error.message || "Unknown error";
		if (isMcpRateLimit(codeValue, rawMessage)) {
			throw new ExaMcpError(rateLimitMessage("MCP"), "rate-limit");
		}
		const code = codeValue === undefined ? "" : ` ${codeValue}`;
		const message = redactText(rawMessage, secrets);
		const compatibility = codeValue === -32601 || codeValue === -32602 || isCompatibilityMessage(rawMessage);
		throw new ExaMcpError(`Exa MCP error${code}: ${message}`, compatibility ? "compatibility" : "provider");
	}

	if (parsed.result?.isError) {
		const message = parsed.result.content
			?.find((item) => item.type === "text" && typeof item.text === "string")
			?.text?.trim() || "Exa MCP returned an error";
		if (isMcpRateLimit(undefined, message)) {
			throw new ExaMcpError(rateLimitMessage("MCP"), "rate-limit");
		}
		const compatibility = isCompatibilityMessage(message);
		throw new ExaMcpError(
			redactText(message, secrets),
			compatibility ? "compatibility" : "provider",
		);
	}

	const text = parsed.result?.content
		?.find((item) => item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0)
		?.text;
	if (!text) throw new ExaMcpError("Exa MCP returned empty content", "provider");
	return text;
}

async function searchWithExaMcpTool(
	tool: string,
	args: Record<string, unknown>,
	options: SearchOptions,
): Promise<SearchResponse> {
	const text = await callExaMcp(tool, args, options.signal, options.fetch);
	return parseMcpPayload(text, normalizeExaResultCount(options.numResults));
}

/**
 * Advanced MCP receives actual Exa filters. Deployments predating the advanced
 * tool are supported by retrying the bounded basic tool with the raw query;
 * filters are not rewritten into query text.
 */
async function searchWithFilteredExaMcp(
	query: string,
	options: SearchOptions,
): Promise<SearchResponse | null> {
	try {
		return await searchWithExaMcpTool(EXA_MCP_ADVANCED_TOOL, {
			...exaSearchArgs(query, options),
			enableHighlights: true,
			textMaxCharacters: MAX_EXA_TEXT_CHARS,
		}, options);
	} catch (err) {
		if (!isCompatibilityFailure(err)) throw err;
		return searchWithExaMcpTool(EXA_MCP_BASIC_TOOL, {
			query,
			numResults: normalizeExaResultCount(options.numResults),
		}, options);
	}
}

async function searchWithExaMcp(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const activityId = activityMonitor.logStart({ type: "api", query });
	const hasRealFilters = !!options.recencyFilter || !!options.domainFilter?.some((item) =>
		typeof item === "string" && item.trim().length > 0,
	);
	try {
		const response = hasRealFilters
			? await searchWithFilteredExaMcp(query, options)
			: await searchWithExaMcpTool(EXA_MCP_BASIC_TOOL, {
				query,
				numResults: normalizeExaResultCount(options.numResults),
			}, options);
		activityMonitor.logComplete(activityId, 200);
		return response;
	} catch (err) {
		const message = redactText(errorText(err), secretsFor());
		if (isAbortMessage(message)) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, message);
		throw redactError(message, secretsFor());
	}
}

export function isExaAvailable(): boolean {
	// Keyless MCP is an intentional provider mode; availability does not depend
	// on a local usage file or an API key.
	return true;
}

export function hasExaApiKey(): boolean {
	return !!getApiKey();
}

export async function searchWithExa(query: string, options: SearchOptions = {}): Promise<ExaSearchResult> {
	const normalizedQuery = normalizeQuery(query);
	const normalizedOptions = normalizeSearchOptions(options);
	const apiKey = getApiKey();
	if (!apiKey) return searchWithExaMcp(normalizedQuery, normalizedOptions);

	const activityId = activityMonitor.logStart({ type: "api", query: normalizedQuery });
	try {
		const response = await fetchRemoteUrl(EXA_SEARCH_URL, {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				...exaSearchArgs(normalizedQuery, normalizedOptions),
				contents: {
					text: { maxCharacters: MAX_EXA_TEXT_CHARS },
					highlights: { maxCharacters: MAX_EXA_HIGHLIGHT_CHARS },
				},
			}),
			signal: normalizedOptions.signal,
		}, {
			secrets: [apiKey],
			domainPolicy: { allow: [], deny: [] },
			...(normalizedOptions.fetch ? { fetch: normalizedOptions.fetch } : {}),
		});

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			if (response.status === 429) throw new Error(rateLimitMessage("API"));
			throw new Error(`Exa API error ${response.status}: ${redactText(body, secretsFor(apiKey)).slice(0, 300)}`);
		}

		const data = await response.json() as ExaSearchResponse;
		activityMonitor.logComplete(activityId, response.status);
		return toSearchResponse(mapResults(data.results, normalizeExaResultCount(normalizedOptions.numResults)));
	} catch (err) {
		const message = redactText(errorText(err), secretsFor(apiKey));
		if (isAbortMessage(message)) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, message);
		throw redactError(message, secretsFor(apiKey));
	}
}
