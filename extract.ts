import pLimit from "p-limit";
import { activityMonitor } from "./activity.ts";
import { getFetchTimeoutMs } from "./settings.ts";
import { fetchRemoteUrl, type FetchImplementation, type Lookup } from "./ssrf-protection.ts";
import { extractRSCContent } from "./rsc-extract.ts";
import { sanitizeInlineDataUris } from "./data-uri-sanitize.ts";

const CONCURRENT_LIMIT = 3;
const MIN_USEFUL_CONTENT = 500;
const DEFAULT_EXTRACTION_TIMEOUT_MS = 30_000;
const MAX_EXTRACTION_TIMEOUT_MS = 120_000;

/** The transport has its own 5 MiB cap. This smaller stage cap also protects
 * parsers and the model-visible result from unusually large documents. */
export const MAX_EXTRACTION_OUTPUT_CHARS = 1_000_000;
const TRUNCATION_MARKER = "\n\n[Content truncated; use get_search_content for the remaining content.]";
const MAX_TITLE_CHARS = 1024;

const fetchLimit = pLimit(CONCURRENT_LIMIT);

export interface RegisteredToolNames {
	webSearch?: string;
	fetchContent?: string;
}

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
	mimeType?: string;
	status?: number;
}

export interface ExtractOptions {
	/** Extraction deadline; transport still applies its independent settings deadline. */
	timeoutMs?: number;
	/** Custom DNS resolver used by focused transport/extraction tests. */
	lookup?: Lookup;
	/** Explicit transport used by focused extraction/runtime integration tests. */
	fetch?: FetchImplementation;
	/** Registered names are used only to make 404/410 guidance actionable. */
	toolNames?: RegisteredToolNames;
}

class ExtractionDeadlineError extends Error {
	constructor() {
		super("The operation was aborted.");
		this.name = "ExtractionDeadlineError";
	}
}

class CallerAbortError extends Error {
	constructor() {
		super("Aborted");
		this.name = "AbortError";
	}
}

interface ExtractionDeadline {
	controller: AbortController;
	startedAt: number;
	timeoutMs: number;
	timedOut: boolean;
	parentSignal?: AbortSignal;
	promise: Promise<never>;
	finish: () => void;
	assert: () => void;
	run: <T>(work: () => Promise<T>) => Promise<T>;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function abortedResult(url: string): ExtractedContent {
	return { url, title: "", content: "", error: "Aborted" };
}

function timeoutResult(url: string): ExtractedContent {
	return { url, title: "", content: "", error: "The operation was aborted." };
}

function resolveTimeoutMs(options?: Pick<ExtractOptions, "timeoutMs">): number {
	const configured = options?.timeoutMs ?? getFetchTimeoutMs();
	if (typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0) {
		throw new Error("Extraction timeout must be a positive finite number of milliseconds");
	}
	return Math.min(MAX_EXTRACTION_TIMEOUT_MS, Math.max(1, Math.ceil(configured)));
}

export function resolveExtractionTimeoutMs(options?: Pick<ExtractOptions, "timeoutMs">): number {
	return resolveTimeoutMs(options);
}

function createDeadline(timeoutMs: number, parentSignal?: AbortSignal): ExtractionDeadline {
	const controller = new AbortController();
	let timedOut = false;
	let rejectDeadline: (reason: Error) => void = () => {};
	const promise = new Promise<never>((_, reject) => { rejectDeadline = reject; });
	// The race promise is intentionally marked handled. A response body or lazy
	// parser may finish after a deadline, but it must never create an unhandled
	// rejection or turn that late completion into a successful extraction.
	void promise.catch(() => undefined);
	const startedAt = Date.now();
	const abortForCaller = () => {
		if (timedOut) return;
		controller.abort();
		rejectDeadline(new CallerAbortError());
	};
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
		rejectDeadline(new ExtractionDeadlineError());
	}, timeoutMs);
	if (parentSignal?.aborted) abortForCaller();
	else parentSignal?.addEventListener("abort", abortForCaller, { once: true });

	const assert = () => {
		if (parentSignal?.aborted) throw new CallerAbortError();
		if (timedOut || Date.now() - startedAt >= timeoutMs) {
			timedOut = true;
			controller.abort();
			throw new ExtractionDeadlineError();
		}
		if (controller.signal.aborted) throw new ExtractionDeadlineError();
	};
	const run = async <T>(work: () => Promise<T>): Promise<T> => {
		assert();
		const task = Promise.resolve().then(work);
		void task.catch(() => undefined);
		return Promise.race([task, promise]);
	};
	const finish = () => {
		clearTimeout(timer);
		parentSignal?.removeEventListener("abort", abortForCaller);
	};
	return { controller, startedAt, timeoutMs, timedOut, parentSignal, promise, finish, assert, run };
}

