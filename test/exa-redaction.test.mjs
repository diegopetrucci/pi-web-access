import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const exaUrl = new URL("../exa.ts", import.meta.url).href;
const requestBudgetUrl = new URL("../request-budget.ts", import.meta.url).href;

function runChild(source) {
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: source,
		encoding: "utf8",
		env: (() => {
			const env = { ...process.env };
			delete env.PI_CODING_AGENT_DIR;
			delete env.EXA_API_KEY;
			return env;
		})(),
	});
}

test("Exa provider errors redact configured credentials", () => {
	const child = runChild(`
		const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const root = await mkdtemp(join(tmpdir(), "pi-web-access-exa-redaction-"));
		await mkdir(join(root, "extensions", "pi-web-access"), { recursive: true });
		await writeFile(join(root, "extensions", "pi-web-access", "settings.json"), JSON.stringify({ exaApiKey: "ticket-only-key" }));
		process.env.PI_CODING_AGENT_DIR = root;
		const fetch = async () => new Response("provider echoed ticket-only-key", { status: 500 });
		globalThis.fetch = fetch;
		const { resetRequestOperations } = await import(${JSON.stringify(requestBudgetUrl)});
		resetRequestOperations();
		const { searchWithExa } = await import(${JSON.stringify(exaUrl)});
		let message = "";
		try { await searchWithExa("redaction", { fetch }); } catch (error) { message = error.message; }
		console.log(JSON.stringify({ message }));
	`);
	assert.equal(child.status, 0, child.stderr);
	const { message } = JSON.parse(child.stdout.trim());
	assert.equal(message.includes("ticket-only-key"), false);
	assert.match(message, /\[redacted\]/);
});
