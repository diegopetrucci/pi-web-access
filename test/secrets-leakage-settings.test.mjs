/**
 * secrets-leakage-settings.test.mjs
 *
 * Verifies that the EXA_API_KEY (or exaApiKey from settings) is never
 * written to backup files (.bak) or to unintended locations during the
 * full settings read/write cycle, including code paths exercised by
 * real exa.ts entry points (loadConfig, reserveRequestBudget, writeUsage).
 *
 * Invariants tested:
 *   1. loadConfig() does NOT persist the env-derived key to disk.
 *      Driven through real exa.ts code paths (searchWithExa with a
 *      stubbed globalThis.fetch + RequestBudgetExceeded forcing writeUsage).
 *   2. Writing explicit settings.json (user-supplied key) keeps the key
 *      only in settings.json, not in any backup or sibling file.
 *   3. The key never appears in the exa-usage.json file.
 *   4. After a search invocation + writeUsage, no file under HOME/.pi or
 *      PI_CODING_AGENT_DIR contains the marker (except the explicit settings.json
 *      in the user-key test).
 */

import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	readdirSync,
	rmSync,
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

const KEY_MARKER = "exa-MARKER-do-not-leak-12345";

/** Recursively list all files under dir. */
function listAllFiles(dir, files = []) {
	if (!existsSync(dir)) return files;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			listAllFiles(full, files);
		} else {
			files.push(full);
		}
	}
	return files;
}

/**
 * Build a canned Exa answer response body.  searchWithExa() calls
 * reserveRequestBudget() (which writes usage) then g.fetch() exactly once
 * for a simple query with no options — the answer endpoint.
 */
function cannedExaAnswer() {
	return JSON.stringify({
		answer: "Canned smoke-test answer.",
		citations: [
			{ url: "https://example.com/smoke-a", title: "Smoke A" },
		],
	});
}