function isDeadlineError(err: unknown, deadline: ExtractionDeadline): boolean {
	return err instanceof ExtractionDeadlineError || deadline.timedOut ||
		(Date.now() - deadline.startedAt >= deadline.timeoutMs && !deadline.parentSignal?.aborted);
}

function isLikelyJSRendered(html: string): boolean {
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch) return false;
	const bodyText = bodyMatch[1]
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return bodyText.length < 500 && (html.match(/<script/gi) || []).length > 3;
}

function notFoundGuidance(
	url: string,
	status: number,
	statusText: string,
	toolNames?: RegisteredToolNames,
): string {
	const first = `HTTP ${status}: ${statusText || (status === 404 ? "Not Found" : "Gone")}`;
	const lines = [first, `The origin says this page does not exist (HTTP ${status}).`];
	if (toolNames?.webSearch && toolNames.fetchContent) {
		lines.push(`Use ${toolNames.webSearch} to find the current URL, then retry ${toolNames.fetchContent}.`);
	} else if (toolNames?.webSearch) {
		lines.push(`Use ${toolNames.webSearch} to find the current URL, then retry the fetch.`);
	} else {
		lines.push("Find the current URL and retry the fetch.");
	}
	return lines.join("\n");
}

function titleFromText(text: string, url: string): string {
	const heading = extractHeadingTitle(text);
	if (heading) return heading;
	try {
		return new URL(url).pathname.split("/").pop() || url;
	} catch {
		return url;
	}
}

function boundTextByLines(text: string, maxChars = MAX_EXTRACTION_OUTPUT_CHARS): string {
	if (text.length <= maxChars) return text;
	const marker = maxChars > TRUNCATION_MARKER.length ? TRUNCATION_MARKER : "[truncated]";
	const budget = Math.max(0, maxChars - marker.length);
	const end = text.lastIndexOf("\n", budget);
	if (end <= 0) return `${text.slice(0, budget).trimEnd()}${marker}`.slice(0, maxChars);
	return `${text.slice(0, end).trimEnd()}${marker}`.slice(0, maxChars);
}

/** Keep a bounded result at a complete line where possible. */
export function boundExtractedText(text: string, maxChars = MAX_EXTRACTION_OUTPUT_CHARS): string {
	if (!Number.isInteger(maxChars) || maxChars <= 0) throw new Error("Text bound must be a positive integer");
	return boundTextByLines(text, maxChars);
}

function sanitizeResult(result: ExtractedContent): ExtractedContent {
	if (!result.content) return result;
	const sanitized = sanitizeInlineDataUris(result.content, "content");
	const content = boundTextByLines(sanitized.text);
	return content === result.content ? result : { ...result, content };
}

interface HtmlTools {
	parseHTML: (html: string) => { document: unknown };
	Readability: new (document: Document) => { parse: () => { title?: string; content?: string } | null };
	turndown: { turndown: (html: string) => string };
}

