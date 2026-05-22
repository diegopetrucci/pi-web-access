/**
 * HOME-isolated runtime probe: verifies that settings and cache paths are
 * resolved exclusively under PI_CODING_AGENT_DIR and that no files are ever
 * written under HOME/.pi.
 *
 * Strategy:
 *   1. Create an isolated temp directory tree with a fake HOME and a fake
 *      PI_CODING_AGENT_DIR.
 *   2. Override process.env before importing the paths helper.
 *   3. Use resolveProfilePaths() to obtain the expected paths, perform a
 *      settings file round-trip (write + read), and assert:
 *        a. The settings file is under PI_CODING_AGENT_DIR.
 *        b. The cache root is under PI_CODING_AGENT_DIR.
 *        c. No file was created under HOME/.pi.
 *   4. Restore env and remove the temp tree at teardown.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

test("settings round-trip writes only under PI_CODING_AGENT_DIR, never under HOME/.pi", async () => {
	// ── Setup ────────────────────────────────────────────────────────────────
	const base = join(tmpdir(), `tlh-isolation-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const fakeHome = join(base, "home");
	const fakeAgentDir = join(base, "agent");
	mkdirSync(fakeHome, { recursive: true });
	mkdirSync(fakeAgentDir, { recursive: true });

	const origHome = process.env["HOME"];
	const origAgentDir = process.env["PI_CODING_AGENT_DIR"];

	process.env["HOME"] = fakeHome;
	process.env["PI_CODING_AGENT_DIR"] = fakeAgentDir;

	try {
		// ── Import paths helper with injected env ────────────────────────────
		// Use a cache-busting URL parameter so the module is re-evaluated even
		// if the test file is imported multiple times in the same process.
		const pathsUrl = pathToFileURL(join(ROOT, "paths.ts")).href + `?probe=${Date.now()}`;
		const { resolveProfilePaths } = await import(pathsUrl);

		// ── Resolve paths ────────────────────────────────────────────────────
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

		// ── Settings round-trip ──────────────────────────────────────────────
		const settingsDir = join(settingsPath, "..");
		mkdirSync(settingsDir, { recursive: true });

		const payload = { exaApiKey: "test-exa-key-xyz", testField: true };
		writeFileSync(settingsPath, JSON.stringify(payload, null, 2) + "\n");

		const read = JSON.parse(readFileSync(settingsPath, "utf-8"));
		assert.deepStrictEqual(read, payload, "Settings round-trip must preserve content exactly");

		// ── Assert no files under HOME/.pi ───────────────────────────────────
		const forbiddenPiDir = join(fakeHome, ".pi");
		assert.ok(
			!existsSync(forbiddenPiDir),
			`HOME/.pi must not be created. Found: ${forbiddenPiDir}`,
		);

	} finally {
		// ── Teardown: restore env ────────────────────────────────────────────
		if (origHome === undefined) {
			delete process.env["HOME"];
		} else {
			process.env["HOME"] = origHome;
		}
		if (origAgentDir === undefined) {
			delete process.env["PI_CODING_AGENT_DIR"];
		} else {
			process.env["PI_CODING_AGENT_DIR"] = origAgentDir;
		}

		// Remove temp tree
		try {
			rmSync(base, { recursive: true, force: true });
		} catch {
			// Non-fatal cleanup failure
		}
	}
});
