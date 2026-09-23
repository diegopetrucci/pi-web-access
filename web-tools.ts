import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { fetchAllContent, type ExtractedContent } from "./extract.ts";
import type { FetchImplementation } from "./ssrf-protection.ts";
import {
	DEFAULT_MAX_INLINE_CONTENT_CHARS,
	getMaxInlineContentChars,
	MAX_INLINE_CONTENT_CHARS,
	MIN_INLINE_CONTENT_CHARS,
	requireAgentDir,
} from "./settings.ts";
import { resetRequestOperations } from "./request-budget.ts";
import {
	MAX_EXA_QUERIES,
	MAX_EXA_QUERY_CHARS,
	MAX_EXA_RESULTS,
	MAX_EXA_URL_CHARS,
	searchWithExa,
	type SearchResult,
} from "./exa.ts";
import {
	clearResults,
	generateId,
	getResult,
	restoreFromSession,
	storeResult,
	storeFetchedContentResult,
	type QueryResultData,
	type StoredSearchData,
} from "./storage.ts";

const MAX_URLS = 6;
const MAX_DOMAIN_FILTERS = 16;
const MAX_SEARCH_OUTPUT_CHARS = 16_000;
const MAX_FIND_TEXT_CHARS = 500;
const MAX_FIND_MATCHES = 5;
const MAX_FIND_OUTPUT_CHARS = 8_000;
const MAX_DIAGNOSTIC_CHARS = 600;
const MAX_OFFSET = 128 * 1024 * 1024;
const CONTEXT_CHARS = 400;

function StringEnum<T extends string[]>(values: T, options?: { description?: string; default?: T[number] }) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}

function boundedDiagnostic(value: unknown): string {
	const message = value instanceof Error ? value.message : String(value);
	const normalized = message.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
	return normalized.slice(0, MAX_DIAGNOSTIC_CHARS) || "Request failed";
}

function normalizeQueryList(queryList: unknown[]): string[] {
	const normalized: string[] = [];
	for (const query of queryList) {
		if (typeof query !== "string") continue;
		const trimmed = query.trim();
		if (trimmed.length > 0 && trimmed.length <= MAX_EXA_QUERY_CHARS) normalized.push(trimmed);
		if (normalized.length >= MAX_EXA_QUERIES) break;
	}
	return normalized;
}

function normalizeUrlList(params: Record<string, unknown>): string[] {
	const raw = Array.isArray(params.urls)
		? params.urls
		: params.url !== undefined ? [params.url] : [];
	const normalized: string[] = [];
	for (const value of raw) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (!trimmed || trimmed.length > MAX_EXA_URL_CHARS) continue;
		normalized.push(trimmed);
		if (normalized.length >= MAX_URLS) break;
	}
	return normalized;
}

function formatSearchSummary(results: SearchResult[]): string {
	if (results.length === 0) return "No results found.";
	return results.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}`).join("\n\n");
}

function formatFullResults(queryData: QueryResultData): string {
	let output = `## Results for: "${queryData.query}"\n\n`;
	for (const result of queryData.results) {
		output += `### ${result.title}\n${result.url}`;
		if (result.snippet) output += `\n\n${result.snippet}`;
		output += "\n\n";
	}
	return output.trimEnd();
}

function lineAwareEnd(text: string, start: number, desiredEnd: number): number {
	const boundedEnd = Math.min(text.length, Math.max(start + 1, desiredEnd));
	if (boundedEnd >= text.length) return text.length;
	const boundary = text.lastIndexOf("\n", boundedEnd - 1);
	const minimum = start + Math.max(1, Math.floor((boundedEnd - start) * 0.8));
	return boundary >= minimum ? boundary + 1 : boundedEnd;
}

interface PageSlice {
	text: string;
	endOffset: number;
	returnedChars: number;
	hasMore: boolean;
}

