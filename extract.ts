import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import pLimit from "p-limit";
import { activityMonitor } from "./activity.js";
import { createRequestGuard, type RequestGuard, RequestBudgetExceeded } from "./request-guard.js";

const DEFAULT_TIMEOUT_MS = 30000;
const CONCURRENT_LIMIT = 3;

const NON_RECOVERABLE_ERRORS = ["Unsupported content type", "Response too large"];
const MIN_USEFUL_CONTENT = 500;

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function abortedResult(url: string): ExtractedContent {
	return { url, title: "", content: "", error: "Aborted" };
}

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

const fetchLimit = pLimit(CONCURRENT_LIMIT);

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
}

export interface ExtractOptions {
	timeoutMs?: number;
}

async function extractViaHttp(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
	guard?: RequestGuard,
): Promise<ExtractedContent> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const activityId = activityMonitor.logStart({ type: "fetch", url });

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	try {
		const g = guard ?? createRequestGuard();
		const response = await g.fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
				"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "none",
				"Sec-Fetch-User": "?1",
				"Upgrade-Insecure-Requests": "1",
			},
		});

		if (!response.ok) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `HTTP ${response.status}: ${response.statusText}`,
			};
		}

		const contentType = response.headers.get("content-type") || "";

		if (contentType.includes("application/octet-stream") ||
			contentType.includes("image/") ||
			contentType.includes("audio/") ||
			contentType.includes("video/") ||
			contentType.includes("application/zip") ||
			contentType.includes("application/pdf")) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `Unsupported content type: ${contentType.split(";")[0]}`,
			};
		}

		const text = await response.text();
		const isHTML = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");

		if (!isHTML) {
			activityMonitor.logComplete(activityId, response.status);
			const title = extractTextTitle(text, url);
			return { url, title, content: text, error: null };
		}

		const { document } = parseHTML(text);
		const reader = new Readability(document as unknown as Document);
		const article = reader.parse();

		if (!article) {
			activityMonitor.logComplete(activityId, response.status);
			const jsRendered = isLikelyJSRendered(text);
			return {
				url,
				title: "",
				content: "",
				error: jsRendered
					? "Page appears to be JavaScript-rendered (content loads dynamically)"
					: "Could not extract readable content from HTML structure",
			};
		}

		const markdown = turndown.turndown(article.content);
		activityMonitor.logComplete(activityId, response.status);

		if (markdown.length < MIN_USEFUL_CONTENT) {
			return {
				url,
				title: article.title || "",
				content: markdown,
				error: isLikelyJSRendered(text)
					? "Page appears to be JavaScript-rendered (content loads dynamically)"
					: "Extracted content appears incomplete",
			};
		}

		return { url, title: article.title || "", content: markdown, error: null };
	} catch (err) {
		if (err instanceof RequestBudgetExceeded) throw err;
		const message = errorMessage(err);
		if (isAbortError(err)) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return { url, title: "", content: "", error: message };
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}

function isLikelyJSRendered(html: string): boolean {
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch) return false;
	const bodyHtml = bodyMatch[1];
	const textContent = bodyHtml
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const scriptCount = (html.match(/<script/gi) || []).length;
	return textContent.length < 500 && scriptCount > 3;
}

export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

function extractTextTitle(text: string, url: string): string {
	return extractHeadingTitle(text) ?? (new URL(url).pathname.split("/").pop() || url);
}

export async function extractContent(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
	guard?: RequestGuard,
): Promise<ExtractedContent> {
	if (signal?.aborted) {
		return abortedResult(url);
	}

	try {
		new URL(url);
	} catch {
		return { url, title: "", content: "", error: "Invalid URL" };
	}

	if (signal?.aborted) return abortedResult(url);

	const httpResult = await extractViaHttp(url, signal, options, guard);

	if (signal?.aborted) return abortedResult(url);
	if (!httpResult.error) return httpResult;
	if (NON_RECOVERABLE_ERRORS.some(prefix => httpResult.error!.startsWith(prefix))) return httpResult;

	// Return the HTTP error — no Jina/Gemini fallbacks in this build
	return httpResult;
}

export async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
	guard?: RequestGuard,
): Promise<ExtractedContent[]> {
	return Promise.all(urls.map((url) => fetchLimit(() => extractContent(url, signal, options, guard))));
}