let htmlToolsPromise: Promise<HtmlTools> | undefined;
async function loadHtmlTools(): Promise<HtmlTools> {
	const [{ parseHTML }, readabilityModule, turndownModule] = await Promise.all([
		import("linkedom"),
		import("@mozilla/readability"),
		import("turndown"),
	]);
	const TurndownService = turndownModule.default;
	return {
		parseHTML: parseHTML as HtmlTools["parseHTML"],
		Readability: readabilityModule.Readability as unknown as HtmlTools["Readability"],
		turndown: new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }),
	};
}

function getHtmlTools(): Promise<HtmlTools> {
	htmlToolsPromise ??= loadHtmlTools();
	return htmlToolsPromise;
}

function isDefuddleConsoleError(args: unknown[]): boolean {
	const prefix = args[0];
	return prefix === "Defuddle" || (typeof prefix === "string" && /^Defuddle(?:\s|:)/.test(prefix));
}

async function extractWithDefuddle(
	text: string,
	url: string,
	parseHTML: HtmlTools["parseHTML"],
): Promise<{ title: string; content: string } | null> {
	const { Defuddle } = await import("defuddle/node");
	const { document } = parseHTML(text);
	Object.defineProperty(document, "location", {
		value: new URL(url),
		configurable: true,
	});

	let processingError: unknown;
	const originalConsoleError = console.error;
	console.error = (...args: unknown[]) => {
		if (isDefuddleConsoleError(args)) {
			if (args[0] === "Defuddle" && args[1] === "Error processing document:") processingError = args[2];
			return;
		}
		originalConsoleError(...args);
	};
	let resultPromise: Promise<{ title?: unknown; content?: unknown }>;
	try {
		// Defuddle's synchronous mode parses before returning its promise, so the
		// console interception stays local and does not swallow unrelated output.
		resultPromise = Defuddle(document as unknown as Document, url, { markdown: true, useAsync: false }) as Promise<{ title?: unknown; content?: unknown }>;
	} finally {
		console.error = originalConsoleError;
	}
	const result = await resultPromise;
	if (processingError !== undefined) throw new Error(`Defuddle failed to process document: ${errorMessage(processingError)}`);
	return typeof result.content === "string"
		? { title: typeof result.title === "string" ? result.title : "", content: result.content }
		: null;
}

async function cancelResponse(response: Response): Promise<void> {
	try { await response.body?.cancel(); } catch {}
}

function extractionResult(
	url: string,
	title: string,
	content: string,
	error: string | null,
	status?: number,
	mimeType?: string,
): ExtractedContent {
	return {
		url,
		title: title.slice(0, MAX_TITLE_CHARS),
		content,
		error,
		...(typeof status === "number" ? { status } : {}),
		...(mimeType ? { mimeType } : {}),
	};
}

