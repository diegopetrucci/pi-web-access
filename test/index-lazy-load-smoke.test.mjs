import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const geminiSearchUrl = new URL("../gemini-search.ts", import.meta.url).href;

const googleAccountStubs = {
	"node:os": `
		export function platform() { return "linux"; }
		export function homedir() { return process.env.HOME; }
	`,
	"@mariozechner/pi-tui": `
		export class Box { constructor(...args) { this.args = args; } }
		export class Text { constructor(...args) { this.args = args; } }
		export function truncateToWidth(value) { return value; }
	`,
	"@mariozechner/pi-ai": `
		export function StringEnum(values, options = {}) { return { values, ...options }; }
		export async function complete() { return { stopReason: "stop", content: [{ type: "text", text: "summary" }] }; }
		export function getModel(provider, id) { return { provider, id }; }
	`,
	"typebox": `
		export const Type = {
			Object: (value) => value,
			Optional: (value) => value,
			Array: (value, options = {}) => ({ type: "array", value, ...options }),
			Number: (options = {}) => options,
			Integer: (options = {}) => options,
			String: (options = {}) => options,
			Boolean: (options = {}) => options,
		};
	`,
	"./chrome-cookies.js": `
		globalThis.__loaded.push("chrome-cookies");
		export const chromeCookiesLoaded = true;
	`,
	"./gemini-web.js": `
		await import("./chrome-cookies.js");
		globalThis.__loaded.push("gemini-web");
		export async function isGeminiWebAvailable() {
			globalThis.__calls.push({ type: "isGeminiWebAvailable" });
			return { cookie: true };
		}
		export async function getActiveGoogleEmail(cookies) {
			globalThis.__calls.push({ type: "getActiveGoogleEmail", cookies });
			return "tlh@example.com";
		}
	`,
};

const webSearchWorkflowNoneStubs = {
	"@mariozechner/pi-tui": `
		export class Box { constructor(...args) { this.args = args; } }
		export class Text { constructor(...args) { this.args = args; } }
		export function truncateToWidth(value) { return value; }
	`,
	"@mariozechner/pi-ai": `
		export function StringEnum(values, options = {}) { return { values, ...options }; }
		export async function complete() { return \"\"; }
		export function getModel(model) { return model; }
	`,
	"typebox": `
		export const Type = {
			Object: (value) => value,
			Optional: (value) => value,
			Array: (value, options = {}) => ({ type: \"array\", value, ...options }),
			Number: (options = {}) => options,
			Integer: (options = {}) => options,
			String: (options = {}) => options,
			Boolean: (options = {}) => options,
		};
	`,
	"./exa.js": `
		globalThis.__loaded.push(\"exa\");
		export function hasExaApiKey() { return false; }
		export function isExaAvailable() {
			globalThis.__calls.push({ type: \"availability\", provider: \"exa\" });
			return true;
		}
		export async function searchWithExa(query) {
			globalThis.__calls.push({ type: \"search\", provider: \"exa\", query });
			return {
				answer: \"Answer for \" + query,
				results: [{ title: \"Result for \" + query, url: \"https://example.com/\" + encodeURIComponent(query) }],
			};
		}
	`,
	"./perplexity.js": `
		globalThis.__loaded.push(\"perplexity\");
		export function isPerplexityAvailable() {
			globalThis.__calls.push({ type: \"availability\", provider: \"perplexity\" });
			return false;
		}
		export async function searchWithPerplexity() {
			throw new Error(\"perplexity should not run\");
		}
	`,
	"./gemini-api.js": `
		globalThis.__loaded.push(\"gemini-api\");
		export const API_BASE = \"https://example.invalid\";
		export const DEFAULT_MODEL = \"stub-model\";
		export function getApiKey() {
			globalThis.__calls.push({ type: \"gemini-api\" });
			return null;
		}
	`,
	"./gemini-web.js": `
		await import(\"./chrome-cookies.js\");
		globalThis.__loaded.push(\"gemini-web\");
		export async function isGeminiWebAvailable() {
			globalThis.__calls.push({ type: \"availability\", provider: \"gemini-web\" });
			return { cookie: true };
		}
		export async function queryWithCookies() {
			globalThis.__calls.push({ type: \"query\", provider: \"gemini-web\" });
			return \"Gemini answer\";
		}
	`,
	"./chrome-cookies.js": `
		globalThis.__loaded.push(\"chrome-cookies\");
		export const chromeCookiesLoaded = true;
	`,
};

