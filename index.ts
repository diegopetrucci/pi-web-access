import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { fetchAllContent, type ExtractedContent } from "./extract.js";
import { searchWithExa, isExaAvailable, type SearchResult } from "./exa.js";
import { createRequestGuard, type RequestGuard } from "./request-guard.js";
import {
	clearResults,
	generateId,
	getResult,
	restoreFromSession,
	storeResult,
	type QueryResultData,
	type StoredSearchData,
} from "./storage.js";

function normalizeQueryList(queryList: unknown[]): string[] {
	const normalized: string[] = [];
	for (const query of queryList) {
		if (typeof query !== "string") continue;
		const trimmed = query.trim();
		if (trimmed.length > 0) normalized.push(trimmed);
	}
	return normalized;
}

function formatSearchSummary(results: SearchResult[], answer: string): string {
	let output = answer ? `${answer}\n\n---\n\n**Sources:**\n` : "";
	output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
	return output;
}

function formatFullResults(queryData: QueryResultData): string {
	let output = `## Results for: "${queryData.query}"\n\n`;
	if (queryData.answer) {
		output += `${queryData.answer}\n\n---\n\n`;
	}
	for (const r of queryData.results) {
		output += `### ${r.title}\n${r.url}\n\n`;
	}
	return output;
}

function stripThumbnails(results: ExtractedContent[]): ExtractedContent[] {
	return results;
}

const MAX_INLINE_CONTENT = 30000;

const pendingFetches = new Map<string, AbortController>();
let sessionActive = false;

// ── Per-agent-turn shared request guard ───────────────────────────────────────
// The spec requires that the 6-fetch budget is shared across web_search →
// fetch_content → get_search_content within a single agent turn, not reset per
// tool call.  We create/reset the guard on each session_start / session_tree
// event (the closest Pi lifecycle hooks to an agent turn boundary), and expose
// it to every tool entry point via getGuard().
let currentGuard: RequestGuard | undefined;
let _warnedNoGuard = false;

function getGuard(): RequestGuard {
	if (currentGuard) return currentGuard;
	// Fallback: called outside a Pi session (e.g. tests that invoke tool
	// internals directly).  Create a standalone guard and warn once.
	if (!_warnedNoGuard) {
		console.warn(
			"[pi-web-access] No per-turn guard active; creating a standalone guard. "
			+ "This is expected in direct-call tests but not in production.",
		);
		_warnedNoGuard = true;
	}
	return createRequestGuard();
}

function abortPendingFetches(): void {
	for (const controller of pendingFetches.values()) {
		controller.abort();
	}
	pendingFetches.clear();
}

