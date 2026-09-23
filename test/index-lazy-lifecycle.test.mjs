import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const requestBudgetUrl = new URL("../request-budget.ts", import.meta.url).href;

function runChild(source) {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: source,
		encoding: "utf8",
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

const loaderPrelude = ({ body }) => `
	import assert from "node:assert/strict";
	import { existsSync, readFileSync } from "node:fs";
	import { registerHooks } from "node:module";
	import { fileURLToPath } from "node:url";
	import { relative } from "node:path";

	const loaded = [];
	const trackedDependencies = new Set(["p-limit", "linkedom", "@mozilla/readability", "turndown", "defuddle/node", "undici"]);
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
	}));

	function track(url) {
		if (!url.startsWith("file:")) return;
		const path = fileURLToPath(url);
		if (path.endsWith(".ts")) loaded.push(relative(process.cwd(), path));
	}

	registerHooks({
		resolve(specifier, context, nextResolve) {
			if (trackedDependencies.has(specifier)) loaded.push(specifier);
			if (stubs.has(specifier)) return { url: "stub:" + specifier, shortCircuit: true };
			if (specifier.startsWith("./") && specifier.endsWith(".ts")) {
				const file = new URL(specifier, context.parentURL);
				if (existsSync(fileURLToPath(file))) {
					track(file.href);
					return { url: file.href, shortCircuit: true };
				}
			}
			return nextResolve(specifier, context);
		},
		load(url, context, nextLoad) {
			if (url.startsWith("stub:")) return { format: "module", source: stubs.get(url.slice(5)), shortCircuit: true };
			if (url.startsWith("file:") && url.endsWith(".ts")) {
				let source = readFileSync(fileURLToPath(url), "utf8");
				if (url.endsWith("/web-tools.ts")) {
					source = [
						"globalThis.__runtimeLoaded = true;",
						source.replaceAll("restoreFromSession(ctx);", "globalThis.__restoreCount = (globalThis.__restoreCount ?? 0) + 1; restoreFromSession(ctx);"),
					].join("\\n");
				}
				return { format: "module-typescript", source, shortCircuit: true };
			}
			return nextLoad(url, context);
		},
	});

	process.env.PI_CODING_AGENT_DIR = process.cwd();
	const budget = await import(${JSON.stringify(requestBudgetUrl)});
	const { default: activate } = await import(${JSON.stringify(indexUrl)});
	const tools = new Map();
	const events = new Map();
	activate({
		registerTool(definition) { tools.set(definition.name, definition); },
		on(event, handler) { events.set(event, handler); },
	});
	assert.deepEqual([...tools.keys()], ["web_search", "fetch_content", "get_search_content"]);
	${body}
`;

function isRuntimeGraphModule(path) {
	return [
		"web-tools.ts",
		"extract.ts",
		"storage.ts",
		"exa.ts",
		"ssrf-protection.ts",
		"rsc-extract.ts",
		"data-uri-sanitize.ts",
		"activity.ts",
		"p-limit",
		"linkedom",
		"@mozilla/readability",
		"turndown",
		"defuddle/node",
		"undici",
	].some((name) => path.endsWith(name) || path === name);
}

test("startup lifecycle events stay lazy and latest session restore is replayed once", () => {
	const result = runChild(loaderPrelude({ body: `
		const branch = (id) => ({
			sessionManager: {
				getBranch: () => [{
					type: "custom",
					customType: "web-search-results",
					data: {
						id,
						type: "search",
						timestamp: Date.now(),
						queries: [{ query: "cached", results: [{ title: id, url: "https://example.com/" + id, snippet: "stored " + id }], error: null }],
					},
				}],
			},
		});
		const startupModules = loaded.slice();
		budget.resetRequestOperations();
		for (let index = 0; index < 6; index += 1) budget.consumeRequestOperation();
		events.get("agent_start")({ type: "agent_start" });
		assert.equal(budget.remainingRequestOperations(), 6);
		events.get("session_start")({ type: "session_start", reason: "resume" }, branch("old"));
		events.get("session_tree")({ type: "session_tree", newLeafId: "latest", oldLeafId: "old" }, branch("latest"));
		assert.equal(globalThis.__runtimeLoaded, undefined);
		const startupRuntimeGraph = loaded.filter(${isRuntimeGraphModule.toString()});
		assert.deepEqual(startupRuntimeGraph, []);
		assert.deepEqual(loaded.slice(), startupModules);

		const restored = await tools.get("get_search_content").execute("call", { responseId: "latest", queryIndex: 0 });
		assert.equal(globalThis.__runtimeLoaded, true);
		assert.match(restored.content[0].text, /stored latest/);
		assert.doesNotMatch(restored.content[0].text, /stored old/);

		budget.resetRequestOperations();
		for (let index = 0; index < 6; index += 1) budget.consumeRequestOperation();
		events.get("agent_start")({ type: "agent_start" });
		assert.equal(budget.remainingRequestOperations(), 6);

		events.get("session_tree")({ type: "session_tree", newLeafId: "later", oldLeafId: "latest" }, branch("later"));
		assert.equal(globalThis.__restoreCount, 2);
		const later = await tools.get("get_search_content").execute("call", { responseId: "later", queryIndex: 0 });
		assert.match(later.content[0].text, /stored later/);
		console.log(JSON.stringify({
			startupRuntimeGraph,
			runtimeGraph: loaded.filter(${isRuntimeGraphModule.toString()}),
			runtimeLoaded: globalThis.__runtimeLoaded,
			restored: globalThis.__restoreCount,
			budgetAfterLoadedAgentStart: budget.remainingRequestOperations(),
		}));
	` }));

	assert.deepEqual(result.startupRuntimeGraph, []);
	assert.ok(result.runtimeGraph.includes("web-tools.ts"));
	assert.equal(result.runtimeLoaded, true);
	assert.equal(result.restored, 2);
	assert.equal(result.budgetAfterLoadedAgentStart, 6);
});

test("shutdown drops pending restore context without loading runtime", () => {
	const result = runChild(loaderPrelude({ body: `
		const context = {
			sessionManager: {
				getBranch: () => [{
					type: "custom",
					customType: "web-search-results",
					data: {
						id: "discarded",
						type: "search",
						timestamp: Date.now(),
						queries: [{ query: "cached", results: [{ title: "discarded", url: "https://example.com/discarded", snippet: "should not restore" }], error: null }],
					},
				}],
			},
		};
		events.get("session_start")({ type: "session_start", reason: "resume" }, context);
		events.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
		assert.equal(globalThis.__runtimeLoaded, undefined);
		const startupRuntimeGraph = loaded.filter(${isRuntimeGraphModule.toString()});
		assert.deepEqual(startupRuntimeGraph, []);
		const result = await tools.get("get_search_content").execute("call", { responseId: "discarded", queryIndex: 0 });
		assert.equal(globalThis.__runtimeLoaded, true);
		assert.match(result.content[0].text, /Stored content was not found/);
		console.log(JSON.stringify({ restored: globalThis.__restoreCount ?? 0, startupRuntimeGraph, runtimeGraph: loaded.filter(${isRuntimeGraphModule.toString()}) }));
	` }));

	assert.equal(result.restored, 0);
	assert.deepEqual(result.startupRuntimeGraph, []);
	assert.ok(result.runtimeGraph.includes("web-tools.ts"));
});