const curatorWorkflowStubs = {
	"node:os": `
		export function platform() { return "linux"; }
		export function homedir() { return process.env.HOME; }
	`,
	"@mariozechner/pi-tui": `
		export class Box { constructor(...args) { this.args = args; } }
		export class Text { constructor(...args) { this.args = args; } }
		export function truncateToWidth(value) { return value; }
	`,
	"@mariozechner/pi-ai": `
		export function StringEnum(values, options = {}) { return { values, ...options }; }
		export async function complete() { return { stopReason: "stop", content: [{ type: "text", text: "summary" }] }; }
		export function getModel(provider, id) { return { provider, id }; }
	`,
	"typebox": `
		export const Type = {
			Object: (value) => value,
			Optional: (value) => value,
			Array: (value, options = {}) => ({ type: "array", value, ...options }),
			Number: (options = {}) => options,
			Integer: (options = {}) => options,
			String: (options = {}) => options,
			Boolean: (options = {}) => options,
		};
	`,
	"./summary-review.js": `
		globalThis.__loaded.push("summary-review");
		export async function generateSummaryDraft(results, _ctx, _signal, modelOverride) {
			return {
				summary: "Draft summary for " + results.length + " result(s)",
				meta: { model: modelOverride ?? null, durationMs: 1, tokenEstimate: 8, fallbackUsed: false, edited: false },
			};
		}
		export function buildDeterministicSummary(results) {
			return {
				summary: "Deterministic summary for " + results.length + " result(s)",
				meta: { model: null, durationMs: 0, tokenEstimate: 8, fallbackUsed: true, edited: false },
			};
		}
	`,
	"./curator-page.js": `
		globalThis.__loaded.push("curator-page");
		export function generateCuratorPage() { return "<html></html>"; }
	`,
	"./curator-server.js": `
		if (globalThis.__delayCuratorImport) await globalThis.__curatorImportGate;
		await import("./curator-page.js");
		globalThis.__loaded.push("curator-server");
		export async function startCuratorServer(options, callbacks) {
			globalThis.__calls.push({ type: "startCuratorServer", options });
			let closed = false;
			const handle = {
				server: {},
				url: "http://127.0.0.1:40123/?session=" + options.sessionToken,
				close() {
					if (closed) return;
					closed = true;
					globalThis.__calls.push({ type: "curatorClose", sessionToken: options.sessionToken });
				},
				pushResult(queryIndex, data) {
					globalThis.__calls.push({ type: "pushResult", queryIndex, provider: data.provider, resultCount: data.results.length });
				},
				pushError(queryIndex, error, provider) {
					globalThis.__calls.push({ type: "pushError", queryIndex, error, provider });
				},
				searchesDone() {
					globalThis.__calls.push({ type: "searchesDone", queryCount: options.queries.length });
					if (closed || !globalThis.__autoSubmitOnSearchesDone) return;
					queueMicrotask(() => {
						if (closed) return;
						callbacks.onSubmit({
							selectedQueryIndices: options.queries.map((_, index) => index),
							summary: "Approved summary for " + options.queries.join(" | "),
							summaryMeta: {
								model: options.defaultSummaryModel,
								durationMs: 9,
								tokenEstimate: 21,
								fallbackUsed: false,
								edited: false,
							},
						});
					});
				},
			};
			globalThis.__lastHandle = handle;
			return handle;
		}
	`,
	"./gemini-search.js": `
		globalThis.__loaded.push("gemini-search");
		export async function search(query, options = {}) {
			globalThis.__calls.push({ type: "search", query, provider: options.provider, includeContent: options.includeContent ?? false });
			return {
				answer: "Answer for " + query,
				results: [{ title: "Result for " + query, url: "https://example.com/" + encodeURIComponent(query) }],
				inlineContent: options.includeContent ? [{ url: "https://example.com/" + encodeURIComponent(query), title: "Inline", content: "Inline " + query, error: null }] : undefined,
				provider: options.provider === "auto" || options.provider === undefined ? "perplexity" : options.provider,
			};
		}
	`,
	"./perplexity.js": `
		globalThis.__loaded.push("perplexity");
		export function isPerplexityAvailable() {
			globalThis.__calls.push({ type: "availability", provider: "perplexity" });
			return true;
		}
	`,
	"./exa.js": `
		globalThis.__loaded.push("exa");
		export function isExaAvailable() {
			globalThis.__calls.push({ type: "availability", provider: "exa" });
			return false;
		}
	`,
	"./gemini-api.js": `
		globalThis.__loaded.push("gemini-api");
		export function isGeminiApiAvailable() {
			globalThis.__calls.push({ type: "availability", provider: "gemini-api" });
			return false;
		}
	`,
	"./chrome-cookies.js": `
		globalThis.__loaded.push("chrome-cookies");
		export const chromeCookiesLoaded = true;
	`,
	"./gemini-web.js": `
		await import("./chrome-cookies.js");
		globalThis.__loaded.push("gemini-web");
		export async function isGeminiWebAvailable() {
			globalThis.__calls.push({ type: "availability", provider: "gemini-web" });
			return { cookie: true };
		}
		export async function getActiveGoogleEmail() { return null; }
	`,
	"./extract.js": `
		globalThis.__loaded.push("extract");
		export async function fetchAllContent() { return []; }
	`,
	"./github-extract.js": `
		globalThis.__loaded.push("github-extract");
		export function clearCloneCache() {
			globalThis.__calls.push({ type: "clearCloneCache" });
		}
	`,
	"./code-search.js": `
		globalThis.__loaded.push("code-search");
		export async function executeCodeSearch() {
			return { content: [{ type: "text", text: "code" }], details: { mode: "code-context" } };
		}
	`,
};

