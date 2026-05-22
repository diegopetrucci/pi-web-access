/**
 * request-guard-scheme.test.mjs
 *
 * Verifies that the request guard rejects every non-http/https scheme
 * by throwing SchemeDenied from guard.validate().
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

const { createRequestGuard, SchemeDenied } = await import(
	pathToFileURL(join(ROOT, "request-guard.ts")).href
);

const DENIED_SCHEMES = [
	"file:///etc/passwd",
	"data:text/html,<h1>hello</h1>",
	"ftp://example.com/file.txt",
	"javascript:alert(1)",
	"gopher://gopher.example.com/",
];

for (const url of DENIED_SCHEMES) {
	test(`rejects scheme in: ${url.slice(0, 40)}`, async () => {
		const guard = createRequestGuard();
		await assert.rejects(
			() => guard.validate(url),
			(err) => {
				assert.ok(
					err instanceof SchemeDenied,
					`Expected SchemeDenied, got ${err?.constructor?.name}: ${err?.message}`,
				);
				assert.strictEqual(err.code, "scheme_denied");
				// URL property must be set
				assert.strictEqual(err.url, url);
				return true;
			},
		);
	});
}

test("allows http: scheme — validate returns URL without throwing", async () => {
	// DNS failure is treated as non-blocking, so validate() should succeed
	const guard = createRequestGuard({
		resolver: async () => { throw new Error("simulated dns failure"); },
	});
	const result = await guard.validate("http://example.com/");
	assert.ok(result instanceof URL, "validate should return a URL for allowed scheme");
	assert.strictEqual(result.protocol, "http:");
});

test("allows https: scheme — validate returns URL without throwing", async () => {
	const guard = createRequestGuard({
		resolver: async () => { throw new Error("simulated dns failure"); },
	});
	const result = await guard.validate("https://example.com/");
	assert.ok(result instanceof URL, "validate should return a URL for allowed scheme");
	assert.strictEqual(result.protocol, "https:");
});