/** Keep a continuation page line-aware while reserving space for its guidance. */
function makePageSlice(
	content: string,
	offset: number,
	limit: number,
	maxOutput: number,
	prefix: string,
	continuation: (nextOffset: number) => string,
): PageSlice {
	const outputLimit = Math.max(1, Math.floor(maxOutput));
	const sourceLimit = Math.max(1, Math.floor(limit));
	const remaining = content.length - offset;

	if (remaining <= 0) {
		const suffix = offset > 0 ? `\n\n[Showing ${offset}-${content.length} of ${content.length}.]` : "";
		const prefixBudget = Math.max(0, outputLimit - suffix.length);
		const visiblePrefix = prefix.length <= prefixBudget ? prefix : "";
		return {
			text: `${visiblePrefix}${suffix}`.slice(0, outputLimit),
			endOffset: offset,
			returnedChars: 0,
			hasMore: false,
		};
	}

	let end = lineAwareEnd(content, offset, Math.min(content.length, offset + sourceLimit));
	end = Math.max(offset + 1, Math.min(content.length, end));
	for (let attempt = 0; attempt < 64; attempt += 1) {
		const hasMore = end < content.length;
		const suffix = hasMore
			? continuation(end)
			: offset > 0 ? `\n\n[Showing ${offset}-${end} of ${content.length}.]` : "";
		// Reserve both the continuation guidance and one source character before
		// showing a title. A title that cannot fit is omitted rather than allowed
		// to consume the entire page and strand the continuation offset.
		const prefixBudget = outputLimit - suffix.length - 1;
		const visiblePrefix = prefix.length <= prefixBudget ? prefix : "";
		const sourceBudget = outputLimit - visiblePrefix.length - suffix.length;
		if (sourceBudget >= 1) {
			const desiredEnd = Math.min(content.length, offset + sourceLimit, offset + sourceBudget);
			let fittedEnd = lineAwareEnd(content, offset, desiredEnd);
			fittedEnd = Math.max(offset + 1, Math.min(content.length, fittedEnd));
			if (fittedEnd !== end) {
				end = fittedEnd;
				continue;
			}

			const text = `${visiblePrefix}${content.slice(offset, end)}${suffix}`;
			if (text.length <= outputLimit) {
				return { text, endOffset: end, returnedChars: end - offset, hasMore };
			}
		}

		const nextEnd = Math.max(offset + 1, end - 1);
		if (nextEnd === end) break;
		end = nextEnd;
	}

	// The configured minimum leaves room for the bounded continuation handle,
	// but retain the progress invariant even if formatting changes later.
	const endOffset = Math.min(content.length, offset + 1);
	const hasMore = endOffset < content.length;
	const suffix = hasMore
		? continuation(endOffset)
		: offset > 0 ? `\n\n[Showing ${offset}-${endOffset} of ${content.length}.]` : "";
	const visiblePrefix = prefix.length <= outputLimit - suffix.length - 1 ? prefix : "";
	const text = `${visiblePrefix}${content.slice(offset, endOffset)}${suffix}`;
	return { text, endOffset, returnedChars: 1, hasMore };
}

function boundSearchOutput(text: string, responseId?: string): { text: string; truncated: boolean; returnedChars: number } {
	const continuation = responseId
		? `\n\n[More: get_search_content({responseId:"${responseId}",queryIndex:0})]`
		: "";
	if (text.length + continuation.length <= MAX_SEARCH_OUTPUT_CHARS) {
		return { text: `${text}${continuation}`, truncated: false, returnedChars: text.length };
	}
	const marker = responseId
		? `\n\n[Truncated; get_search_content({responseId:"${responseId}",queryIndex:0})]`
		: "\n\n[Truncated.]";
	let end = lineAwareEnd(text, 0, Math.max(0, MAX_SEARCH_OUTPUT_CHARS - marker.length));
	for (let attempt = 0; attempt < 16; attempt += 1) {
		const output = `${text.slice(0, end)}${marker}`;
		if (output.length <= MAX_SEARCH_OUTPUT_CHARS) {
			return { text: output, truncated: true, returnedChars: end };
		}
		const available = Math.max(0, MAX_SEARCH_OUTPUT_CHARS - marker.length);
		const next = Math.max(0, Math.min(end - 1, available));
		if (next === end) break;
		end = lineAwareEnd(text, 0, next);
	}
	const returnedChars = Math.max(0, MAX_SEARCH_OUTPUT_CHARS - marker.length);
	return { text: `${text.slice(0, returnedChars)}${marker}`.slice(0, MAX_SEARCH_OUTPUT_CHARS), truncated: true, returnedChars };
}