function runModuleScript(script, home) {
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
	};
	delete env.PI_ALLOW_BROWSER_COOKIES;
	delete env.FEYNMAN_ALLOW_BROWSER_COOKIES;

	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env,
	});
}

test("google-account keeps Gemini Web and browser-cookie modules unloaded when cookies are disabled", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-google-account-disabled-"));
	const child = runModuleScript(`
		import assert from "node:assert/strict";
		import { existsSync, readFileSync } from "node:fs";
		import { registerHooks } from "node:module";
		import { fileURLToPath } from "node:url";

		globalThis.__loaded = [];
		globalThis.__calls = [];
		const stubs = new Map(Object.entries(${JSON.stringify(googleAccountStubs)}));

		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (stubs.has(specifier)) {
					return { url: "stub:" + specifier, shortCircuit: true };
				}
				if (specifier.startsWith("./") && specifier.endsWith(".js")) {
					const tsUrl = new URL(specifier.replace(/\\.js$/, ".ts"), context.parentURL);
					if (existsSync(fileURLToPath(tsUrl))) {
						return { url: tsUrl.href, shortCircuit: true };
					}
				}
				return nextResolve(specifier, context);
			},
			load(url, context, nextLoad) {
				if (url.startsWith("stub:")) {
					const source = stubs.get(url.slice(5));
					if (source === undefined) throw new Error("Missing stub for " + url);
					return { format: "module", source, shortCircuit: true };
				}
				if (url.startsWith("file:") && url.endsWith(".ts")) {
					return {
						format: "module-typescript",
						source: readFileSync(fileURLToPath(url), "utf8"),
						shortCircuit: true,
					};
				}
				const loaded = nextLoad(url, context);
				return { ...loaded, shortCircuit: true };
			},
		});

		const { default: activate } = await import(${JSON.stringify(indexUrl)});
		const commands = new Map();
		const messages = [];
		activate({
			registerTool() {},
			registerCommand(name, def) { commands.set(name, def); },
			registerShortcut() {},
			on() {},
			appendEntry() {},
			sendMessage(message, options) { messages.push({ message, options }); },
		});

		assert.equal(commands.has("google-account"), true);
		assert.deepEqual(globalThis.__loaded, []);
		await commands.get("google-account").handler();
		assert.deepEqual(globalThis.__loaded, []);
		assert.deepEqual(globalThis.__calls, []);
		assert.equal(messages.length, 1);
		assert.equal(messages[0].message.content[0].text, "Gemini Web browser cookie access is disabled. Set allowBrowserCookies: true in ~/.pi/web-search.json to enable it.");
		assert.deepEqual(messages[0].message.details, { available: false, cookieAccessAllowed: false });

		console.log(JSON.stringify({
			loaded: globalThis.__loaded,
			calls: globalThis.__calls,
			text: messages[0].message.content[0].text,
			details: messages[0].message.details,
		}));
	`, home);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.loaded, []);
	assert.deepEqual(output.calls, []);
	assert.equal(output.text, "Gemini Web browser cookie access is disabled. Set allowBrowserCookies: true in ~/.pi/web-search.json to enable it.");
	assert.deepEqual(output.details, { available: false, cookieAccessAllowed: false });
});

test("google-account loads Gemini Web only after cookie opt-in and reports the active account", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-google-account-enabled-"));
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "web-search.json"), JSON.stringify({ allowBrowserCookies: true }) + "\n", "utf8");

	const child = runModuleScript(`
		import assert from "node:assert/strict";
		import { existsSync, readFileSync } from "node:fs";
		import { registerHooks } from "node:module";
		import { fileURLToPath } from "node:url";

		globalThis.__loaded = [];
		globalThis.__calls = [];
		const stubs = new Map(Object.entries(${JSON.stringify(googleAccountStubs)}));

		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (stubs.has(specifier)) {
					return { url: "stub:" + specifier, shortCircuit: true };
				}
				if (specifier.startsWith("./") && specifier.endsWith(".js")) {
					const tsUrl = new URL(specifier.replace(/\\.js$/, ".ts"), context.parentURL);
					if (existsSync(fileURLToPath(tsUrl))) {
						return { url: tsUrl.href, shortCircuit: true };
					}
				}
				return nextResolve(specifier, context);
			},
			load(url, context, nextLoad) {
				if (url.startsWith("stub:")) {
					const source = stubs.get(url.slice(5));
					if (source === undefined) throw new Error("Missing stub for " + url);
					return { format: "module", source, shortCircuit: true };
				}
				if (url.startsWith("file:") && url.endsWith(".ts")) {
					return {
						format: "module-typescript",
						source: readFileSync(fileURLToPath(url), "utf8"),
						shortCircuit: true,
					};
				}
				const loaded = nextLoad(url, context);
				return { ...loaded, shortCircuit: true };
			},
		});

		const { default: activate } = await import(${JSON.stringify(indexUrl)});
		const commands = new Map();
		const messages = [];
		activate({
			registerTool() {},
			registerCommand(name, def) { commands.set(name, def); },
			registerShortcut() {},
			on() {},
			appendEntry() {},
			sendMessage(message, options) { messages.push({ message, options }); },
		});

		assert.equal(commands.has("google-account"), true);
		assert.deepEqual(globalThis.__loaded, []);
		await commands.get("google-account").handler();
		assert.deepEqual(globalThis.__loaded, ["chrome-cookies", "gemini-web"]);
		assert.deepEqual(globalThis.__calls, [
			{ type: "isGeminiWebAvailable" },
			{ type: "getActiveGoogleEmail", cookies: { cookie: true } },
		]);
		assert.equal(messages.length, 1);
		assert.equal(messages[0].message.content[0].text, "Active Google account: tlh@example.com");
		assert.deepEqual(messages[0].message.details, { available: true, email: "tlh@example.com" });

		console.log(JSON.stringify({
			loaded: globalThis.__loaded,
			calls: globalThis.__calls,
			text: messages[0].message.content[0].text,
			details: messages[0].message.details,
		}));
	`, home);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.loaded, ["chrome-cookies", "gemini-web"]);
	assert.deepEqual(output.calls, [
		{ type: "isGeminiWebAvailable" },
		{ type: "getActiveGoogleEmail", cookies: { cookie: true } },
	]);
	assert.equal(output.text, "Active Google account: tlh@example.com");
	assert.deepEqual(output.details, { available: true, email: "tlh@example.com" });
});

