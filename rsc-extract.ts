export interface RSCExtractResult {
	title: string;
	content: string;
}

const MAX_RSC_SCRIPTS = 64;
const MAX_RSC_CHUNKS = 256;
const MAX_RSC_CHUNK_CHARS = 512_000;
const MAX_RSC_CHARS = 1_000_000;
const MAX_RSC_RENDER_NODES = 100_000;
const MAX_RSC_RECURSION_DEPTH = 128;
const RSC_SCRIPT = /<script\b[^>]*>\s*self\.__next_f\.push\(\s*\[\s*1\s*,\s*("(?:\\.|[^"\\])*")\s*\]\s*\)\s*<\/script>/gi;
const SKIP_TAGS = new Set(["script", "style", "svg", "path", "circle", "link", "meta", "template", "button", "input", "nav", "footer", "aside"]);

function cap(text: string): string {
	return text.length > MAX_RSC_CHARS ? text.slice(0, MAX_RSC_CHARS) : text;
}

function clean(text: string): string {
	return cap(text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
}

function titleFromHtml(html: string): string {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return (match?.[1] || "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.split("|")[0]
		?.trim() || "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueBlocks(text: string): string {
	const blocks = clean(text).split(/\n{2,}/);
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const rawBlock of blocks) {
		const block = rawBlock.trim();
		if (!block) continue;
		const key = block.replace(/\s+/g, " ").slice(0, 300);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(block);
	}
	return clean(unique.join("\n\n"));
}

interface RenderBudget {
	remainingOutput: number;
	remainingNodes: number;
	depth: number;
}

interface RenderState {
	budget: RenderBudget;
	refs: Set<string>;
}

interface RenderOutput {
	chunks: string[];
}

function appendOutput(output: RenderOutput, state: RenderState, text: string): void {
	if (!text || state.budget.remainingOutput <= 0) return;
	const length = Math.min(text.length, state.budget.remainingOutput);
	output.chunks.push(length === text.length ? text : text.slice(0, length));
	state.budget.remainingOutput -= length;
}

function outputText(output: RenderOutput): string {
	return output.chunks.join("");
}

export function extractRSCContent(html: string): RSCExtractResult | null {
	if (!html.includes("self.__next_f.push")) return null;

	const chunks = new Map<string, string>();
	let totalChunkChars = 0;
	let scriptCount = 0;
	for (const match of html.matchAll(RSC_SCRIPT)) {
		if (++scriptCount > MAX_RSC_SCRIPTS) break;
		let scriptText: string;
		try {
			scriptText = JSON.parse(match[1]);
		} catch {
			continue;
		}
		if (typeof scriptText !== "string" || scriptText.length > MAX_RSC_CHUNK_CHARS * 4) continue;

		for (const line of scriptText.split("\n")) {
			if (chunks.size >= MAX_RSC_CHUNKS && !line.startsWith("23:")) break;
			const colon = line.indexOf(":");
			if (colon <= 0 || colon > 8) continue;
			const id = line.slice(0, colon).toLowerCase();
			if (!/^[0-9a-f]+$/.test(id)) continue;
			const payload = line.slice(colon + 1);
			if (!payload || payload.length > MAX_RSC_CHUNK_CHARS) continue;
			const previous = chunks.get(id);
			if (previous && previous.length >= payload.length) continue;
			if (!previous && totalChunkChars + payload.length > MAX_RSC_CHUNK_CHARS * 8) continue;
			totalChunkChars += payload.length - (previous?.length || 0);
			chunks.set(id, payload);
		}
	}
	if (chunks.size === 0) return null;

	const parsed = new Map<string, unknown | null>();
	const getChunk = (id: string): unknown | null => {
		const key = id.toLowerCase();
		if (parsed.has(key)) return parsed.get(key) ?? null;
		const payload = chunks.get(key);
		if (!payload || !/^[\[{"\d-]/.test(payload)) {
			parsed.set(key, null);
			return null;
		}
		try {
			const value = JSON.parse(payload) as unknown;
			parsed.set(key, value);
			return value;
		} catch {
			parsed.set(key, null);
			return null;
		}
	};

	const render = (node: unknown, state: RenderState, output: RenderOutput, code = false): void => {
		if (state.budget.remainingOutput <= 0 || state.budget.remainingNodes <= 0) return;
		state.budget.remainingNodes--;
		if (state.budget.depth >= MAX_RSC_RECURSION_DEPTH) return;
		state.budget.depth++;
		try {
			if (node === null || node === undefined || typeof node === "boolean") return;
			if (typeof node === "number") {
				appendOutput(output, state, String(node));
				return;
			}
			if (typeof node === "string") {
				const reference = node.match(/^\$L([0-9a-f]{1,8})$/i);
				if (reference) {
					const id = reference[1].toLowerCase();
					if (state.refs.has(id)) return;
					const value = getChunk(id);
					if (value === null) return;
					state.refs.add(id);
					try {
						render(value, state, output, code);
					} finally {
						state.refs.delete(id);
					}
					return;
				}
				if (!code && (node === "$" || node === "$undefined" || /^\$[A-Z]/.test(node))) return;
				appendOutput(output, state, node);
				return;
			}
			if (!Array.isArray(node)) return;

			if (node[0] === "$" && typeof node[1] === "string") {
				const tag = node[1];
				const props = isRecord(node[3]) ? node[3] : {};
				if (SKIP_TAGS.has(tag)) return;
				if (tag.startsWith("$L")) {
					const id = tag.slice(2).toLowerCase();
					if (state.refs.has(id)) return;
					const value = getChunk(id);
					if (value !== null) {
						state.refs.add(id);
						try {
							render(value, state, output, code);
						} finally {
							state.refs.delete(id);
						}
					} else {
						render(props.children, state, output, code);
					}
					return;
				}

				if (tag === "pre") {
					appendOutput(output, state, "```\n");
					render(props.children, state, output, true);
					appendOutput(output, state, "\n```\n\n");
					return;
				}
				if (tag === "code") {
					if (!code) appendOutput(output, state, "`");
					render(props.children, state, output, true);
					if (!code) appendOutput(output, state, "`");
					return;
				}

				if (/^h[1-6]$/.test(tag)) appendOutput(output, state, `${"#".repeat(Number(tag[1]))} `);
				else if (tag === "li") appendOutput(output, state, "- ");
				else if (tag === "blockquote") appendOutput(output, state, "> ");
				else if (tag === "strong" || tag === "b") appendOutput(output, state, "**");
				else if (tag === "em" || tag === "i") appendOutput(output, state, "*");

				render(props.children, state, output, code);

				if (/^h[1-6]$/.test(tag) || tag === "p" || tag === "article" || tag === "section" || tag === "main" || tag === "div" || tag === "blockquote") {
					appendOutput(output, state, "\n\n");
				} else if (tag === "br" || tag === "li") {
					appendOutput(output, state, "\n");
				} else if (tag === "ul" || tag === "ol") {
					appendOutput(output, state, "\n");
				} else if (tag === "strong" || tag === "b") {
					appendOutput(output, state, "**");
				} else if (tag === "em" || tag === "i") {
					appendOutput(output, state, "*");
				}
				return;
			}

			for (let index = 0; index < node.length; index++) {
				if (state.budget.remainingOutput <= 0 || state.budget.remainingNodes <= 0) break;
				render(node[index], state, output, code);
			}
		} finally {
			state.budget.depth--;
		}
	};

	const state: RenderState = {
		budget: {
			remainingOutput: MAX_RSC_CHARS,
			remainingNodes: MAX_RSC_RENDER_NODES,
			depth: 0,
		},
		refs: new Set(),
	};
	const renderChunk = (value: unknown): string => {
		const output: RenderOutput = { chunks: [] };
		render(value, state, output);
		return outputText(output);
	};

	const title = titleFromHtml(html);
	const main = getChunk("23");
	if (main !== null) {
		const content = uniqueBlocks(renderChunk(main));
		if (content.length > 100) return { title, content };
	}

	const parts: { order: number; text: string }[] = [];
	for (const [id] of chunks) {
		if (state.budget.remainingOutput <= 0 || state.budget.remainingNodes <= 0) break;
		if (id === "23") continue;
		const value = getChunk(id);
		if (value === null) continue;
		state.refs.clear();
		const text = uniqueBlocks(renderChunk(value));
		if (text.length <= 50 || /page was not found|\b404\b/i.test(text)) continue;
		parts.push({ order: Number.parseInt(id, 16), text });
	}
	parts.sort((a, b) => a.order - b.order);

	const combined: string[] = [];
	let combinedLength = 0;
	for (const part of parts) {
		if (combinedLength >= MAX_RSC_CHARS) break;
		if (combined.length > 0) {
			combined.push("\n\n");
			combinedLength += 2;
		}
		const remaining = MAX_RSC_CHARS - combinedLength;
		const text = part.text.slice(0, remaining);
		combined.push(text);
		combinedLength += text.length;
	}
	const content = uniqueBlocks(combined.join(""));
	return content.length > 100 ? { title, content } : null;
}
