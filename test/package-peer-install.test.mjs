import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const packagePath = packageManifest.name.split("/");
const hostLoaderPath = join(
	repoRoot,
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
	"dist",
	"core",
	"extensions",
	"loader.js",
);
const NPM_TIMEOUT_MS = 120_000;

function installedPackageRoot(installDir) {
	return join(installDir, "node_modules", ...packagePath);
}

function npmEnvironment(workspace) {
	return {
		...process.env,
		npm_config_audit: "false",
		npm_config_cache: join(workspace, "npm-cache"),
		npm_config_fund: "false",
		npm_config_update_notifier: "false",
		npm_config_userconfig: join(workspace, "npmrc"),
	};
}

function runNpm(args, cwd, env) {
	const npmExecPath = process.env.npm_execpath;
	const command = npmExecPath ? process.execPath : "npm";
	const commandArgs = npmExecPath ? [npmExecPath, ...args] : args;
	return execFileSync(command, commandArgs, {
		cwd,
		env,
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: NPM_TIMEOUT_MS,
	});
}

function parsePackOutput(output) {
	const jsonStart = output.indexOf("[");
	assert.notEqual(jsonStart, -1, `npm pack did not return JSON: ${output}`);
	const [pack] = JSON.parse(output.slice(jsonStart));
	assert.ok(pack?.filename, "npm pack did not return a tarball filename");
	return pack;
}

async function findInstalledPackages(root, name) {
	const matches = [];
	const visit = async (directory) => {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (error?.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const child = join(directory, entry.name);
			if (entry.name === name && entry.name !== "node_modules" && directory.endsWith("node_modules")) {
				matches.push(child);
				continue;
			}
			if (entry.name === "node_modules" || directory === root || directory.endsWith("node_modules")) await visit(child);
		}
	};
	await visit(root);
	return matches;
}

async function loadThroughHost(indexPath, hostProfile, hostCwd) {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
	process.env.PI_CODING_AGENT_DIR = hostProfile;
	process.env.PI_CODING_AGENT_SESSION_DIR = join(hostProfile, "sessions");
	try {
		const { loadExtensions } = await import(pathToFileURL(hostLoaderPath).href);
		return await loadExtensions([indexPath], hostCwd);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
		else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
	}
}

test("packed peer installs keep TypeBox host-provided and load through the pinned host loader", async () => {
	assert.equal(packageManifest.dependencies?.typebox, undefined);
	assert.equal(packageManifest.peerDependencies?.typebox, "*");
	assert.equal(packageManifest.devDependencies?.typebox, "1.3.27");
	assert.equal(packageManifest.dependencies?.undici, "^8.11.2");

	const workspace = await mkdtemp(join(tmpdir(), "pi-web-access-peer-install-"));
	try {
		const packDir = join(workspace, "pack");
		const normalDir = join(workspace, "normal-peer");
		const omittedDir = join(workspace, "omitted-peer");
		const hostProfile = join(workspace, "host-profile");
		const hostCwd = join(workspace, "host-cwd");
		await Promise.all([
			mkdir(packDir),
			mkdir(normalDir),
			mkdir(omittedDir),
			mkdir(hostProfile),
			mkdir(hostCwd),
		]);
		const env = npmEnvironment(workspace);
		const pack = parsePackOutput(runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], repoRoot, env));
		const packedFiles = pack.files.map((file) => file.path);
		assert.ok(packedFiles.includes("index.ts"));
		assert.ok(packedFiles.includes("tool-arguments.ts"));
		assert.ok(!packedFiles.some((path) => path.startsWith("test/")));
		const tarball = join(packDir, pack.filename);

		runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], normalDir, env);
		const normalPackageRoot = installedPackageRoot(normalDir);
		const normalRequire = createRequire(join(normalPackageRoot, "package.json"));
		const normalManifest = JSON.parse(readFileSync(join(normalPackageRoot, "package.json"), "utf8"));
		assert.equal(normalManifest.peerDependencies?.typebox, "*");
		assert.equal(normalManifest.dependencies?.typebox, undefined);
		const normalTypebox = normalRequire.resolve("typebox").replaceAll("\\", "/");
		assert.match(normalTypebox, /node_modules\/typebox\//);
		assert.equal(normalTypebox.includes(`${normalPackageRoot.replaceAll("\\", "/")}/node_modules/typebox/`), false);

		runNpm(["install", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund", tarball], omittedDir, env);
		const omittedPackageRoot = installedPackageRoot(omittedDir);
		const omittedRequire = createRequire(join(omittedPackageRoot, "package.json"));
		assert.throws(
			() => omittedRequire.resolve("typebox"),
			(error) => error?.code === "MODULE_NOT_FOUND" && error.message.includes("typebox"),
		);
		assert.deepEqual(await findInstalledPackages(omittedDir, "typebox"), []);
		assert.equal(existsSync(join(omittedPackageRoot, "node_modules", "typebox")), false);

		const hostRequire = createRequire(hostLoaderPath);
		const hostTypebox = hostRequire.resolve("typebox");
		assert.equal(relative(omittedPackageRoot, hostTypebox).startsWith(".."), true);
		assert.equal(existsSync(hostTypebox), true);
		const loaded = await loadThroughHost(join(omittedPackageRoot, "index.ts"), hostProfile, hostCwd);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		assert.deepEqual([...loaded.extensions[0].tools.keys()], ["web_search", "fetch_content", "get_search_content"]);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});