test("index bootstrap lazy-loads search/fetch/code paths and keeps background fetch cleanup safe", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-lazy-index-"));
	const child = runModuleScript(`
		import assert from "node:assert/strict";
		import { existsSync, readFileSync } from "node:fs";
		import { registerHooks } from "node:module";
		import { fileURLToPath } from "node:url";

		globalThis.__loaded = [];
		globalThis.__calls = [];
		globalThis.__delayExtractLoad = true;
		globalThis.__extractGate = new Promise((resolve) => {
			globalThis.__releaseExtractGate = resolve;
		});

		const stubs = new Map(Object.entries({
			"@mariozechner/pi-tui": \`
				export class Box { constructor(...args) { this.args = args; } }
				export class Text { constructor(...args) { this.args = args; } }
				export function truncateToWidth(value) { return value; }
			\`,
			"@mariozechner/pi-ai": \`
				export function StringEnum(values, options = {}) { return { values, ...options }; }
				export async function complete() { return \"\"; }
				export function getModel(model) { return model; }
			\`,
			"typebox": \`
				export const Type = {
					Object: (value) => value,
					Optional: (value) => value,
					Array: (value, options = {}) => ({ type: \"array\", value, ...options }),
					Number: (options = {}) => options,
					Integer: (options = {}) => options,
					String: (options = {}) => options,
					Boolean: (options = {}) => options,
				};
			\`,
			"./extract.js": \`
				await globalThis.__extractGate;
				globalThis.__loaded.push(\"extract\");
				export async function fetchAllContent(urls, signal, options = {}) {
					globalThis.__calls.push({ type: \"fetchAllContent\", urls, aborted: signal?.aborted ?? false, options });
					if (signal?.aborted) {
						const err = new Error(\"Aborted\");
						err.name = \"AbortError\";
						throw err;
					}
					return urls.map((url, index) => ({
						url,
						title: \"Fetched \" + (index + 1),
						content: \"content for \" + url,
						error: null,
					}));
				}
			\`,
			"./github-extract.js": \`
				globalThis.__loaded.push(\"github-extract\");
				export function clearCloneCache() {
					globalThis.__calls.push({ type: \"clearCloneCache\" });
				}
			\`,
			"./gemini-search.js": \`
				globalThis.__loaded.push(\"gemini-search\");
				export async function search(query, options = {}) {
					globalThis.__calls.push({ type: \"search\", query, options });
					return {
						answer: \"Answer for \" + query,
						results: [{ title: \"Result\", url: \"https://example.com/\" + encodeURIComponent(query) }],
						provider: options.provider === \"perplexity\" ? \"perplexity\" : \"exa\",
					};
				}
			\`,
			"./code-search.js": \`
				globalThis.__loaded.push(\"code-search\");
				export async function executeCodeSearch(_toolCallId, params) {
					globalThis.__calls.push({ type: \"code-search\", params });
					return {
						content: [{ type: \"text\", text: \"code context for \" + params.query }],
						details: { query: params.query, maxTokens: params.maxTokens ?? 5000, mode: \"code-context\" },
					};
				}
			\`,
			"./perplexity.js": \`
				globalThis.__loaded.push(\"perplexity\");
				export function isPerplexityAvailable() { return true; }
			\`,
			"./exa.js": \`
				globalThis.__loaded.push(\"exa\");
				export function isExaAvailable() { return true; }
			\`,
			"./gemini-api.js": \`
				globalThis.__loaded.push(\"gemini-api\");
				export function isGeminiApiAvailable() { return true; }
			\`,
			"./gemini-web.js": \`
				globalThis.__loaded.push(\"gemini-web\");
				export async function isGeminiWebAvailable() { return null; }
				export async function getActiveGoogleEmail() { return null; }
			\`,
			"./video-extract.js": \`
				globalThis.__loaded.push(\"video-extract\");
			\`,
			"./youtube-extract.js": \`
				globalThis.__loaded.push(\"youtube-extract\");
			\`,
		}));

		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (stubs.has(specifier)) {
					return { url: \`stub:\${specifier}\`, shortCircuit: true };
				}
				if (specifier.startsWith("./") && specifier.endsWith(".js")) {
					const tsUrl = new URL(specifier.replace(/\\.js$/, ".ts"), context.parentURL);
					if (existsSync(fileURLToPath(tsUrl))) {
						return { url: tsUrl.href, shortCircuit: true };
					}
				}
				return nextResolve(specifier, context);
			},
			load(url, context, nextLoad) {
				if (url.startsWith("stub:")) {
					const source = stubs.get(url.slice(5));
					if (source === undefined) {
						throw new Error("Missing stub for " + url);
					}
					return {
						format: "module",
						source,
						shortCircuit: true,
					};
				}
				if (url.startsWith("file:") && url.endsWith(".ts")) {
					return {
						format: "module-typescript",
						source: readFileSync(fileURLToPath(url), "utf8"),
						shortCircuit: true,
					};
				}
				const loaded = nextLoad(url, context);
				return { ...loaded, shortCircuit: true };
			},
		});

		const { default: activate } = await import(${JSON.stringify(indexUrl)});
		const tools = new Map();
		const events = new Map();
		const messages = [];
		const entries = [];
		const pi = {
			registerTool(def) { tools.set(def.name, def); },
			registerShortcut(key, def) { return { key, def }; },
			registerCommand(name, def) { return { name, def }; },
			on(event, handler) { events.set(event, handler); },
			appendEntry(type, data) { entries.push({ type, data }); },
			sendMessage(message, options) { messages.push({ message, options }); },
			async exec() { return { code: 0, stdout: \"\", stderr: \"\" }; },
		};

		activate(pi);

		const heavyModules = [
			"extract",
			"gemini-search",
			"code-search",
			"perplexity",
			"exa",
			"gemini-api",
			"gemini-web",
			"video-extract",
			"youtube-extract",
			"github-extract",
		];
		assert.deepEqual(globalThis.__loaded.filter((name) => heavyModules.includes(name)), []);

		events.get("session_start")({}, {
			hasUI: false,
			model: null,
			modelRegistry: null,
			sessionManager: { getBranch() { return []; } },
			ui: { notify() {}, setWidget() {} },
		});

		const webSearch = tools.get("web_search");
		const webSearchResult = await webSearch.execute(
			"call-1",
			{ query: "lazy path", workflow: "none", includeContent: true },
			undefined,
			undefined,
			{ hasUI: false },
		);
		assert.equal(typeof webSearchResult.details.fetchId, "string");
		assert.equal(globalThis.__loaded.includes("extract"), false);

		await events.get("session_shutdown")();
		globalThis.__releaseExtractGate();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(messages.some((entry) => entry.message.customType === "web-search-content-ready"), false);
		assert.equal(messages.some((entry) => entry.message.customType === "web-search-error"), false);
		assert.equal(globalThis.__calls.some((entry) => entry.type === "fetchAllContent" && entry.aborted === true), true);
		assert.equal(globalThis.__calls.some((entry) => entry.type === "clearCloneCache"), true);

		const fetchContent = tools.get("fetch_content");
		const fetchResult = await fetchContent.execute("call-2", { url: "https://example.com/fetch" }, undefined, undefined);
		assert.equal(fetchResult.details.successful, 1);
		assert.equal(typeof fetchResult.details.responseId, "string");
		assert.equal(fetchResult.content.at(-1).text.includes("content for https://example.com/fetch"), true);

		const getSearchContent = tools.get("get_search_content");
		const storedContent = await getSearchContent.execute("call-3", {
			responseId: fetchResult.details.responseId,
			urlIndex: 0,
		});
		assert.equal(storedContent.content[0].text.includes("content for https://example.com/fetch"), true);

		const codeSearch = tools.get("code_search");
		const codeResult = await codeSearch.execute("call-4", { query: "AbortSignal.any example" });
		assert.equal(codeResult.details.mode, "code-context");

		console.log(JSON.stringify({
			loaded: globalThis.__loaded,
			calls: globalThis.__calls,
			entries: entries.length,
			searchFetchId: webSearchResult.details.fetchId,
			fetchResponseId: fetchResult.details.responseId,
		}));
	`, home);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.loaded.includes("gemini-search"), true);
	assert.equal(output.loaded.includes("extract"), true);
	assert.equal(output.loaded.includes("code-search"), true);
	assert.equal(output.loaded.includes("video-extract"), false);
	assert.equal(output.loaded.includes("youtube-extract"), false);
	assert.equal(typeof output.searchFetchId, "string");
	assert.equal(typeof output.fetchResponseId, "string");
});

