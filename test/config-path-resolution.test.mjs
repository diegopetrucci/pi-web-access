import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const utilsModuleUrl = new URL("../utils.ts", import.meta.url).href;
const geminiWebConfigModuleUrl = new URL("../gemini-web-config.ts", import.meta.url).href;

function runConfigProbe(home, extraEnv = {}) {
	const env = { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv };
	delete env.PI_ALLOW_BROWSER_COOKIES;
	delete env.FEYNMAN_ALLOW_BROWSER_COOKIES;
	delete env.PI_CODING_AGENT_DIR;
	delete env.XDG_CONFIG_HOME;
	Object.assign(env, extraEnv);

	return spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { getWebSearchConfigPath, getExaUsagePath } = await import(${JSON.stringify(utilsModuleUrl)});
			const { isBrowserCookieAccessAllowed } = await import(${JSON.stringify(geminiWebConfigModuleUrl)});
			console.log(JSON.stringify({
				configPath: getWebSearchConfigPath(),
				usagePath: getExaUsagePath(),
				cookiesAllowed: isBrowserCookieAccessAllowed(),
			}));
		`,
		encoding: "utf8",
		env,
	});
}

async function writeConfig(dir, data) {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "web-search.json"), JSON.stringify(data) + "\n", "utf8");
}

test("PI_CODING_AGENT_DIR takes precedence over XDG and home config", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-home-"));
	const agentDir = join(home, "agent-profile");
	const xdgDir = join(home, "xdg");

	await writeConfig(join(home, ".pi"), { allowBrowserCookies: false });
	await writeConfig(join(xdgDir, "pi"), { allowBrowserCookies: false });
	await writeConfig(agentDir, { allowBrowserCookies: true });

	const child = runConfigProbe(home, {
		PI_CODING_AGENT_DIR: agentDir,
		XDG_CONFIG_HOME: xdgDir,
	});
	assert.equal(child.status, 0, child.stderr);

	const result = JSON.parse(child.stdout);
	assert.equal(result.configPath, join(agentDir, "web-search.json"));
	assert.equal(result.usagePath, join(agentDir, "exa-usage.json"));
	assert.equal(result.cookiesAllowed, true);
});

test("XDG config is used when PI_CODING_AGENT_DIR is unset", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-xdg-"));
	const xdgDir = join(home, "xdg");

	await writeConfig(join(home, ".pi"), { allowBrowserCookies: false });
	await writeConfig(join(xdgDir, "pi"), { allowBrowserCookies: true });

	const child = runConfigProbe(home, { XDG_CONFIG_HOME: xdgDir });
	assert.equal(child.status, 0, child.stderr);

	const result = JSON.parse(child.stdout);
	assert.equal(result.configPath, join(xdgDir, "pi", "web-search.json"));
	assert.equal(result.usagePath, join(xdgDir, "pi", "exa-usage.json"));
	assert.equal(result.cookiesAllowed, true);
});

test("home .pi config is the fallback when neither PI_CODING_AGENT_DIR nor XDG is set", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-home-fallback-"));

	await writeConfig(join(home, ".pi"), { allowBrowserCookies: true });

	const child = runConfigProbe(home);
	assert.equal(child.status, 0, child.stderr);

	const result = JSON.parse(child.stdout);
	assert.equal(result.configPath, join(home, ".pi", "web-search.json"));
	assert.equal(result.usagePath, join(home, ".pi", "exa-usage.json"));
	assert.equal(result.cookiesAllowed, true);
});