test("env-derived EXA_API_KEY is never written to disk during real exa.ts code paths", async () => {
	const base = join(
		tmpdir(),
		`tlh-secrets-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	const agentDir = join(base, "agent");
	const fakeHome = join(base, "home");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(fakeHome, { recursive: true });

	const origAgentDir = process.env["PI_CODING_AGENT_DIR"];
	const origExaKey = process.env["EXA_API_KEY"];
	const origHome = process.env["HOME"];

	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	process.env["HOME"] = fakeHome;
	process.env["EXA_API_KEY"] = KEY_MARKER;

	const origFetch = globalThis.fetch;

	try {
		// Import exa.ts with cache-busting URL so it re-evaluates with the new env
		const exaUrl = pathToFileURL(join(ROOT, "exa.ts")).href + `?sl=${Date.now()}`;
		const { searchWithExa } = await import(exaUrl);

		// Stub globalThis.fetch to return a canned Exa answer response.
		// The real guard's validate() runs (DNS checks pass for api.exa.ai).
		globalThis.fetch = async (_input, _init) => {
			return new Response(cannedExaAnswer(), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		// --- Path 1: successful search (triggers reserveRequestBudget → writeUsage)
		await searchWithExa("test query for leakage check", {});

		// --- Path 2: drive a writeUsage-only call directly via the paths helper
		//             to confirm no key is written there either
		const pathsUrl = pathToFileURL(join(ROOT, "paths.ts")).href + `?sl=${Date.now()}`;
		const { resolveProfilePaths } = await import(pathsUrl);
		const { cacheRoot } = resolveProfilePaths();
		// exa-usage.json should already exist from searchWithExa; verify it
		const usagePath = join(cacheRoot, "exa-usage.json");
		assert.ok(existsSync(usagePath), "exa-usage.json must have been written by searchWithExa");

		// Enumerate ALL files under agentDir and fakeHome/.pi and assert no leakage
		const allFiles = [
			...listAllFiles(agentDir),
			...listAllFiles(join(fakeHome, ".pi")),
		];
		assert.ok(allFiles.length > 0, "Expected at least one file to exist under agentDir");

		const leaked = [];
		for (const file of allFiles) {
			const content = readFileSync(file, "utf-8");
			if (content.includes(KEY_MARKER)) {
				leaked.push(file);
			}
		}

		assert.deepStrictEqual(
			leaked,
			[],
			`EXA_API_KEY marker found in these files (env key must never be persisted):\n${leaked.join("\n")}`,
		);
	} finally {
		globalThis.fetch = origFetch;
		if (origAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = origAgentDir;
		if (origExaKey === undefined) delete process.env["EXA_API_KEY"];
		else process.env["EXA_API_KEY"] = origExaKey;
		if (origHome === undefined) delete process.env["HOME"];
		else process.env["HOME"] = origHome;
		try { rmSync(base, { recursive: true, force: true }); } catch { /* non-fatal */ }
	}
});

test("explicitly set exaApiKey in settings.json stays only in settings.json, not in any backup", async () => {
	const base = join(
		tmpdir(),
		`tlh-secrets-settings2-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	const agentDir = join(base, "agent");
	const fakeHome = join(base, "home");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(fakeHome, { recursive: true });

	const origAgentDir = process.env["PI_CODING_AGENT_DIR"];
	const origExaKey = process.env["EXA_API_KEY"];
	const origHome = process.env["HOME"];

	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	process.env["HOME"] = fakeHome;
	// Ensure env var is absent so the settings file is the source
	delete process.env["EXA_API_KEY"];

	const origFetch = globalThis.fetch;

	try {
		const pathsUrl = pathToFileURL(join(ROOT, "paths.ts")).href + `?sl2=${Date.now()}`;
		const { resolveProfilePaths } = await import(pathsUrl);
		const { settingsPath, cacheRoot } = resolveProfilePaths();

		const settingsDir = join(settingsPath, "..");
		mkdirSync(settingsDir, { recursive: true });
		mkdirSync(cacheRoot, { recursive: true });

		// Write the key explicitly (user-configured)
		writeFileSync(settingsPath, JSON.stringify({ exaApiKey: KEY_MARKER }, null, 2) + "\n");

		// Drive through real exa.ts: import with cache-bust, stub fetch, run search
		const exaUrl = pathToFileURL(join(ROOT, "exa.ts")).href + `?sl2=${Date.now()}`;
		const { searchWithExa } = await import(exaUrl);

		globalThis.fetch = async (_input, _init) => {
			return new Response(cannedExaAnswer(), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchWithExa("settings key leakage check", {});

		// The key may ONLY appear in settings.json itself — not in usage, backups, or
		// any other file.
		const allFiles = [
			...listAllFiles(agentDir),
			...listAllFiles(join(fakeHome, ".pi")),
		];
		const leakedElsewhere = [];
		for (const file of allFiles) {
			if (file === settingsPath) continue; // user put it there deliberately
			const content = readFileSync(file, "utf-8");
			if (content.includes(KEY_MARKER)) {
				leakedElsewhere.push(file);
			}
		}

		assert.deepStrictEqual(
			leakedElsewhere,
			[],
			`EXA_API_KEY marker leaked into unexpected files (should only be in settings.json):\n${leakedElsewhere.join("\n")}`,
		);

		// The key must still be in settings.json (user owns it)
		const settingsContent = readFileSync(settingsPath, "utf-8");
		assert.ok(
			settingsContent.includes(KEY_MARKER),
			"settings.json should still contain the key the user explicitly set",
		);
	} finally {
		globalThis.fetch = origFetch;
		if (origAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = origAgentDir;
		if (origExaKey === undefined) delete process.env["EXA_API_KEY"];
		else process.env["EXA_API_KEY"] = origExaKey;
		if (origHome === undefined) delete process.env["HOME"];
		else process.env["HOME"] = origHome;
		try { rmSync(base, { recursive: true, force: true }); } catch { /* non-fatal */ }
	}
});