test("web_search summary-review and websearch command lazy-load curator workflow modules safely", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-curator-lazy-"));
	const child = runModuleScript(`
		import assert from "node:assert/strict";
		import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
		import { registerHooks } from "node:module";
		import { join } from "node:path";
		import { fileURLToPath } from "node:url";

		mkdirSync(join(process.env.HOME, ".pi"), { recursive: true });
		writeFileSync(
			join(process.env.HOME, ".pi", "web-search.json"),
			JSON.stringify({
				workflow: "summary-review",
				provider: "auto",
				curatorTimeoutSeconds: 77,
				summaryModel: "openai/gpt-4.1",
			}) + "\\n",
		);

		globalThis.__loaded = [];
		globalThis.__calls = [];
		globalThis.__delayCuratorImport = true;
		globalThis.__curatorImportGate = new Promise((resolve) => {
			globalThis.__releaseCuratorImport = resolve;
		});
		globalThis.__autoSubmitOnSearchesDone = true;

		const stubs = new Map(Object.entries(${JSON.stringify(curatorWorkflowStubs)}));

		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (stubs.has(specifier)) {
					return { url: "stub:" + specifier, shortCircuit: true };
				}
				if (specifier.startsWith("./") && specifier.endsWith(".js")) {
					const tsUrl = new URL(specifier.replace(/\\.js$/, ".ts"), context.parentURL);
					if (existsSync(fileURLToPath(tsUrl))) {
						return { url: tsUrl.href, shortCircuit: true };
					}
				}
				return nextResolve(specifier, context);
			},
			load(url, context, nextLoad) {
				if (url.startsWith("stub:")) {
					const source = stubs.get(url.slice(5));
					if (source === undefined) throw new Error("Missing stub for " + url);
					return { format: "module", source, shortCircuit: true };
				}
				if (url.startsWith("file:") && url.endsWith(".ts")) {
					return {
						format: "module-typescript",
						source: readFileSync(fileURLToPath(url), "utf8"),
						shortCircuit: true,
					};
				}
				const loaded = nextLoad(url, context);
				return { ...loaded, shortCircuit: true };
			},
		});

		const { default: activate } = await import(${JSON.stringify(indexUrl)});
		const tools = new Map();
		const commands = new Map();
		const events = new Map();
		const messages = [];
		const notifications = [];
		const execs = [];
		const pi = {
			registerTool(def) { tools.set(def.name, def); },
			registerCommand(name, def) { commands.set(name, def); },
			registerShortcut() {},
			on(event, handler) { events.set(event, handler); },
			appendEntry() {},
			sendMessage(message, options) { messages.push({ message, options }); },
			async exec(command, args) {
				execs.push({ command, args });
				return { code: 0, stdout: "", stderr: "" };
			},
		};

		activate(pi);

		const relevantModules = [
			"curator-server",
			"curator-page",
			"summary-review",
			"perplexity",
			"exa",
			"gemini-api",
			"gemini-web",
			"chrome-cookies",
			"gemini-search",
		];
		assert.deepEqual(globalThis.__loaded.filter((name) => relevantModules.includes(name)), []);
		assert.equal(tools.has("web_search"), true);
		assert.equal(commands.has("websearch"), true);

		const ctx = {
			hasUI: true,
			model: null,
			modelRegistry: {
				getAvailable() {
					return [
						{ provider: "anthropic", id: "claude-haiku-4-5" },
						{ provider: "openai", id: "gpt-4.1" },
					];
				},
				find(provider, id) { return { provider, id }; },
				async getApiKeyAndHeaders(model) { return { ok: true, apiKey: "key-" + model.provider + "-" + model.id, headers: {} }; },
			},
			sessionManager: { getBranch() { return []; } },
			ui: {
				notify(message, level) { notifications.push({ message, level }); },
				setWidget() {},
			},
		};

		events.get("session_start")({}, ctx);

		const webSearch = tools.get("web_search");
		const cancelledPromise = webSearch.execute("call-cancel", { query: "cancelled query" }, undefined, undefined, ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(globalThis.__loaded.includes("summary-review"), true);
		assert.equal(globalThis.__loaded.includes("curator-server"), false);
		events.get("session_tree")({}, ctx);
		globalThis.__releaseCuratorImport();
		const cancelledResult = await cancelledPromise;
		assert.equal(cancelledResult.details.cancelled, true);
		assert.equal(cancelledResult.details.cancelReason, "stale");
		assert.equal(globalThis.__calls.some((entry) => entry.type === "startCuratorServer"), false);

		globalThis.__delayCuratorImport = false;
		const curatedResult = await webSearch.execute(
			"call-curate",
			{ queries: ["alpha topic", "beta topic"] },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(typeof curatedResult.details.searchId, "string");
		assert.equal(curatedResult.details.curated, true);
		assert.equal(curatedResult.details.summary.workflow, "summary-review");
		assert.equal(curatedResult.details.summary.text, "Approved summary for alpha topic | beta topic");
		const toolStart = globalThis.__calls.filter((entry) => entry.type === "startCuratorServer")[0];
		assert.equal(toolStart.options.timeout, 77);
		assert.equal(toolStart.options.defaultProvider, "perplexity");
		assert.equal(toolStart.options.availableProviders.exa, false);
		assert.equal(toolStart.options.availableProviders.perplexity, true);
		assert.equal(toolStart.options.availableProviders.gemini, false);
		assert.equal(globalThis.__loaded.includes("gemini-web"), false);
		assert.equal(globalThis.__loaded.includes("chrome-cookies"), false);
		assert.equal(globalThis.__calls.some((entry) => entry.type === "availability" && entry.provider === "gemini-web"), false);
		assert.equal(toolStart.options.defaultSummaryModel, "openai/gpt-4.1");
		assert.deepEqual(toolStart.options.summaryModels.map((model) => model.value), [
			"anthropic/claude-haiku-4-5",
			"openai/gpt-4.1",
		]);

		const websearchCommand = commands.get("websearch");
		await websearchCommand.handler("command one, command two", ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const followUp = messages.find((entry) => entry.message.customType === "web-search-results");
		assert.equal(!!followUp, true);
		assert.equal(followUp.options.deliverAs, "followUp");
		assert.equal(followUp.message.details.summary.workflow, "summary-review");
		assert.equal(followUp.message.details.summary.text, "Approved summary for command one | command two");
		const commandStart = globalThis.__calls.filter((entry) => entry.type === "startCuratorServer")[1];
		assert.equal(commandStart.options.defaultProvider, "perplexity");
		assert.equal(commandStart.options.defaultSummaryModel, "openai/gpt-4.1");

		globalThis.__autoSubmitOnSearchesDone = false;
		await websearchCommand.handler("cleanup query", ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const closeCountBeforeShutdown = globalThis.__calls.filter((entry) => entry.type === "curatorClose").length;
		events.get("session_shutdown")();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const closeCountAfterShutdown = globalThis.__calls.filter((entry) => entry.type === "curatorClose").length;
		assert.equal(closeCountAfterShutdown, closeCountBeforeShutdown + 1);
		assert.equal(execs.some((entry) => entry.command === "xdg-open"), true);

		console.log(JSON.stringify({
			loaded: globalThis.__loaded,
			cancelledDetails: cancelledResult.details,
			curatedSummary: curatedResult.details.summary,
			toolStartOptions: toolStart.options,
			commandStartOptions: commandStart.options,
			followUpSummary: followUp.message.details.summary,
			messageTypes: messages.map((entry) => entry.message.customType),
			closeCountAfterShutdown,
			xdgOpenCount: execs.filter((entry) => entry.command === "xdg-open").length,
		}));
	`, home);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.loaded.includes("summary-review"), true);
	assert.equal(output.loaded.includes("curator-server"), true);
	assert.equal(output.loaded.includes("curator-page"), true);
	assert.equal(output.loaded.includes("perplexity"), true);
	assert.equal(output.loaded.includes("exa"), true);
	assert.equal(output.loaded.includes("gemini-api"), true);
	assert.equal(output.loaded.includes("gemini-web"), false);
	assert.equal(output.loaded.includes("chrome-cookies"), false);
	assert.equal(output.cancelledDetails.cancelReason, "stale");
	assert.equal(output.curatedSummary.workflow, "summary-review");
	assert.equal(output.curatedSummary.text, "Approved summary for alpha topic | beta topic");
	assert.equal(output.toolStartOptions.defaultProvider, "perplexity");
	assert.equal(output.toolStartOptions.timeout, 77);
	assert.equal(output.toolStartOptions.availableProviders.gemini, false);
	assert.equal(output.toolStartOptions.defaultSummaryModel, "openai/gpt-4.1");
	assert.equal(output.commandStartOptions.defaultProvider, "perplexity");
	assert.equal(output.followUpSummary.workflow, "summary-review");
	assert.equal(output.followUpSummary.text, "Approved summary for command one | command two");
	assert.equal(output.messageTypes.includes("web-search-results"), true);
	assert.equal(output.closeCountAfterShutdown >= 1, true);
	assert.equal(output.xdgOpenCount >= 1, true);
});

