/**
 * request-guard-size-cap.test.mjs
 *
 * Verifies per-fetch body size cap enforcement.
 *
 * Strategy:
 *   1. Spin up a local HTTP server on 127.0.0.1 that streams data exceeding
 *      the default 5 MiB cap (sends 10 MiB total).
 *   2. Create a guard with extraAllow=['127.0.0.1'] so the server is reachable.
 *   3. Assert that guard.fetch() throws ResponseTooLarge before reading all data.
 *   4. Also verify that a response within the cap succeeds.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

const { createRequestGuard, ResponseTooLarge } = await import(
	pathToFileURL(join(ROOT, "request-guard.ts")).href
);

const MB = 1024 * 1024;
const CHUNK = Buffer.alloc(64 * 1024, 0x41); // 64 KiB of 'A'

let server;
let baseUrl;

before(async () => {
	await new Promise((resolve, reject) => {
		server = http.createServer((req, res) => {
			const url = new URL(req.url, "http://localhost");
			const mb = parseInt(url.searchParams.get("mb") ?? "10", 10);
			const totalBytes = mb * MB;

			res.writeHead(200, {
				"Content-Type": "application/octet-stream",
				// Intentionally omit Content-Length to force streaming check
			});

			let sent = 0;
			function writeChunk() {
				if (sent >= totalBytes) {
					res.end();
					return;
				}
				const remaining = totalBytes - sent;
				const toWrite = remaining < CHUNK.length ? CHUNK.slice(0, remaining) : CHUNK;
				sent += toWrite.length;
				const ok = res.write(toWrite);
				if (ok) {
					setImmediate(writeChunk);
				} else {
					res.once("drain", writeChunk);
				}
			}
			writeChunk();
		});
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			baseUrl = `http://127.0.0.1:${port}`;
			resolve();
		});
		server.on("error", reject);
	});
});

after(async () => {
	await new Promise((resolve) => server.close(resolve));
});

test("throws ResponseTooLarge for a 10 MiB body (default 5 MiB cap)", async () => {
	const guard = createRequestGuard({ extraAllow: ["127.0.0.1"] });
	await assert.rejects(
		() => guard.fetch(`${baseUrl}/?mb=10`),
		(err) => {
			assert.ok(
				err instanceof ResponseTooLarge,
				`Expected ResponseTooLarge, got ${err?.constructor?.name}: ${err?.message}`,
			);
			assert.strictEqual(err.code, "response_too_large");
			return true;
		},
	);
});

test("throws ResponseTooLarge for custom cap exceeded", async () => {
	// 1 MiB cap, server sends 2 MiB
	const guard = createRequestGuard({
		extraAllow: ["127.0.0.1"],
		maxBodyBytes: 1 * MB,
	});
	await assert.rejects(
		() => guard.fetch(`${baseUrl}/?mb=2`),
		(err) => err instanceof ResponseTooLarge,
	);
});

test("succeeds for a body within the cap", async () => {
	// 10 MiB cap, server sends 1 MiB
	const guard = createRequestGuard({
		extraAllow: ["127.0.0.1"],
		maxBodyBytes: 10 * MB,
	});
	const response = await guard.fetch(`${baseUrl}/?mb=1`);
	assert.strictEqual(response.status, 200);
	const body = await response.arrayBuffer();
	assert.strictEqual(body.byteLength, 1 * MB);
});

test("throws ResponseTooLarge when Content-Length header exceeds cap", async () => {
	// Spin up a second server that sends a Content-Length header > cap
	const server2 = await new Promise((resolve, reject) => {
		const s = http.createServer((_req, res) => {
			// Claim 10 MiB in Content-Length, then close immediately
			res.writeHead(200, {
				"Content-Type": "text/plain",
				"Content-Length": String(10 * MB),
			});
			res.end("short body");
		});
		s.listen(0, "127.0.0.1", () => resolve(s));
		s.on("error", reject);
	});

	try {
		const { port } = server2.address();
		const url2 = `http://127.0.0.1:${port}/`;

		const guard = createRequestGuard({
			extraAllow: ["127.0.0.1"],
			maxBodyBytes: 1 * MB, // 1 MiB cap
		});

		await assert.rejects(
			() => guard.fetch(url2),
			(err) => err instanceof ResponseTooLarge,
		);
	} finally {
		await new Promise((resolve) => server2.close(resolve));
	}
});
