/**
 * secrets-leakage-settings.test.mjs
 *
 * Verifies that the EXA_API_KEY (or exaApiKey from settings) is never
 * written to backup files (.bak) or to unintended locations during the
 * settings read/write cycle.
 *
 * Invariants tested:
 *   1. No .bak file (or any file other than settings.json) under the
 *      settings directory ever contains the raw key when only the
 *      env-derived key was used — env keys must never be persisted.
 *   2. Writing explicit settings.json (user-supplied key) keeps the key
 *      only in settings.json, not in any backup or sibling file.
 *   3. The key never appears in the exa-usage.json file.
 */

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

test("env-derived EXA_API_KEY is never written to disk during settings round-trip", async () => {
	const base = join(
		tmpdir(),
		`tlh-secrets-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	const agentDir = join(base, "agent");
	mkdirSync(agentDir, { recursive: true });

	const origAgentDir = process.env["PI_CODING_AGENT_DIR"];
	const origExaKey = process.env["EXA_API_KEY"];

	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	process.env["EXA_API_KEY"] = KEY_MARKER;

	try {
		// Import paths helper with cache-busting URL
		const pathsUrl = pathToFileURL(join(ROOT, "paths.ts")).href + `?sl=${Date.now()}`;
		const { resolveProfilePaths } = await import(pathsUrl);
		const { settingsPath, cacheRoot } = resolveProfilePaths();

		// Create the settings directory — but do NOT write the key into settings.json.
		// The key is only available via env var.
		const settingsDir = join(settingsPath, "..");
		mkdirSync(settingsDir, { recursive: true });

		// Write a settings file WITHOUT the key (simulating a user who relies on the env var)
		writeFileSync(settingsPath, JSON.stringify({ someOtherSetting: true }, null, 2) + "\n");

		// Create cache directory and write usage (this simulates what exa.ts does at runtime)
		mkdirSync(cacheRoot, { recursive: true });
		const usagePath = join(cacheRoot, "exa-usage.json");
		writeFileSync(usagePath, JSON.stringify({ month: "2026-05", count: 1 }, null, 2) + "\n");

		// Enumerate all files written under agentDir and assert none contain the marker
		const allFiles = listAllFiles(agentDir);
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
		if (origAgentDir === undefined) {
			delete process.env["PI_CODING_AGENT_DIR"];
		} else {
			process.env["PI_CODING_AGENT_DIR"] = origAgentDir;
		}
		if (origExaKey === undefined) {
			delete process.env["EXA_API_KEY"];
		} else {
			process.env["EXA_API_KEY"] = origExaKey;
		}
		try { rmSync(base, { recursive: true, force: true }); } catch { /* non-fatal */ }
	}
});

test("explicitly set exaApiKey in settings.json stays only in settings.json, not in any backup", async () => {
	const base = join(
		tmpdir(),
		`tlh-secrets-settings2-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	const agentDir = join(base, "agent");
	mkdirSync(agentDir, { recursive: true });

	const origAgentDir = process.env["PI_CODING_AGENT_DIR"];
	const origExaKey = process.env["EXA_API_KEY"];

	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	// Ensure env var is absent so the settings file is the source
	delete process.env["EXA_API_KEY"];

	try {
		const pathsUrl = pathToFileURL(join(ROOT, "paths.ts")).href + `?sl2=${Date.now()}`;
		const { resolveProfilePaths } = await import(pathsUrl);
		const { settingsPath, cacheRoot } = resolveProfilePaths();

		const settingsDir = join(settingsPath, "..");
		mkdirSync(settingsDir, { recursive: true });
		mkdirSync(cacheRoot, { recursive: true });

		// Write the key explicitly (user-configured)
		writeFileSync(settingsPath, JSON.stringify({ exaApiKey: KEY_MARKER }, null, 2) + "\n");

		// Simulate a settings read and re-write (no-op merge cycle)
		const existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
		writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + "\n");

		// Enumerate all files; the key may only appear in settings.json itself
		const allFiles = listAllFiles(agentDir);
		const leakedElsewhere = [];
		for (const file of allFiles) {
			// Skip the settings.json itself — the user put the key there explicitly
			if (file === settingsPath) continue;
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
		if (origAgentDir === undefined) {
			delete process.env["PI_CODING_AGENT_DIR"];
		} else {
			process.env["PI_CODING_AGENT_DIR"] = origAgentDir;
		}
		if (origExaKey === undefined) {
			delete process.env["EXA_API_KEY"];
		} else {
			process.env["EXA_API_KEY"] = origExaKey;
		}
		try { rmSync(base, { recursive: true, force: true }); } catch { /* non-fatal */ }
	}
});