test("web_search workflow none imports real gemini-search without loading Gemini Web/browser cookies when cookies are disabled", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-web-search-none-"));
	const child = runModuleScript(`
		import assert from "node:assert/strict";
		import { existsSync, readFileSync } from "node:fs";
		import { registerHooks } from "node:module";
		import { fileURLToPath } from "node:url";

		globalThis.__loaded = [];
		globalThis.__calls = [];
		const stubs = new Map(Object.entries(${JSON.stringify(webSearchWorkflowNoneStubs)}));

		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (stubs.has(specifier)) {
					return { url: "stub:" + specifier, shortCircuit: true };
				}
				if (specifier.startsWith("./") && specifier.endsWith(".js")) {
					const tsUrl = new URL(specifier.replace(/\\.js$/, ".ts"), context.parentURL);
					if (existsSync(fileURLToPath(tsUrl))) {
						return { url: tsUrl.href, shortCircuit: true };
					}
				}
				return nextResolve(specifier, context);
			},
			load(url, context, nextLoad) {
				if (url.startsWith("stub:")) {
					const source = stubs.get(url.slice(5));
					if (source === undefined) throw new Error("Missing stub for " + url);
					return { format: "module", source, shortCircuit: true };
				}
				if (url.startsWith("file:") && url.endsWith(".ts")) {
					return {
						format: "module-typescript",
						source: readFileSync(fileURLToPath(url), "utf8"),
						shortCircuit: true,
					};
				}
				const loaded = nextLoad(url, context);
				return { ...loaded, shortCircuit: true };
			},
		});

		const { default: activate } = await import(${JSON.stringify(indexUrl)});
		const tools = new Map();
		activate({
			registerTool(def) { tools.set(def.name, def); },
			registerCommand() {},
			registerShortcut() {},
			on() {},
			appendEntry() {},
			sendMessage() {},
			async exec() { return { code: 0, stdout: "", stderr: "" }; },
		});

		assert.equal(tools.has("web_search"), true);
		assert.deepEqual(globalThis.__loaded, []);

		const result = await tools.get("web_search").execute(
			"call-none",
			{ query: "lazy search", workflow: "none" },
			undefined,
			undefined,
			{ hasUI: false },
		);

		assert.equal(result.details.queryCount, 1);
		assert.deepEqual(globalThis.__loaded, ["gemini-api", "perplexity", "exa"]);
		assert.deepEqual(globalThis.__calls, [
			{ type: "availability", provider: "exa" },
			{ type: "search", provider: "exa", query: "lazy search" },
		]);

		console.log(JSON.stringify({
			loaded: globalThis.__loaded,
			calls: globalThis.__calls,
			queryCount: result.details.queryCount,
		}));
	`, home);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.loaded, ["gemini-api", "perplexity", "exa"]);
	assert.deepEqual(output.calls, [
		{ type: "availability", provider: "exa" },
		{ type: "search", provider: "exa", query: "lazy search" },
	]);
	assert.equal(output.queryCount, 1);
});

