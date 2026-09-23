import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	DEFAULT_MAX_INLINE_CONTENT_CHARS,
	MAX_INLINE_CONTENT_CHARS,
	MIN_INLINE_CONTENT_CHARS,
	requireAgentDir,
} from "./settings.ts";
import { resetRequestOperations } from "./request-budget.ts";

const MAX_QUERIES = 4;
const MAX_RESULTS = 10;
const MAX_URLS = 6;
const MAX_QUERY_CHARS = 2048;
const MAX_URL_CHARS = 2048;
const MAX_DOMAIN_FILTERS = 16;
const MAX_OFFSET = 128 * 1024 * 1024;

// Match pi-ai's StringEnum without loading its runtime barrel during registration.
function StringEnum<T extends string[]>(values: T, options?: { description?: string; default?: T[number] }) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}

type RuntimeTool = {
	execute: (...args: any[]) => unknown;
	renderCall?: (...args: any[]) => unknown;
	renderResult?: (...args: any[]) => unknown;
};

type RuntimeEvent = (...args: any[]) => unknown;
type SessionRestoreEvent = "session_start" | "session_tree";
type PendingSessionRestore = {
	kind: SessionRestoreEvent;
	event: unknown;
	context: unknown;
};

type Runtime = {
	tools: Map<string, RuntimeTool>;
	events: Map<string, RuntimeEvent>;
};

async function loadRuntime(pi: ExtensionAPI): Promise<Runtime> {
	const tools = new Map<string, RuntimeTool>();
	const events = new Map<string, RuntimeEvent>();
	const runtimePi = {
		...pi,
		registerTool(definition: RuntimeTool & { name: string }) {
			tools.set(definition.name, definition);
		},
		on(event: string, handler: RuntimeEvent) {
			events.set(event, handler);
		},
	};

	const module = await import("./web-tools.ts");
	module.default(runtimePi as ExtensionAPI);
	return { tools, events };
}

function renderCall(name: string, args: unknown, theme: any): Text {
	const value = args && typeof args === "object" ? args as Record<string, unknown> : {};
	const field = name === "web_search" ? value.query : value.url;
	const detail = typeof field === "string" && field.trim().length > 0
		? field.trim().slice(0, 60)
		: name === "get_search_content" ? "stored content" : "(pending)";
	return new Text(theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("accent", detail), 0, 0);
}

function renderResult(result: any, theme: any): Text {
	const text = result?.content?.find?.((part: any) => part?.type === "text")?.text;
	const detail = typeof text === "string" && text.length > 0 ? text.slice(0, 240) : "completed";
	return new Text(theme.fg("dim", detail), 0, 0);
}

