import { join } from "node:path";

/**
 * Resolve profile-relative paths for pi-web-access.
 *
 * When running inside Pi, PI_CODING_AGENT_DIR is set by the runtime and is
 * used as the base directory. Tests or standalone tooling may pass an explicit
 * `baseDir` to avoid depending on the environment variable.
 *
 * Settings file:  <base>/extensions/pi-web-access/settings.json
 * Cache root:     <base>/cache/pi-web-access/
 *
 * The fork must never read from or write to the upstream Pi config directory.
 * See web-search-spec.md (Config paths & no-migration policy) for the locked policy.
 */
export function resolveProfilePaths(baseDir?: string): {
	settingsPath: string;
	cacheRoot: string;
} {
	const base = baseDir ?? process.env["PI_CODING_AGENT_DIR"];
	if (!base) {
		throw new Error(
			"[pi-web-access] PI_CODING_AGENT_DIR is not set. " +
			"Run inside a Pi agent, or set PI_CODING_AGENT_DIR explicitly.",
		);
	}
	return {
		settingsPath: join(base, "extensions", "pi-web-access", "settings.json"),
		cacheRoot: join(base, "cache", "pi-web-access"),
	};
}
