/**
 * CI grep test: scans fork source for forbidden ~/.pi path patterns.
 *
 * Reads each .ts and .mjs file under the repo root, excluding:
 *   test/, dist/, node_modules/, docs/, CHANGELOG.md, NOTICE, README.md,
 *   and this test file itself.
 *
 * Asserts zero matches for:
 *   - \.pi[/'"]   (path component referencing the .pi directory)
 *   - ~/.pi       (explicit home-dir reference)
 *   - web-search.json  (upstream legacy config filename)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

const FORBIDDEN_PATTERNS = [
	/\.pi[/'"]/,
	/~\/\.pi/,
	/web-search\.json/,
];

const EXCLUDED_DIRS = new Set(["test", "dist", "node_modules", "docs", ".git"]);
const EXCLUDED_FILES = new Set(["CHANGELOG.md", "NOTICE", "README.md"]);
const ALLOWED_EXTENSIONS = new Set([".ts", ".mjs", ".cjs", ".js"]);
const THIS_FILE = fileURLToPath(import.meta.url);

/**
 * Recursively collect source files, honouring the exclusion rules.
 */
function collectSourceFiles(dir, files = []) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			if (!EXCLUDED_DIRS.has(entry)) {
				collectSourceFiles(full, files);
			}
		} else {
			if (
				!EXCLUDED_FILES.has(entry) &&
				ALLOWED_EXTENSIONS.has(extname(entry)) &&
				full !== THIS_FILE
			) {
				files.push(full);
			}
		}
	}
	return files;
}

test("source files contain no forbidden ~/.pi path references", () => {
	const files = collectSourceFiles(ROOT);
	const violations = [];

	for (const file of files) {
		const content = readFileSync(file, "utf-8");
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			for (const pattern of FORBIDDEN_PATTERNS) {
				if (pattern.test(line)) {
					violations.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
					break; // one violation per line is enough
				}
			}
		}
	}

	assert.deepStrictEqual(
		violations,
		[],
		`Forbidden ~/.pi references found in source:\n${violations.join("\n")}`,
	);
});
