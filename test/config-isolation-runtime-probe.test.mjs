/**
 * HOME-isolated runtime probe: verifies that settings and cache paths are
 * resolved exclusively under PI_CODING_AGENT_DIR and that no files are ever
 * written under HOME/.pi by actual exa.ts consumers.
 *
 * Strategy:
 *   1. Create an isolated temp directory tree with a fake HOME and a fake
 *      PI_CODING_AGENT_DIR.
 *   2. Import exa.ts (via the registerHooks .js→.ts remapping pattern) so
 *      real code paths are exercised (not just the paths helper).
 *   3. Call loadConfig() and writeUsage({ count: 1, month: "..." }) through
 *      their real entry points — triggered by calling searchWithExa() with a
 *      stubbed globalThis.fetch so no network access occurs.
 *   4. Assert:
 *        a. NO files under HOME/.pi (recursive walk).
 *        b. Files DO appear under PI_CODING_AGENT_DIR/extensions/pi-web-access/
 *           and/or PI_CODING_AGENT_DIR/cache/pi-web-access/ as expected.
 *   5. Restore env and remove the temp tree at teardown.
 */

import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdirSync,
	writeFileSync,
	existsSync,
	rmSync,
	readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

// ── Module resolution hook ─────────────────────────────────────────────────────
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (
			specifier.endsWith(".js") &&
			context.parentURL?.includes("/pi-web-access/")
		) {
			try {
				return nextResolve(specifier.slice(0, -3) + ".ts", context);
			} catch {
				// Fall through
			}
		}
		return nextResolve(specifier, context);
	},
});

/** Recursively walk a directory and return all file paths. */
function walkFiles(dir, files = []) {
	if (!existsSync(dir)) return files;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			walkFiles(full, files);
		} else {
			files.push(full);
		}
	}
	return files;
}

test("loadConfig() + writeUsage() write only under PI_CODING_AGENT_DIR, never under HOME/.pi", async () => {
	// ── Setup ────────────────────────────────────────────────────────────────
	const base = join(tmpdir(), `tlh-isolation-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const fakeHome = join(base, "home");
	const fakeAgentDir = join(base, "agent");
	mkdirSync(fakeHome, { recursive: true });
	mkdirSync(fakeAgentDir, { recursive: true });

	const origHome = process.env["HOME"];
	const origAgentDir = process.env["PI_CODING_AGENT_DIR"];
	const origExaKey = process.env["EXA_API_KEY"];
	const origFetch = globalThis.fetch;

	process.env["HOME"] = fakeHome;
	process.env["PI_CODING_AGENT_DIR"] = fakeAgentDir;
	process.env["EXA_API_KEY"] = "exa-test-key-isolation-probe";

	try {
		// ── Verify path resolution ────────────────────────────────────────────
		const pathsUrl = pathToFileURL(join(ROOT, "paths.ts")).href + `?probe=${Date.now()}`;
		const { resolveProfilePaths } = await import(pathsUrl);
		const { settingsPath, cacheRoot } = resolveProfilePaths();

		// Both paths must be rooted under PI_CODING_AGENT_DIR
		assert.ok(
			settingsPath.startsWith(fakeAgentDir),
			`settingsPath must start with PI_CODING_AGENT_DIR.\n  got: ${settingsPath}\n  expected prefix: ${fakeAgentDir}`,
		);
		assert.ok(
			cacheRoot.startsWith(fakeAgentDir),
			`cacheRoot must start with PI_CODING_AGENT_DIR.\n  got: ${cacheRoot}\n  expected prefix: ${fakeAgentDir}`,
		);

		// Exact suffix check per spec
		assert.ok(
			settingsPath.endsWith(join("extensions", "pi-web-access", "settings.json")),
			`settingsPath suffix mismatch: ${settingsPath}`,
		);
		assert.ok(
			cacheRoot.endsWith(join("cache", "pi-web-access")),
			`cacheRoot suffix mismatch: ${cacheRoot}`,
		);

		// ── Import exa.ts and exercise real loadConfig() + writeUsage() ──────
		// Use a cache-busting URL so the module re-evaluates with the new env.
		const exaUrl = pathToFileURL(join(ROOT, "exa.ts")).href + `?probe=${Date.now()}`;
		const { searchWithExa } = await import(exaUrl);

		// Stub globalThis.fetch so no network calls are made.
		globalThis.fetch = async (_input, _init) => {
			return new Response(
				JSON.stringify({ answer: "probe answer", citations: [] }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		// searchWithExa() calls loadConfig() (reads/creates settingsPath area)
		// and reserveRequestBudget() which calls writeUsage() (writes to cacheRoot).
		await searchWithExa("probe test query", {});

		// ── Assert NO files under HOME/.pi ─────────────────────────────────────
		const forbiddenPiDir = join(fakeHome, ".pi");
		const piFiles = walkFiles(forbiddenPiDir);
		assert.deepStrictEqual(
			piFiles,
			[],
			`HOME/.pi must not contain any files; found:\n${piFiles.join("\n")}`,
		);
		assert.ok(
			!existsSync(forbiddenPiDir),
			`HOME/.pi directory itself must not be created. Found: ${forbiddenPiDir}`,
		);

		// ── Assert expected files exist under PI_CODING_AGENT_DIR ─────────────
		const usagePath = join(cacheRoot, "exa-usage.json");
		assert.ok(
			existsSync(usagePath),
			`exa-usage.json must exist under PI_CODING_AGENT_DIR/cache/pi-web-access/; not found at ${usagePath}`,
		);

		// Confirm the usage file is under PI_CODING_AGENT_DIR
		assert.ok(
			usagePath.startsWith(fakeAgentDir),
			`exa-usage.json path must be under PI_CODING_AGENT_DIR; got: ${usagePath}`,
		);

	} finally {
		// ── Teardown: restore env ────────────────────────────────────────────
		globalThis.fetch = origFetch;
		if (origHome === undefined) delete process.env["HOME"];
		else process.env["HOME"] = origHome;
		if (origAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = origAgentDir;
		if (origExaKey === undefined) delete process.env["EXA_API_KEY"];
		else process.env["EXA_API_KEY"] = origExaKey;

		// Remove temp tree
		try {
			rmSync(base, { recursive: true, force: true });
		} catch {
			// Non-fatal cleanup failure
		}
	}
});