test("gemini-search auto provider fallback stays Exa -> Perplexity -> Gemini API/Web", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-provider-order-"));
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "web-search.json"), JSON.stringify({ allowBrowserCookies: true }) + "\n", "utf8");
	const child = runModuleScript(`
		import assert from "node:assert/strict";
		import { existsSync, readFileSync } from "node:fs";
		import { registerHooks } from "node:module";
		import { fileURLToPath } from "node:url";

		globalThis.__order = [];
		const stubs = new Map(Object.entries({
			"./exa.js": \`
				export function hasExaApiKey() { return false; }
				export function isExaAvailable() {
					globalThis.__order.push(\"exa:available\");
					return true;
				}
				export async function searchWithExa() {
					globalThis.__order.push(\"exa:search\");
					throw new Error(\"exa failed\");
				}
			\`,
			"./perplexity.js": \`
				export function isPerplexityAvailable() {
					globalThis.__order.push(\"perplexity:available\");
					return true;
				}
				export async function searchWithPerplexity() {
					globalThis.__order.push(\"perplexity:search\");
					throw new Error(\"perplexity failed\");
				}
			\`,
			"./gemini-api.js": \`
				export const API_BASE = \"https://example.invalid\";
				export const DEFAULT_MODEL = \"stub-model\";
				export function getApiKey() {
					globalThis.__order.push(\"gemini-api\");
					return null;
				}
			\`,
			"./gemini-web.js": \`
				export async function isGeminiWebAvailable() {
					globalThis.__order.push(\"gemini-web:available\");
					return { cookie: true };
				}
				export async function queryWithCookies() {
					globalThis.__order.push(\"gemini-web:query\");
					return \"Gemini answer with source https://example.com/source\";
				}
			\`,
		}));

		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (stubs.has(specifier)) {
					return { url: \`stub:\${specifier}\`, shortCircuit: true };
				}
				if (specifier.startsWith("./") && specifier.endsWith(".js")) {
					const tsUrl = new URL(specifier.replace(/\\.js$/, ".ts"), context.parentURL);
					if (existsSync(fileURLToPath(tsUrl))) {
						return { url: tsUrl.href, shortCircuit: true };
					}
				}
				return nextResolve(specifier, context);
			},
			load(url, context, nextLoad) {
				if (url.startsWith("stub:")) {
					const source = stubs.get(url.slice(5));
					if (source === undefined) {
						throw new Error("Missing stub for " + url);
					}
					return {
						format: "module",
						source,
						shortCircuit: true,
					};
				}
				if (url.startsWith("file:") && url.endsWith(".ts")) {
					return {
						format: "module-typescript",
						source: readFileSync(fileURLToPath(url), "utf8"),
						shortCircuit: true,
					};
				}
				const loaded = nextLoad(url, context);
				return { ...loaded, shortCircuit: true };
			},
		});

		const { search } = await import(${JSON.stringify(geminiSearchUrl)});
		const result = await search("fallback trace", { provider: "auto" });

		assert.deepEqual(globalThis.__order, [
			"exa:available",
			"exa:search",
			"perplexity:available",
			"perplexity:search",
			"gemini-api",
			"gemini-web:available",
			"gemini-web:query",
		]);
		assert.equal(result.provider, "gemini");
		console.log(JSON.stringify({ order: globalThis.__order, provider: result.provider }));
	`, home);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.order, [
		"exa:available",
		"exa:search",
		"perplexity:available",
		"perplexity:search",
		"gemini-api",
		"gemini-web:available",
		"gemini-web:query",
	]);
	assert.equal(output.provider, "gemini");
});
