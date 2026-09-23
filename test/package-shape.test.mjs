import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const releaseWorkflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

const EXPECTED_ALLOWLIST = [
	"activity.ts",
	"data-uri-sanitize.ts",
	"exa.ts",
	"extract.ts",
	"index.ts",
	"request-budget.ts",
	"rsc-extract.ts",
	"settings.ts",
	"ssrf-protection.ts",
	"storage.ts",
	"web-tools.ts",
	"README.md",
	"CHANGELOG.md",
	"SECURITY.md",
	"NOTICE",
	"LICENSE",
];

const EXPECTED_PACKAGE_FILES = [...EXPECTED_ALLOWLIST, "package.json"].sort();

function npmPackDryRun() {
	const npmExecPath = process.env.npm_execpath;
	const command = npmExecPath ? process.execPath : "npm";
	const args = npmExecPath
		? [npmExecPath, "pack", "--dry-run", "--json", "--ignore-scripts"]
		: ["pack", "--dry-run", "--json", "--ignore-scripts"];
	const result = spawnSync(command, args, { cwd: process.cwd(), encoding: "utf8" });
	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, result.stderr);
	const jsonStart = result.stdout.indexOf("[");
	assert.notEqual(jsonStart, -1, `npm pack did not return JSON: ${result.stdout}`);
	return JSON.parse(result.stdout.slice(jsonStart));
}

test("trusted publishing requires an explicit matching tag and checked-out commit", () => {
	assert.match(releaseWorkflow, /ref:\n\s+description: Release tag/);
	assert.match(releaseWorkflow, /ref:\n\s+description:[\s\S]*?\n\s+required: true/);
	assert.doesNotMatch(releaseWorkflow, /default:\s*main/);
	assert.match(releaseWorkflow, /EXPECTED_REF="tlh-v\$\{PACKAGE_VERSION\}"/);
	assert.match(releaseWorkflow, /TARGET_REF.*EXPECTED_REF/);
	assert.ok(releaseWorkflow.includes("ref: refs/tags/${{ inputs.ref }}"));
	assert.ok(releaseWorkflow.includes('TAG_REF="refs/tags/${TARGET_REF}"'));
	assert.ok(releaseWorkflow.includes('git show-ref --verify --quiet "${TAG_REF}"'));
	assert.ok(releaseWorkflow.includes('TAG_COMMIT="$(git rev-parse --verify "${TAG_REF}^{commit}")"'));
	assert.ok(releaseWorkflow.includes('HEAD_COMMIT="$(git rev-parse --verify HEAD)"'));
	assert.ok(releaseWorkflow.includes('if [[ "${TAG_COMMIT}" != "${HEAD_COMMIT}" ]]'));

	const checkout = releaseWorkflow.indexOf("ref: refs/tags/${{ inputs.ref }}");
	const tagIdentityCheck = releaseWorkflow.indexOf('git show-ref --verify --quiet "${TAG_REF}"');
	const tagCommit = releaseWorkflow.indexOf('TAG_COMMIT="$(git rev-parse --verify "${TAG_REF}^{commit}")"');
	const headCommit = releaseWorkflow.indexOf('HEAD_COMMIT="$(git rev-parse --verify HEAD)"');
	const identityCompare = releaseWorkflow.indexOf('if [[ "${TAG_COMMIT}" != "${HEAD_COMMIT}" ]]');
	const publish = releaseWorkflow.indexOf("run: npm publish");
	assert.ok(checkout < tagIdentityCheck);
	assert.ok(tagIdentityCheck < tagCommit);
	assert.ok(tagCommit < headCommit);
	assert.ok(headCommit < identityCompare);
	assert.ok(identityCompare < publish);
});

test("release audits runtime dependencies before package verification and publish", () => {
	assert.equal(packageJson.scripts["audit:runtime"], "npm audit --omit=dev");
	const audit = releaseWorkflow.indexOf("run: npm run audit:runtime");
	const packageCheck = releaseWorkflow.indexOf("run: npm run package:check");
	const publish = releaseWorkflow.indexOf("run: npm publish");
	assert.notEqual(audit, -1);
	assert.notEqual(packageCheck, -1);
	assert.notEqual(publish, -1);
	assert.ok(audit < packageCheck);
	assert.ok(audit < publish);
});

test("npm package contains only the v0.29.1 runtime and release allowlist", () => {
	assert.equal(packageJson.name, "@diegopetrucci/pi-web-access");
	assert.equal(packageJson.version, "0.29.1");
	assert.deepEqual(packageJson.files, EXPECTED_ALLOWLIST);

	const pack = npmPackDryRun();
	assert.equal(pack.length, 1);
	const paths = pack[0].files.map(({ path }) => path).sort();
	assert.deepEqual(paths, EXPECTED_PACKAGE_FILES);
	assert.doesNotMatch(paths.join("\n"), /^(?:test|docs|skills|\.gnosis|\.tickets|banner\.png|pi-web-fetch-demo\.mp4|.*\.tgz)(?:\/|$)/m);
});