async function extractViaHttp(
	url: string,
	signal: AbortSignal | undefined,
	options: ExtractOptions | undefined,
): Promise<ExtractedContent> {
	const activityId = activityMonitor.logStart({ type: "fetch", url });
	let deadline: ExtractionDeadline;
	try {
		deadline = createDeadline(resolveTimeoutMs(options), signal);
	} catch (err) {
		const message = errorMessage(err);
		activityMonitor.logError(activityId, message);
		return extractionResult(url, "", "", message);
	}

	try {
		const response = await deadline.run(() => fetchRemoteUrl(url, {
			signal: deadline.controller.signal,
			headers: {
				"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
			},
		}, {
			...(options?.lookup ? { lookup: options.lookup } : {}),
			...(options?.fetch ? { fetch: options.fetch } : {}),
		}));
		deadline.assert();

		const contentType = response.headers.get("content-type") || "";
		const normalizedContentType = contentType.toLowerCase();
		const mimeType = normalizedContentType.split(";", 1)[0]?.trim() || undefined;
		if (!response.ok) {
			await cancelResponse(response);
			activityMonitor.logComplete(activityId, response.status);
			const error = response.status === 404 || response.status === 410
				? notFoundGuidance(url, response.status, response.statusText, options?.toolNames)
				: `HTTP ${response.status}: ${response.statusText}`;
			return extractionResult(url, "", "", error, response.status, mimeType);
		}

		if (normalizedContentType.includes("application/octet-stream") ||
			normalizedContentType.includes("image/") ||
			normalizedContentType.includes("audio/") ||
			normalizedContentType.includes("video/") ||
			normalizedContentType.includes("application/zip") ||
			normalizedContentType.includes("application/pdf")) {
			await cancelResponse(response);
			activityMonitor.logComplete(activityId, response.status);
			return extractionResult(url, "", "", `Unsupported content type: ${mimeType || contentType}`, response.status, mimeType);
		}

		const text = await deadline.run(() => response.text());
		deadline.assert();
		const isHTML = normalizedContentType.includes("text/html") || normalizedContentType.includes("application/xhtml+xml");
		if (!isHTML) {
			activityMonitor.logComplete(activityId, response.status);
			return extractionResult(url, titleFromText(text, url), text, null, response.status, mimeType);
		}

		const tools = await deadline.run(() => getHtmlTools());
		deadline.assert();
		const { document } = tools.parseHTML(text);
		deadline.assert();
		const documentTitle = typeof (document as { title?: unknown }).title === "string"
			? (document as { title: string }).title.trim()
			: "";
		const article = new tools.Readability(document as Document).parse();
		deadline.assert();

		let title = article?.title || documentTitle;
		let content = article?.content ? tools.turndown.turndown(article.content) : "";
		deadline.assert();

		if (!article || content.length < MIN_USEFUL_CONTENT) {
			const rscResult = extractRSCContent(text);
			deadline.assert();
			if (rscResult && rscResult.content.length >= MIN_USEFUL_CONTENT) {
				activityMonitor.logComplete(activityId, response.status);
				return extractionResult(url, rscResult.title || title, rscResult.content, null, response.status, mimeType);
			}

			let defuddleResult: { title: string; content: string } | null = null;
			try {
				defuddleResult = await deadline.run(() => extractWithDefuddle(text, response.url || url, tools.parseHTML));
				deadline.assert();
			} catch (err) {
				// A fallback parser must not discard a usable Readability result or
				// expose parser internals. Deadline/caller aborts still belong to the
				// outer operation and are deliberately rethrown.
				if (signal?.aborted || deadline.controller.signal.aborted) throw err;
			}
			if (defuddleResult && defuddleResult.content.length >= MIN_USEFUL_CONTENT) {
				activityMonitor.logComplete(activityId, response.status);
				return extractionResult(url, title || defuddleResult.title, defuddleResult.content, null, response.status, mimeType);
			}
		}

		activityMonitor.logComplete(activityId, response.status);
		if (!article) {
			const error = isLikelyJSRendered(text)
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Could not extract readable content from HTML structure";
			return extractionResult(url, documentTitle, "", error, response.status, mimeType);
		}
		if (content.length < MIN_USEFUL_CONTENT) {
			const error = isLikelyJSRendered(text)
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Extracted content appears incomplete";
			return extractionResult(url, title, content, error, response.status, mimeType);
		}
		return extractionResult(url, title, content, null, response.status, mimeType);
	} catch (err) {
		const message = errorMessage(err);
		if (signal?.aborted || err instanceof CallerAbortError) {
			activityMonitor.logComplete(activityId, 0);
			return abortedResult(url);
		}
		if (isDeadlineError(err, deadline)) {
			activityMonitor.logComplete(activityId, 0);
			return timeoutResult(url);
		}
		if (message.toLowerCase().includes("abort") || message.toLowerCase().includes("timed out")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return extractionResult(url, "", "", message);
	} finally {
		deadline.finish();
	}
}

export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

export async function extractContent(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent> {
	if (signal?.aborted) return abortedResult(url);
	try {
		new URL(url);
	} catch {
		return extractionResult(url, "", "", "Invalid URL");
	}
	if (signal?.aborted) return abortedResult(url);
	const result = await extractViaHttp(url, signal, options);
	return sanitizeResult(result);
}

export async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent[]> {
	return Promise.all(urls.map((url) => fetchLimit(() => extractContent(url, signal, options))));
}