interface FindResult {
	text: string;
	matchCount: number;
	returnedMatches: number;
}

function findLiteralPassages(source: string, needle: string): FindResult {
	const haystack = source.toLocaleLowerCase();
	const target = needle.toLocaleLowerCase();
	const matches: Array<{ start: number; end: number }> = [];
	for (let index = haystack.indexOf(target); index >= 0; index = haystack.indexOf(target, index + Math.max(1, target.length))) {
		matches.push({ start: index, end: index + needle.length });
	}
	if (matches.length === 0) return { text: "No matching text found.", matchCount: 0, returnedMatches: 0 };

	const ranges = matches.slice(0, MAX_FIND_MATCHES).map((match) => ({
		start: Math.max(0, match.start - CONTEXT_CHARS),
		end: Math.min(source.length, match.end + CONTEXT_CHARS),
	}));
	const sections = [`Case-insensitive matches for ${JSON.stringify(needle)} (${matches.length} total):`];
	for (const [index, range] of ranges.entries()) {
		const prefix = range.start > 0 ? "…" : "";
		const suffix = range.end < source.length ? "…" : "";
		sections.push(`${index + 1}. ${prefix}${source.slice(range.start, range.end).replace(/\s+/g, " ").trim()}${suffix}`);
	}
	if (matches.length > ranges.length) sections.push(`Showing ${ranges.length} of ${matches.length} matches.`);
	const text = sections.join("\n\n");
	return {
		text: text.length <= MAX_FIND_OUTPUT_CHARS ? text : text.slice(0, MAX_FIND_OUTPUT_CHARS),
		matchCount: matches.length,
		returnedMatches: ranges.length,
	};
}

function inputValue(value: unknown): string {
	if (typeof value === "string") return value.slice(0, 120);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "invalid";
}

function errorResult(text: string, details: Record<string, unknown>): Record<string, unknown> {
	return { content: [{ type: "text", text }], details };
}

function textFromResult(result: any): string {
	const parts = result?.content as Array<{ type?: string; text?: string }> | undefined;
	const part = parts?.find((candidate) => candidate?.type === "text");
	return typeof part?.text === "string" ? part.text : "";
}

export interface WebToolsOptions {
	/** Explicit transport for focused runtime integration tests; production omits it. */
	fetch?: FetchImplementation;
}

