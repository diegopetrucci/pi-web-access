import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

test("index exposes exactly the three tools without loading the runtime", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			import assert from "node:assert/strict";
			import { existsSync, readFileSync } from "node:fs";
			import { registerHooks } from "node:module";
			import { fileURLToPath } from "node:url";

			globalThis.__runtimeLoaded = false;
			globalThis.__agentStartForwarded = false;
			globalThis.__renderCalls = [];
			globalThis.__renderResults = [];
			const stubs = new Map(Object.entries({
				"typebox": \`
					export const Type = {
						Object: (value) => value,
						Optional: (value) => value,
						Array: (value) => ({ type: "array", value }),
						String: (options = {}) => options,
						Number: (options = {}) => options,
						Integer: (options = {}) => options,
						Boolean: (options = {}) => options,
						Unsafe: (value) => value,
					};
				\`,
				"@earendil-works/pi-tui": \`
					export class Text { constructor(value) { this.value = value; } }
				\`,
				"./web-tools.ts": \`
					globalThis.__runtimeLoaded = true;
					export default function registerRuntime(pi) {
						pi.on("agent_start", () => { globalThis.__agentStartForwarded = true; });
						for (const name of ["web_search", "fetch_content", "get_search_content"]) {
							pi.registerTool({
								name,
								async execute() {
									return {
										content: [{ type: "text", text: "model-visible content" }],
										details: { runtime: true, uiDiagnostic: "runtime-diagnostic-" + "x".repeat(1000) },
									};
								},
								renderCall(args, theme, context) {
									globalThis.__renderCalls.push({ name, args, context });
									return { value: "runtime-call:" + name };
								},
								renderResult(result, options, theme, context) {
									globalThis.__renderResults.push({ name, options, context });
									const diagnostic = typeof result?.details?.uiDiagnostic === "string"
										? result.details.uiDiagnostic.slice(0, 24)
										: "";
									return { value: "runtime-result:" + name + ":" + options.expanded + ":" + options.isPartial + ":" + diagnostic };
								},
							});
						}
					}
				\`,
			}));

			registerHooks({
				resolve(specifier, context, nextResolve) {
					if (stubs.has(specifier)) return { url: "stub:" + specifier, shortCircuit: true };
					if (specifier.startsWith("./") && specifier.endsWith(".ts")) {
						const file = new URL(specifier, context.parentURL);
						if (existsSync(fileURLToPath(file))) return { url: file.href, shortCircuit: true };
					}
					return nextResolve(specifier, context);
				},
				load(url, context, nextLoad) {
					if (url.startsWith("stub:")) return { format: "module", source: stubs.get(url.slice(5)), shortCircuit: true };
					if (url.startsWith("file:") && url.endsWith(".ts")) {
						return { format: "module-typescript", source: readFileSync(fileURLToPath(url), "utf8"), shortCircuit: true };
					}
					return nextLoad(url, context);
				},
			});

			process.env.PI_CODING_AGENT_DIR = process.cwd();
			const { default: activate } = await import(${JSON.stringify(indexUrl)});
			const tools = new Map();
			const events = new Map();
			activate({
				registerTool(definition) { tools.set(definition.name, definition); },
				on(event, handler) { events.set(event, handler); },
			});

			assert.deepEqual([...tools.keys()], ["web_search", "fetch_content", "get_search_content"]);
			assert.equal(globalThis.__runtimeLoaded, false);
			const theme = { fg: (_name, value) => value, bold: (value) => value };
			const preLoadCall = tools.get("web_search").renderCall({ query: "before load" }, theme);
			const preLoadResult = tools.get("web_search").renderResult(
				{ content: [{ type: "text", text: "fallback content" }] },
				{ expanded: true, isPartial: true },
				theme,
			);
			assert.equal(globalThis.__runtimeLoaded, false);
			assert.match(preLoadCall.value, /before load/);
			assert.match(preLoadResult.value, /fallback content/);
			assert.deepEqual(globalThis.__renderCalls, []);
			assert.deepEqual(globalThis.__renderResults, []);

			const result = await tools.get("web_search").execute("call-1", { query: "lazy" });
			assert.equal(globalThis.__runtimeLoaded, true);
			assert.equal(result.details.runtime, true);
			assert.doesNotMatch(JSON.stringify(result.content), /uiDiagnostic|runtime-diagnostic/);

			const runtimeCall = tools.get("web_search").renderCall({ query: "after load" }, theme);
			assert.equal(runtimeCall.value, "runtime-call:web_search");
			const expanded = tools.get("web_search").renderResult(result, { expanded: true, isPartial: false }, theme);
			const partial = tools.get("web_search").renderResult(result, { expanded: false, isPartial: true }, theme);
			assert.match(expanded.value, /^runtime-result:web_search:true:false:runtime-diagnostic-/);
			assert.match(partial.value, /^runtime-result:web_search:false:true:runtime-diagnostic-/);
			assert.ok(expanded.value.length < 80, "expanded UI diagnostics stay bounded");
			assert.doesNotMatch(expanded.value, /x{100}/);
			assert.deepEqual(globalThis.__renderResults.map((entry) => entry.options), [
				{ expanded: true, isPartial: false },
				{ expanded: false, isPartial: true },
			]);

			await events.get("agent_start")({ type: "agent_start" });
			assert.equal(globalThis.__agentStartForwarded, true);
			console.log(JSON.stringify({ tools: [...tools.keys()], runtimeLoaded: globalThis.__runtimeLoaded, agentStartForwarded: globalThis.__agentStartForwarded }));
		`,
		encoding: "utf8",
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		tools: ["web_search", "fetch_content", "get_search_content"],
		runtimeLoaded: true,
		agentStartForwarded: true,
	});
});