export default function (pi: ExtensionAPI) {
	function startBackgroundFetch(urls: string[]): string | null {
		if (urls.length === 0) return null;
		const fetchId = generateId();
		const controller = new AbortController();
		pendingFetches.set(fetchId, controller);
		const bgGuard = getGuard();
		fetchAllContent(urls, controller.signal, undefined, bgGuard)
			.then((fetched) => {
				if (!sessionActive || !pendingFetches.has(fetchId)) return;
				const data: StoredSearchData = {
					id: fetchId,
					type: "fetch",
					timestamp: Date.now(),
					urls: stripThumbnails(fetched),
				};
				storeResult(fetchId, data);
				pi.appendEntry("web-search-results", data);
				const ok = fetched.filter(f => !f.error).length;
				pi.sendMessage(
					{
						customType: "web-search-content-ready",
						content: `Content fetched for ${ok}/${fetched.length} URLs [${fetchId}]. Full page content now available.`,
						display: true,
					},
					{ triggerTurn: true },
				);
			})
			.catch((err) => {
				if (!sessionActive || !pendingFetches.has(fetchId)) return;
				const message = err instanceof Error ? err.message : String(err);
				const isAbort = (err instanceof Error && err.name === "AbortError") || message.toLowerCase().includes("abort");
				if (!isAbort) {
					pi.sendMessage(
						{
							customType: "web-search-error",
							content: `Content fetch failed [${fetchId}]: ${message}`,
							display: true,
						},
						{ triggerTurn: false },
					);
				}
			})
			.finally(() => { pendingFetches.delete(fetchId); });
		return fetchId;
	}

	function storeAndPublishSearch(results: QueryResultData[]): string {
		const id = generateId();
		const data: StoredSearchData = {
			id, type: "search", timestamp: Date.now(), queries: results,
		};
		storeResult(id, data);
		pi.appendEntry("web-search-results", data);
		return id;
	}

	interface SearchReturnOptions {
		queryList: string[];
		results: QueryResultData[];
		urls: string[];
		includeContent: boolean;
		inlineContent?: ExtractedContent[];
	}

	function buildSearchReturn(opts: SearchReturnOptions) {
		const sc = opts.results.filter(r => !r.error).length;
		const tr = opts.results.reduce((sum, r) => sum + r.results.length, 0);

		let output = "";
		for (const { query, answer, results, error } of opts.results) {
			if (opts.queryList.length > 1) {
				output += `## Query: "${query}"\n\n`;
			}
			if (error) output += `Error: ${error}\n\n`;
			else if (results.length === 0) output += "No results found.\n\n";
			else output += formatSearchSummary(results, answer) + "\n\n";
		}

		let fetchId: string | null = null;

		if (opts.inlineContent && opts.inlineContent.length > 0) {
			fetchId = generateId();
			const data: StoredSearchData = {
				id: fetchId,
				type: "fetch",
				timestamp: Date.now(),
				urls: opts.inlineContent,
			};
			storeResult(fetchId, data);
			pi.appendEntry("web-search-results", data);
			output += `---\nFull content for ${opts.inlineContent.length} sources available [${fetchId}].`;
		} else if (opts.includeContent) {
			fetchId = startBackgroundFetch(opts.urls);
			if (fetchId) {
				output += `---\nContent fetching in background [${fetchId}]. Will notify when ready.`;
			}
		}

		const searchId = storeAndPublishSearch(opts.results);
		const isBackgroundFetch = fetchId !== null && !(opts.inlineContent && opts.inlineContent.length > 0);

		return {
			content: [{ type: "text", text: output.trim() }],
			details: {
				queries: opts.queryList,
				queryCount: opts.queryList.length,
				successfulQueries: sc,
				totalResults: tr,
				includeContent: opts.includeContent,
				fetchId,
				fetchUrls: isBackgroundFetch ? opts.urls : undefined,
				searchId,
			},
		};
	}

	pi.on("session_start", async (_event, ctx) => {
		abortPendingFetches();
		sessionActive = true;
		currentGuard = createRequestGuard();
		restoreFromSession(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		abortPendingFetches();
		sessionActive = true;
		currentGuard = createRequestGuard();
		restoreFromSession(ctx);
	});

	pi.on("session_shutdown", () => {
		sessionActive = false;
		currentGuard = undefined;
		abortPendingFetches();
		clearResults();
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			`Search the web using Exa. Returns an AI-synthesized answer with source citations. For comprehensive research, prefer queries (plural) with 2-4 varied angles over a single query — each query gets its own synthesized answer, so varying phrasing and scope gives much broader coverage. When includeContent is true, full page content is fetched in the background. Provider: Exa (direct API with key, MCP fallback without).`,
		promptSnippet:
			"Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries searched in sequence, each returning its own synthesized answer. Prefer this for research — vary phrasing, scope, and angle across 2-4 queries to maximize coverage." })),
			numResults: Type.Optional(Type.Number({ description: "Results per query (default: 5, max: 20)" })),
			includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content (async)" })),
			recencyFilter: Type.Optional(
				StringEnum(["day", "week", "month", "year"], { description: "Filter by recency" }),
			),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			const rawQueryList: unknown[] = Array.isArray(params.queries)
				? params.queries
				: (params.query !== undefined ? [params.query] : []);
			const queryList = normalizeQueryList(rawQueryList);

			if (queryList.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries' parameter." }],
					details: { error: "No query provided" },
				};
			}

			const searchResults: QueryResultData[] = [];
			const allUrls: string[] = [];
			const allInlineContent: ExtractedContent[] = [];

			const searchGuard = getGuard();

			for (let i = 0; i < queryList.length; i++) {
				const query = queryList[i];

				onUpdate?.({
					content: [{ type: "text", text: `Searching ${i + 1}/${queryList.length}: "${query}"...` }],
					details: { phase: "search", progress: i / queryList.length, currentQuery: query },
				});

				try {
					const result = await searchWithExa(query, {
						numResults: params.numResults,
						recencyFilter: params.recencyFilter,
						domainFilter: params.domainFilter,
						includeContent: params.includeContent,
						signal,
					}, searchGuard);

					if (!result) {
						searchResults.push({ query, answer: "", results: [], error: "No results returned", provider: "exa" });
						continue;
					}

					if ("exhausted" in result) {
						searchResults.push({ query, answer: "", results: [], error: "Exa monthly free tier exhausted (1,000 requests). Resets next month.", provider: "exa" });
						continue;
					}

					searchResults.push({ query, answer: result.answer, results: result.results, error: null, provider: "exa" });
					for (const r of result.results) {
						if (!allUrls.includes(r.url)) {
							allUrls.push(r.url);
						}
					}
					if (result.inlineContent) allInlineContent.push(...result.inlineContent);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					searchResults.push({ query, answer: "", results: [], error: message, provider: "exa" });
				}
			}

			return buildSearchReturn({
				queryList,
				results: searchResults,
				urls: allUrls,
				includeContent: params.includeContent ?? false,
				inlineContent: allInlineContent.length > 0 ? allInlineContent : undefined,
			});
		},

		renderCall(args, theme) {
			const input = args as { query?: unknown; queries?: unknown };
			const rawQueryList: unknown[] = Array.isArray(input.queries)
				? input.queries
				: (input.query !== undefined ? [input.query] : []);
			const queryList = normalizeQueryList(rawQueryList);
			if (queryList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("error", "(no query)"), 0, 0);
			}
			if (queryList.length === 1) {
				const q = queryList[0];
				const display = q.length > 60 ? q.slice(0, 57) + "..." : q;
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${display}"`), 0, 0);
			}
			const lines = [theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `${queryList.length} queries`)];
			for (const q of queryList.slice(0, 5)) {
				const display = q.length > 50 ? q.slice(0, 47) + "..." : q;
				lines.push(theme.fg("muted", `  "${display}"`));
			}
			if (queryList.length > 5) {
				lines.push(theme.fg("muted", `  ... and ${queryList.length - 5} more`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as {
				queryCount?: number;
				successfulQueries?: number;
				totalResults?: number;
				error?: string;
				fetchId?: string;
				fetchUrls?: string[];
				phase?: string;
				progress?: number;
				currentQuery?: string;
			};

			if (isPartial) {
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				const query = details?.currentQuery || "";
				const display = query.length > 40 ? query.slice(0, 37) + "..." : query;
				return new Text(theme.fg("accent", `[${bar}] ${display || details?.phase || "searching"}`), 0, 0);
			}

			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const queryInfo = details?.queryCount === 1 ? "" : `${details?.successfulQueries}/${details?.queryCount} queries, `;
			let statusLine = theme.fg("success", `${queryInfo}${details?.totalResults ?? 0} sources`);
			if (details?.fetchId && details?.fetchUrls) {
				statusLine += theme.fg("muted", ` (fetching ${details.fetchUrls.length} URLs)`);
			} else if (details?.fetchId) {
				statusLine += theme.fg("muted", " (content ready)");
			}

			if (!expanded) {
				const box = new Box(1, 0, (t) => theme.bg("toolSuccessBg", t));
				box.addChild(new Text(statusLine, 0, 0));
				const textContent = result.content.find((c) => c.type === "text")?.text || "";
				const firstContentLine = textContent.split("\n").find(l => {
					const t = l.trim();
					return t && !t.startsWith("[") && !t.startsWith("#") && !t.startsWith("---");
				});
				const fallbackLine = (firstContentLine?.trim() || "").replace(/\*\*/g, "");
				if (fallbackLine) {
					const preview = fallbackLine.length > 120 ? fallbackLine.slice(0, 117) + "..." : fallbackLine;
					box.addChild(new Text(theme.fg("dim", preview), 0, 0));
				}
				return box;
			}

			const lines = [statusLine];
			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			for (const line of preview.split("\n")) {
				lines.push(theme.fg("dim", line));
			}
			if (details?.fetchUrls && details.fetchUrls.length > 0) {
				lines.push(theme.fg("muted", "Fetching:"));
				for (const u of details.fetchUrls.slice(0, 5)) {
					const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
					lines.push(theme.fg("dim", "  " + display));
				}
				if (details.fetchUrls.length > 5) {
					lines.push(theme.fg("dim", `  ... and ${details.fetchUrls.length - 5} more`));
				}
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description: "Fetch URL(s) and extract readable content as markdown using Mozilla Readability. Content is always stored and can be retrieved with get_search_content.",
		promptSnippet:
			"Use to extract readable content from URL(s). Returns markdown-converted page content.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs (parallel)" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			const urlList = params.urls ?? (params.url ? [params.url] : []);
			if (urlList.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No URL provided." }],
					details: { error: "No URL provided" },
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }],
				details: { phase: "fetch", progress: 0 },
			});

			const fetchGuard = getGuard();
			const fetchResults = await fetchAllContent(urlList, signal, undefined, fetchGuard);
			const successful = fetchResults.filter((r) => !r.error).length;
			const totalChars = fetchResults.reduce((sum, r) => sum + r.content.length, 0);

			const responseId = generateId();
			const data: StoredSearchData = {
				id: responseId,
				type: "fetch",
				timestamp: Date.now(),
				urls: stripThumbnails(fetchResults),
			};
			storeResult(responseId, data);
			pi.appendEntry("web-search-results", data);

			if (urlList.length === 1) {
				const fetchResult = fetchResults[0];
				if (fetchResult.error) {
					return {
						content: [{ type: "text", text: `Error: ${fetchResult.error}` }],
						details: { urls: urlList, urlCount: 1, successful: 0, error: fetchResult.error, responseId },
					};
				}

				const fullLength = fetchResult.content.length;
				const truncated = fullLength > MAX_INLINE_CONTENT;
				let output = truncated
					? fetchResult.content.slice(0, MAX_INLINE_CONTENT) + "\n\n[Content truncated...]"
					: fetchResult.content;

				if (truncated) {
					output += `\n\n---\nShowing ${MAX_INLINE_CONTENT} of ${fullLength} chars. ` +
						`Use get_search_content({ responseId: "${responseId}", urlIndex: 0 }) for full content.`;
				}

				return {
					content: [{ type: "text", text: output }],
					details: {
						urls: urlList,
						urlCount: 1,
						successful: 1,
						totalChars: fullLength,
						title: fetchResult.title,
						responseId,
						truncated,
					},
				};
			}

			let output = "## Fetched URLs\n\n";
			for (const { url, title, content, error } of fetchResults) {
				if (error) {
					output += `- ${url}: Error - ${error}\n`;
				} else {
					output += `- ${title || url} (${content.length} chars)\n`;
				}
			}
			output += `\n---\nUse get_search_content({ responseId: "${responseId}", urlIndex: 0 }) to retrieve full content.`;

			return {
				content: [{ type: "text", text: output }],
				details: { urls: urlList, urlCount: urlList.length, successful, totalChars, responseId },
			};
		},

		renderCall(args, theme) {
			const { url, urls } = args as { url?: string; urls?: string[] };
			const urlList = urls ?? (url ? [url] : []);
			if (urlList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"), 0, 0);
			}
			const lines: string[] = [];
			if (urlList.length === 1) {
				const display = urlList[0].length > 60 ? urlList[0].slice(0, 57) + "..." : urlList[0];
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", display));
			} else {
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", `${urlList.length} URLs`));
				for (const u of urlList.slice(0, 5)) {
					const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
					lines.push(theme.fg("muted", "  " + display));
				}
				if (urlList.length > 5) {
					lines.push(theme.fg("muted", `  ... and ${urlList.length - 5} more`));
				}
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as {
				urlCount?: number;
				successful?: number;
				totalChars?: number;
				error?: string;
				title?: string;
				truncated?: boolean;
				responseId?: string;
				phase?: string;
				progress?: number;
			};

			if (isPartial) {
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "fetching"}`), 0, 0);
			}

			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			if (details?.urlCount === 1) {
				const title = details?.title || "Untitled";
				let statusLine = theme.fg("success", title) + theme.fg("muted", ` (${details?.totalChars ?? 0} chars)`);
				if (details?.truncated) {
					statusLine += theme.fg("warning", " [truncated]");
				}
				const textContent = result.content.find((c) => c.type === "text")?.text || "";
				if (!expanded) {
					const brief = textContent.length > 200 ? textContent.slice(0, 200) + "..." : textContent;
					return new Text(statusLine + "\n" + theme.fg("dim", brief), 0, 0);
				}
				const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
				return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
			}

			const countColor = (details?.successful ?? 0) > 0 ? "success" : "error";
			const statusLine = theme.fg(countColor, `${details?.successful}/${details?.urlCount} URLs`) + theme.fg("muted", " (content stored)");
			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}
			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	pi.registerTool({
		name: "get_search_content",
		label: "Get Search Content",
		description: "Retrieve full content from a previous web_search or fetch_content call.",
		promptSnippet:
			"Use after web_search/fetch_content when full stored content is needed via responseId plus query/url selectors.",
		parameters: Type.Object({
			responseId: Type.String({ description: "The responseId from web_search or fetch_content" }),
			query: Type.Optional(Type.String({ description: "Get content for this query (web_search)" })),
			queryIndex: Type.Optional(Type.Number({ description: "Get content for query at index" })),
			url: Type.Optional(Type.String({ description: "Get content for this URL" })),
			urlIndex: Type.Optional(Type.Number({ description: "Get content for URL at index" })),
		}),

		async execute(_toolCallId, params) {
			const data = getResult(params.responseId);
			if (!data) {
				return {
					content: [{ type: "text", text: `Error: No stored results for "${params.responseId}"` }],
					details: { error: "Not found", responseId: params.responseId },
				};
			}

			if (data.type === "search" && data.queries) {
				let queryData: QueryResultData | undefined;

				if (params.query !== undefined) {
					queryData = data.queries.find((q) => q.query === params.query);
					if (!queryData) {
						const available = data.queries.map((q) => `"${q.query}"`).join(", ");
						return {
							content: [{ type: "text", text: `Query "${params.query}" not found. Available: ${available}` }],
							details: { error: "Query not found" },
						};
					}
				} else if (params.queryIndex !== undefined) {
					queryData = data.queries[params.queryIndex];
					if (!queryData) {
						return {
							content: [{ type: "text", text: `Index ${params.queryIndex} out of range (0-${data.queries.length - 1})` }],
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = data.queries.map((q, i) => `${i}: "${q.query}"`).join(", ");
					return {
						content: [{ type: "text", text: `Specify query or queryIndex. Available: ${available}` }],
						details: { error: "No query specified" },
					};
				}

				if (queryData.error) {
					return {
						content: [{ type: "text", text: `Error for "${queryData.query}": ${queryData.error}` }],
						details: { error: queryData.error, query: queryData.query },
					};
				}

				return {
					content: [{ type: "text", text: formatFullResults(queryData) }],
					details: { query: queryData.query, resultCount: queryData.results.length },
				};
			}

			if (data.type === "fetch" && data.urls) {
				let urlData: ExtractedContent | undefined;

				if (params.url !== undefined) {
					urlData = data.urls.find((u) => u.url === params.url);
					if (!urlData) {
						const available = data.urls.map((u) => u.url).join("\n  ");
						return {
							content: [{ type: "text", text: `URL not found. Available:\n  ${available}` }],
							details: { error: "URL not found" },
						};
					}
				} else if (params.urlIndex !== undefined) {
					urlData = data.urls[params.urlIndex];
					if (!urlData) {
						return {
							content: [{ type: "text", text: `Index ${params.urlIndex} out of range (0-${data.urls.length - 1})` }],
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
					return {
						content: [{ type: "text", text: `Specify url or urlIndex. Available:\n  ${available}` }],
						details: { error: "No URL specified" },
					};
				}

				if (urlData.error) {
					return {
						content: [{ type: "text", text: `Error for ${urlData.url}: ${urlData.error}` }],
						details: { error: urlData.error, url: urlData.url },
					};
				}

				return {
					content: [{ type: "text", text: `# ${urlData.title}\n\n${urlData.content}` }],
					details: { url: urlData.url, title: urlData.title, contentLength: urlData.content.length },
				};
			}

			return {
				content: [{ type: "text", text: "Invalid stored data format" }],
				details: { error: "Invalid data" },
			};
		},

		renderCall(args, theme) {
			const { responseId, query, queryIndex, url, urlIndex } = args as {
				responseId: string;
				query?: string;
				queryIndex?: number;
				url?: string;
				urlIndex?: number;
			};
			let target = "";
			if (query) target = `query="${query}"`;
			else if (queryIndex !== undefined) target = `queryIndex=${queryIndex}`;
			else if (url) target = url.length > 30 ? url.slice(0, 27) + "..." : url;
			else if (urlIndex !== undefined) target = `urlIndex=${urlIndex}`;
			return new Text(theme.fg("toolTitle", theme.bold("get_content ")) + theme.fg("accent", target || responseId.slice(0, 8)), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as {
				error?: string;
				query?: string;
				url?: string;
				title?: string;
				resultCount?: number;
				contentLength?: number;
			};

			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			let statusLine: string;
			if (details?.query) {
				statusLine = theme.fg("success", `"${details.query}"`) + theme.fg("muted", ` (${details.resultCount} results)`);
			} else {
				statusLine = theme.fg("success", details?.title || "Content") + theme.fg("muted", ` (${details?.contentLength ?? 0} chars)`);
			}

			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}

			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});
}