export default function (pi: ExtensionAPI, options: WebToolsOptions = {}) {
	function storeAndPublishSearch(results: QueryResultData[]): string {
		const id = generateId();
		const data: StoredSearchData = {
			id,
			type: "search",
			timestamp: Date.now(),
			queries: results,
		};
		storeResult(id, data);
		pi.appendEntry("web-search-results", data);
		return id;
	}

	function appendFetchedResult(responseId: string, results: ExtractedContent[]): StoredSearchData {
		const data: StoredSearchData = {
			id: responseId,
			type: "fetch",
			timestamp: Date.now(),
			urls: results,
		};
		const sessionData = storeFetchedContentResult(responseId, data as StoredSearchData & { type: "fetch"; urls: ExtractedContent[] });
		pi.appendEntry("web-search-results", sessionData);
		return sessionData;
	}

	pi.on("agent_start", () => {
		resetRequestOperations();
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreFromSession(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		restoreFromSession(ctx);
	});
	pi.on("session_shutdown", () => {
		clearResults();
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web with Exa and return source citations.",
		promptSnippet: "Use for one focused web search.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ maxLength: MAX_EXA_QUERY_CHARS, description: "One focused search query." })),
			queries: Type.Optional(Type.Array(Type.String({ maxLength: MAX_EXA_QUERY_CHARS }), { maxItems: MAX_EXA_QUERIES, description: "Optional batch of up to 4 queries." })),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_EXA_RESULTS, default: 5, description: "Results per query; default 5." })),
			recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"], { description: "Limit by publication age." })),
			domainFilter: Type.Optional(Type.Array(Type.String({ maxLength: 253 }), { maxItems: MAX_DOMAIN_FILTERS, description: "Limit to up to 16 domains." })),
		}),

		async execute(_toolCallId, params, signal, onUpdate): Promise<any> {
			requireAgentDir();
			const rawQueryList: unknown[] = Array.isArray(params.queries)
				? params.queries
				: (params.query !== undefined ? [params.query] : []);
			const queryList = normalizeQueryList(rawQueryList);
			if (queryList.length === 0) {
				return errorResult("Error: No query provided.", { error: "No query provided" });
			}

			const searchResults: QueryResultData[] = new Array(queryList.length);
			let nextIndex = 0;
			const searchOne = async (): Promise<void> => {
				while (true) {
					const index = nextIndex++;
					if (index >= queryList.length) return;
					const query = queryList[index];
					onUpdate?.({
						content: [{ type: "text", text: `Searching ${index + 1}/${queryList.length}...` }],
						details: { phase: "search", progress: index / queryList.length },
					});
					try {
						const result = await searchWithExa(query, {
							numResults: params.numResults,
							recencyFilter: params.recencyFilter as "day" | "week" | "month" | "year" | undefined,
							domainFilter: params.domainFilter,
							signal,
							...(options.fetch ? { fetch: options.fetch } : {}),
						});
						searchResults[index] = result
							? { query, results: result.results, error: null }
							: { query, results: [], error: "No results returned" };
					} catch (err) {
						searchResults[index] = { query, results: [], error: boundedDiagnostic(err) };
					}
				}
			};
			await Promise.all(Array.from({ length: Math.min(3, queryList.length) }, () => searchOne()));

			let output = "";
			for (const result of searchResults) {
				if (queryList.length > 1) output += `## Query: "${result.query}"\n\n`;
				if (result.error) output += "Search failed for this query.\n\n";
				else output += `${formatSearchSummary(result.results)}\n\n`;
			}
			output = output.trim();

			const searchId = storeAndPublishSearch(searchResults);
			const hasStoredMaterial = searchResults.some((result) => !result.error && result.results.length > 0);
			const omittedMaterial = searchResults.some((result) => !result.error && result.results.some((source) => source.snippet.length > 0));
			const needsRetrieval = hasStoredMaterial && (omittedMaterial || output.length > MAX_SEARCH_OUTPUT_CHARS);
			const presentation = boundSearchOutput(output, needsRetrieval ? searchId : undefined);
			const errors = searchResults
				.filter((result) => result.error)
				.map((result) => ({ query: result.query.slice(0, MAX_EXA_QUERY_CHARS), error: boundedDiagnostic(result.error) }));
			return {
				content: [{ type: "text", text: presentation.text }],
				details: {
					queries: queryList,
					queryCount: queryList.length,
					successfulQueries: searchResults.filter((result) => !result.error).length,
					totalResults: searchResults.reduce((sum, result) => sum + result.results.length, 0),
					...(errors.length > 0 ? { errors } : {}),
					...(needsRetrieval ? { responseId: searchId } : {}),
					...(presentation.truncated ? { truncated: true, originalChars: output.length, returnedChars: presentation.returnedChars } : {}),
				},
			};
		},

		renderCall(args, theme) {
			const input = args as { query?: unknown; queries?: unknown };
			const rawQueryList: unknown[] = Array.isArray(input.queries)
				? input.queries
				: input.query !== undefined ? [input.query] : [];
			const queryList = normalizeQueryList(rawQueryList);
			if (queryList.length === 0) return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("error", "(no query)"), 0, 0);
			if (queryList.length === 1) {
				const display = queryList[0].length > 60 ? queryList[0].slice(0, 57) + "..." : queryList[0];
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${display}"`), 0, 0);
			}
			return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `${queryList.length} queries`), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = (result?.details ?? {}) as {
				queryCount?: number;
				successfulQueries?: number;
				totalResults?: number;
				errors?: Array<{ query?: string; error?: string }>;
				error?: string;
				phase?: string;
				progress?: number;
			};
			if (isPartial) {
				const progress = details.progress ?? 0;
				const bar = "█".repeat(Math.floor(progress * 10)) + "░".repeat(10 - Math.floor(progress * 10));
				return new Text(theme.fg("accent", `[${bar}] ${details.phase || "searching"}`), 0, 0);
			}
			if (details.error) return new Text(theme.fg("error", `Error: ${boundedDiagnostic(details.error)}`), 0, 0);
			const queryInfo = details.queryCount === 1 ? "" : `${details.successfulQueries ?? 0}/${details.queryCount ?? 0} queries, `;
			const status = theme.fg("success", `${queryInfo}${details.totalResults ?? 0} sources`);
			if (!expanded) return new Text(status, 0, 0);
			const lines = [status];
			for (const diagnostic of details.errors?.slice(0, 4) ?? []) {
				lines.push(theme.fg("error", `${diagnostic.query ?? "query"}: ${boundedDiagnostic(diagnostic.error)}`));
			}
			const text = textFromResult(result);
			if (text) lines.push(theme.fg("dim", text.slice(0, 500)));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description: "Fetch up to 6 URLs and extract readable content as Markdown.",
		promptSnippet: "Use to fetch readable content from a URL.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ maxLength: MAX_EXA_URL_CHARS, description: "One URL to fetch." })),
			urls: Type.Optional(Type.Array(Type.String({ maxLength: MAX_EXA_URL_CHARS }), { maxItems: MAX_URLS, description: "Up to 6 URLs." })),
		}),

		async execute(_toolCallId, params, signal, onUpdate): Promise<any> {
			requireAgentDir();
			const maxInlineContentChars = getMaxInlineContentChars();
			const urlList = normalizeUrlList(params as Record<string, unknown>);
			if (urlList.length === 0) return errorResult("Error: No URL provided.", { error: "No URL provided" });

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }],
				details: { phase: "fetch", progress: 0 },
			});

			let fetchResults: ExtractedContent[];
			try {
				fetchResults = await fetchAllContent(urlList, signal, {
					toolNames: { webSearch: "web_search", fetchContent: "fetch_content" },
					...(options.fetch ? { fetch: options.fetch } : {}),
				});
			} catch (err) {
				return errorResult("Unable to fetch content.", { error: boundedDiagnostic(err), urls: urlList });
			}
			const successful = fetchResults.filter((result) => !result.error).length;
			const totalChars = fetchResults.reduce((sum, result) => sum + result.content.length, 0);
			const responseId = generateId();
			const sessionData = appendFetchedResult(responseId, fetchResults);
			const hasStoredMaterial = fetchResults.some((result) => !result.error && result.content.length > 0);
			const diagnostics = fetchResults
				.filter((result) => result.error)
				.map((result) => ({ url: result.url.slice(0, MAX_EXA_URL_CHARS), error: boundedDiagnostic(result.error) }));
			const cacheError = sessionData.fetchCacheError ? boundedDiagnostic(sessionData.fetchCacheError) : undefined;

			if (urlList.length === 1) {
				const result = fetchResults[0];
				if (result.error) {
					return errorResult("Unable to fetch content.", {
						urls: urlList,
						urlCount: 1,
						successful: 0,
						error: boundedDiagnostic(result.error),
						...(cacheError ? { cacheError } : {}),
					});
				}

				const page = makePageSlice(
					result.content,
					0,
					maxInlineContentChars,
					maxInlineContentChars,
					"",
					(nextOffset) => `[More: get_search_content({responseId:"${responseId}",urlIndex:0,offset:${nextOffset}})]`,
				);
				return {
					content: [{ type: "text", text: page.text }],
					details: {
						urls: urlList,
						urlCount: 1,
						successful: 1,
						totalChars: result.content.length,
						title: result.title,
						truncated: page.hasMore,
						...(page.hasMore && hasStoredMaterial ? { responseId } : {}),
						...(cacheError ? { cacheError } : {}),
					},
				};
			}

			let summary = "## Fetched URLs\n\n";
			for (const result of fetchResults) {
				if (result.error) summary += `- ${result.url}: Fetch failed.\n`;
				else summary += `- ${result.title || result.url} (${result.content.length} chars)\n`;
			}
			const marker = hasStoredMaterial
				? `\n[Stored: get_search_content({responseId:"${responseId}",urlIndex:0})]`
				: "";
			const bounded = boundSearchOutput(`${summary.trimEnd()}${marker}`);
			return {
				content: [{ type: "text", text: bounded.text }],
				details: {
					urls: urlList,
					urlCount: urlList.length,
					successful,
					totalChars,
					...(hasStoredMaterial ? { responseId } : {}),
					...(bounded.truncated ? { truncated: true } : {}),
					...(diagnostics.length > 0 ? { errors: diagnostics } : {}),
					...(cacheError ? { cacheError } : {}),
				},
			};
		},

		renderCall(args, theme) {
			const urlList = normalizeUrlList(args as Record<string, unknown>);
			if (urlList.length === 0) return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"), 0, 0);
			if (urlList.length === 1) {
				const display = urlList[0].length > 60 ? urlList[0].slice(0, 57) + "..." : urlList[0];
				return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", display), 0, 0);
			}
			return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", `${urlList.length} URLs`), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = (result?.details ?? {}) as {
				urlCount?: number;
				successful?: number;
				error?: string;
				totalChars?: number;
				title?: string;
				truncated?: boolean;
				errors?: Array<{ url?: string; error?: string }>;
				cacheError?: string;
				phase?: string;
				progress?: number;
			};
			if (isPartial) {
				const progress = details.progress ?? 0;
				const bar = "█".repeat(Math.floor(progress * 10)) + "░".repeat(10 - Math.floor(progress * 10));
				return new Text(theme.fg("accent", `[${bar}] ${details.phase || "fetching"}`), 0, 0);
			}
			if (details.error) return new Text(theme.fg("error", `Error: ${boundedDiagnostic(details.error)}`), 0, 0);
			if (details.urlCount === 1) {
				let status = theme.fg("success", details.title || "Content") + theme.fg("muted", ` (${details.totalChars ?? 0} chars)`);
				if (details.truncated) status += theme.fg("warning", " [truncated]");
				if (!expanded) return new Text(status, 0, 0);
				const text = textFromResult(result);
				const cache = details.cacheError ? `\n${theme.fg("error", `Cache: ${boundedDiagnostic(details.cacheError)}`)}` : "";
				return new Text(`${status}${cache}\n${theme.fg("dim", text.slice(0, 500))}`, 0, 0);
			}
			const color = (details.successful ?? 0) > 0 ? "success" : "error";
			const status = theme.fg(color, `${details.successful ?? 0}/${details.urlCount ?? 0} URLs`);
			if (!expanded) return new Text(status, 0, 0);
			const lines = [status];
			for (const diagnostic of details.errors?.slice(0, 6) ?? []) {
				lines.push(theme.fg("error", `${diagnostic.url ?? "URL"}: ${boundedDiagnostic(diagnostic.error)}`));
			}
			if (details.cacheError) lines.push(theme.fg("error", `Cache: ${boundedDiagnostic(details.cacheError)}`));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerTool({
		name: "get_search_content",
		label: "Get Search Content",
		description: "Retrieve bounded stored search or fetched content.",
		promptSnippet: "Use for a bounded continuation or a literal text match.",
		parameters: Type.Object({
			responseId: Type.String({ minLength: 1, maxLength: 256, description: "Stored response ID." }),
			query: Type.Optional(Type.String({ maxLength: MAX_EXA_QUERY_CHARS, description: "Select a stored query." })),
			queryIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_EXA_QUERIES - 1, description: "Stored query index." })),
			url: Type.Optional(Type.String({ maxLength: MAX_EXA_URL_CHARS, description: "Select a stored URL." })),
			urlIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_URLS - 1, description: "Stored URL index." })),
			offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_OFFSET, description: "Character offset for the next slice." })),
			limit: Type.Optional(Type.Integer({ minimum: MIN_INLINE_CONTENT_CHARS, maximum: MAX_INLINE_CONTENT_CHARS, default: DEFAULT_MAX_INLINE_CONTENT_CHARS, description: "Maximum returned characters; default 12000." })),
			findText: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_FIND_TEXT_CHARS, description: "One literal, case-insensitive text match." })),
		}),

		async execute(_toolCallId, rawParams): Promise<any> {
			requireAgentDir();
			const maxInlineContentChars = getMaxInlineContentChars();
			const params = rawParams as Record<string, unknown>;
			const responseId = typeof params.responseId === "string" ? params.responseId : "";
			if (!responseId || responseId.length > 256) return errorResult("Error: A valid response ID is required.", { error: "Invalid responseId" });

			const findText = params.findText;
			if (findText !== undefined && (typeof findText !== "string" || findText.length === 0 || findText.length > MAX_FIND_TEXT_CHARS || findText.trim().length === 0)) {
				return errorResult("Error: Invalid findText.", { error: "findText must be one non-empty bounded string" });
			}
			const data = getResult(responseId);
			if (!data) return errorResult("Stored content was not found.", { error: "Not found", responseId });

			if (data.type === "search" && Array.isArray(data.queries)) {
				let queryData: QueryResultData | undefined;
				let queryIndex = -1;
				if (typeof params.query === "string" && params.query.length > 0) {
					queryIndex = data.queries.findIndex((query) => query.query === params.query);
					queryData = queryIndex >= 0 ? data.queries[queryIndex] : undefined;
				} else if (typeof params.queryIndex === "number" && Number.isInteger(params.queryIndex)) {
					queryIndex = params.queryIndex;
					queryData = data.queries[queryIndex];
				}
				if (!queryData) {
					return errorResult(
						params.query !== undefined || params.queryIndex !== undefined ? "Stored query was not found." : "Specify query or queryIndex.",
						{
							error: params.query !== undefined || params.queryIndex !== undefined ? "Query not found" : "No query specified",
							availableQueries: data.queries.slice(0, MAX_EXA_QUERIES).map((query, index) => ({ index, query: query.query.slice(0, MAX_EXA_QUERY_CHARS) })),
						},
					);
				}
				if (!Array.isArray(queryData.results)) return errorResult("Stored search content is invalid.", { error: "Invalid query data" });
				if (queryData.error) return errorResult("Stored search query failed.", { error: boundedDiagnostic(queryData.error), query: queryData.query });

				const fullResults = formatFullResults(queryData);
				if (typeof findText === "string") {
					const found = findLiteralPassages(fullResults, findText);
					return {
						content: [{ type: "text", text: found.text }],
						details: { responseId, query: queryData.query.slice(0, MAX_EXA_QUERY_CHARS), resultCount: queryData.results.length, contentLength: fullResults.length, matchCount: found.matchCount, returnedMatches: found.returnedMatches },
					};
				}

				const offset = params.offset === undefined ? 0 : params.offset;
				const limit = params.limit === undefined ? maxInlineContentChars : params.limit;
				if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > fullResults.length || offset > MAX_OFFSET) {
					return errorResult("Error: Invalid content offset.", { error: "Invalid offset", offset: inputValue(offset), contentLength: fullResults.length });
				}
				if (typeof limit !== "number" || !Number.isInteger(limit) || limit < MIN_INLINE_CONTENT_CHARS || limit > maxInlineContentChars) {
					return errorResult("Error: Invalid content limit.", { error: "Invalid limit", limit: inputValue(limit), minLimit: MIN_INLINE_CONTENT_CHARS, maxLimit: maxInlineContentChars });
				}
				const page = makePageSlice(
					fullResults,
					offset,
					limit,
					maxInlineContentChars,
					"",
					(nextOffset) => `[More: get_search_content({responseId:"${responseId}",queryIndex:${queryIndex},offset:${nextOffset}})]`,
				);
				return {
					content: [{ type: "text", text: page.text }],
					details: { responseId, query: queryData.query.slice(0, MAX_EXA_QUERY_CHARS), resultCount: queryData.results.length, contentLength: fullResults.length, offset, limit, returnedChars: page.returnedChars, nextOffset: page.hasMore ? page.endOffset : null, truncated: page.hasMore },
				};
			}

			if (data.type === "fetch" && Array.isArray(data.urls)) {
				let urlData: ExtractedContent | undefined;
				let urlIndex = -1;
				if (typeof params.url === "string" && params.url.length > 0) {
					urlIndex = data.urls.findIndex((url) => url.url === params.url);
					urlData = urlIndex >= 0 ? data.urls[urlIndex] : undefined;
				} else if (typeof params.urlIndex === "number" && Number.isInteger(params.urlIndex)) {
					urlIndex = params.urlIndex;
					urlData = data.urls[urlIndex];
				}
				if (!urlData) {
					return errorResult(
						params.url !== undefined || params.urlIndex !== undefined ? "Stored URL was not found." : "Specify url or urlIndex.",
						{
							error: params.url !== undefined || params.urlIndex !== undefined ? "URL not found" : "No URL specified",
							availableUrls: data.urls.slice(0, MAX_URLS).map((url, index) => ({ index, url: url.url.slice(0, MAX_EXA_URL_CHARS) })),
						},
					);
				}
				if (urlData.error) return errorResult("Stored fetched content is unavailable.", { error: boundedDiagnostic(urlData.error), url: urlData.url });

				if (typeof findText === "string") {
					const found = findLiteralPassages(urlData.content, findText);
					const heading = urlData.title ? `# ${urlData.title}\n\n` : "";
					const text = `${heading}${found.text}`.slice(0, MAX_FIND_OUTPUT_CHARS);
					return {
						content: [{ type: "text", text }],
						details: { responseId, url: urlData.url, title: urlData.title, contentLength: urlData.content.length, matchCount: found.matchCount, returnedMatches: found.returnedMatches },
					};
				}

				const offset = params.offset === undefined ? 0 : params.offset;
				const limit = params.limit === undefined ? maxInlineContentChars : params.limit;
				if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > urlData.content.length || offset > MAX_OFFSET) {
					return errorResult("Error: Invalid content offset.", { error: "Invalid offset", offset: inputValue(offset), contentLength: urlData.content.length });
				}
				if (typeof limit !== "number" || !Number.isInteger(limit) || limit < MIN_INLINE_CONTENT_CHARS || limit > maxInlineContentChars) {
					return errorResult("Error: Invalid content limit.", { error: "Invalid limit", limit: inputValue(limit), minLimit: MIN_INLINE_CONTENT_CHARS, maxLimit: maxInlineContentChars });
				}
				const heading = urlData.title ? `# ${urlData.title}\n\n` : "";
				const page = makePageSlice(
					urlData.content,
					offset,
					limit,
					maxInlineContentChars,
					heading,
					(nextOffset) => `[More: get_search_content({responseId:"${responseId}",urlIndex:${urlIndex},offset:${nextOffset}})]`,
				);
				return {
					content: [{ type: "text", text: page.text }],
					details: { responseId, url: urlData.url, title: urlData.title, contentLength: urlData.content.length, offset, limit, returnedChars: page.returnedChars, nextOffset: page.hasMore ? page.endOffset : null, truncated: page.hasMore },
				};
			}

			return errorResult("Stored content has an invalid format.", { error: "Invalid data" });
		},

		renderCall(args, theme) {
			const input = args as { responseId?: string; query?: string; queryIndex?: number; url?: string; urlIndex?: number; offset?: number; findText?: string };
			let target = "";
			if (input.query) target = `query="${input.query.slice(0, 30)}"`;
			else if (input.queryIndex !== undefined) target = `queryIndex=${input.queryIndex}`;
			else if (input.url) target = input.url.length > 30 ? input.url.slice(0, 27) + "..." : input.url;
			else if (input.urlIndex !== undefined) target = `urlIndex=${input.urlIndex}`;
			if (input.offset !== undefined) target += `${target ? " @ " : "offset="}${input.offset}`;
			if (input.findText !== undefined) target += `${target ? " · " : ""}find`;
			const id = typeof input.responseId === "string" ? input.responseId.slice(0, 8) : "stored";
			return new Text(theme.fg("toolTitle", theme.bold("get_content ")) + theme.fg("accent", target || id), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = (result?.details ?? {}) as { error?: string; query?: string; url?: string; title?: string; resultCount?: number; contentLength?: number; matchCount?: number; returnedMatches?: number };
			if (details.error) return new Text(theme.fg("error", `Error: ${boundedDiagnostic(details.error)}`), 0, 0);
			const status = details.query
				? theme.fg("success", `"${details.query}"`) + theme.fg("muted", ` (${details.resultCount ?? 0} results)`)
				: theme.fg("success", details.title || "Content") + theme.fg("muted", ` (${details.contentLength ?? 0} chars)`);
			if (!expanded) return new Text(status, 0, 0);
			const text = textFromResult(result);
			const matchInfo = details.matchCount === undefined ? "" : `\n${details.returnedMatches ?? 0}/${details.matchCount} passages`;
			return new Text(`${status}${matchInfo}\n${theme.fg("dim", text.slice(0, 500))}`, 0, 0);
		},
	});
}
