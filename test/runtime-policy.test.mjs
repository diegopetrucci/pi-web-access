import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { isSupportedNodeVersion } from "../runtime-policy.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));

test("only reviewed stable release lines at the security floors are supported", () => {
	for (const version of ["22.23.4", "22.23.5", "22.24.0", "24.22.1", "24.23.0", "26.12.1", "26.13.0"]) {
		assert.equal(isSupportedNodeVersion(version), true, version);
	}
	for (const version of ["20.99.0", "22.19.0", "22.23.3", "23.99.0", "24.22.0", "25.99.0", "26.12.0", "27.0.0", "24.22.1-rc.1", "26.12.1-nightly", "v24.22.1", "24.22", "024.22.1", "garbage", ""]) {
		assert.equal(isSupportedNodeVersion(version), false, version);
	}
});

test("npm engines and lockfile express the same supported release lines", () => {
	assert.equal(pkg.engines.node, ">=22.23.4 <23 || >=24.22.1 <25 || >=26.12.1 <27");
	const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url)));
	assert.equal(lock.packages[""].engines.node, pkg.engines.node);
});

test("unsafe runtimes fail before DNS, custom fetch, or request budget consumption", () => {
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
		import assert from "node:assert/strict";
		import { fetchRemoteUrl } from "./ssrf-protection.ts";
		import { remainingRequestOperations } from "./request-budget.ts";
		import register from "./index.ts";
		for (const version of ["22.23.3", "24.22.0", "26.12.0", "26.12.1-rc.1", "27.0.0"]) {
			Object.defineProperty(process.versions, "node", { value: version, configurable: true });
			const budget = remainingRequestOperations();
			assert.throws(() => register({}), /requires stable Node.js/);
			for (const options of [{}, {
				lookup: async () => { throw new Error("DNS must not run"); },
				fetch: async () => { throw new Error("custom fetch must not run"); },
			}]) {
				await assert.rejects(fetchRemoteUrl("https://example.com", {}, options), /requires stable Node.js/);
			}
			assert.equal(remainingRequestOperations(), budget);
		}
	`], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
});