export default function register(pi: ExtensionAPI): void {
	let runtimePromise: Promise<Runtime> | undefined;
	let loadedRuntime: Runtime | undefined;
	let pendingSessionRestore: PendingSessionRestore | undefined;

	const replayPendingSessionRestore = (runtime: Runtime): void => {
		const pending = pendingSessionRestore;
		pendingSessionRestore = undefined;
		if (!pending) return;
		runtime.events.get(pending.kind)?.(pending.event, pending.context);
	};

	const ensureRuntime = (): Promise<Runtime> => {
		if (!runtimePromise) {
			runtimePromise = loadRuntime(pi).then((runtime) => {
				loadedRuntime = runtime;
				replayPendingSessionRestore(runtime);
				return runtime;
			});
		}
		return runtimePromise;
	};

	const tools = [
		{
			name: "web_search",
			label: "Web Search",
			description: "Search the web with Exa and return source citations.",
			promptSnippet: "Use for one focused web search.",
			parameters: Type.Object({
				query: Type.Optional(Type.String({ maxLength: MAX_QUERY_CHARS, description: "One focused search query." })),
				queries: Type.Optional(Type.Array(Type.String({ maxLength: MAX_QUERY_CHARS }), { maxItems: MAX_QUERIES, description: "Optional batch of up to 4 queries." })),
				numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS, default: 5, description: "Results per query; default 5." })),
				recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"], { description: "Limit by publication age." })),
				domainFilter: Type.Optional(Type.Array(Type.String({ maxLength: 253 }), { maxItems: MAX_DOMAIN_FILTERS, description: "Limit to up to 16 domains." })),
			}),
		},
		{
			name: "fetch_content",
			label: "Fetch Content",
			description: "Fetch up to 6 URLs and extract readable content as Markdown.",
			promptSnippet: "Use to fetch readable content from a URL.",
			parameters: Type.Object({
				url: Type.Optional(Type.String({ maxLength: MAX_URL_CHARS, description: "One URL to fetch." })),
				urls: Type.Optional(Type.Array(Type.String({ maxLength: MAX_URL_CHARS }), { maxItems: MAX_URLS, description: "Up to 6 URLs." })),
			}),
		},
		{
			name: "get_search_content",
			label: "Get Search Content",
			description: "Retrieve bounded stored search or fetched content.",
			promptSnippet: "Use for a bounded continuation or a literal text match.",
			parameters: Type.Object({
				responseId: Type.String({ minLength: 1, maxLength: 256, description: "Stored response ID." }),
				query: Type.Optional(Type.String({ maxLength: MAX_QUERY_CHARS, description: "Select a stored query." })),
				queryIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_QUERIES - 1, description: "Stored query index." })),
				url: Type.Optional(Type.String({ maxLength: MAX_URL_CHARS, description: "Select a stored URL." })),
				urlIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_URLS - 1, description: "Stored URL index." })),
				offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_OFFSET, description: "Character offset for the next slice." })),
				limit: Type.Optional(Type.Integer({ minimum: MIN_INLINE_CONTENT_CHARS, maximum: MAX_INLINE_CONTENT_CHARS, default: DEFAULT_MAX_INLINE_CONTENT_CHARS, description: "Maximum returned characters; default 12000." })),
				findText: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "One literal, case-insensitive text match." })),
			}),
		},
	] as const;

	for (const definition of tools) {
		pi.registerTool(({
			...definition,
			async execute(...args: any[]): Promise<any> {
				requireAgentDir();
				const runtime = await ensureRuntime();
				const tool = runtime.tools.get(definition.name);
				if (!tool) throw new Error(`Runtime did not register ${definition.name}`);
				return tool.execute(...args);
			},
			renderCall(args: unknown, theme: any, context: any) {
				const runtimeTool = loadedRuntime?.tools.get(definition.name);
				if (runtimeTool?.renderCall) return runtimeTool.renderCall(args, theme, context);
				return renderCall(definition.name, args, theme);
			},
			renderResult(result: any, options: any, theme: any, context: any) {
				const runtimeTool = loadedRuntime?.tools.get(definition.name);
				if (runtimeTool?.renderResult) return runtimeTool.renderResult(result, options, theme, context);
				return renderResult(result, theme);
			},
		}) as any);
	}

	const forwardLoadedEvent = (event: "agent_start" | "session_shutdown" | SessionRestoreEvent, args: any[]) =>
		loadedRuntime?.events.get(event)?.(...args);
	const forwardSessionEvent = (kind: SessionRestoreEvent) => (event: unknown, context: unknown) => {
		if (loadedRuntime) return forwardLoadedEvent(kind, [event, context]);
		pendingSessionRestore = { kind, event, context };
	};

	pi.on("agent_start", ((...args: any[]) => {
		if (loadedRuntime) return forwardLoadedEvent("agent_start", args);
		resetRequestOperations();
	}) as any);
	pi.on("session_start", forwardSessionEvent("session_start") as any);
	pi.on("session_tree", forwardSessionEvent("session_tree") as any);
	pi.on("session_shutdown", ((...args: any[]) => {
		pendingSessionRestore = undefined;
		if (loadedRuntime) return forwardLoadedEvent("session_shutdown", args);
	}) as any);
}
