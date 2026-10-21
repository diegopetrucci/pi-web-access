// October 2026 security floors. Keep package engines, CI, and docs aligned.
// Restrict support to reviewed release lines; a newer major is not proof of a fix.
const MINIMUM_RELEASES = new Map([
	[22, [23, 4]],
	[24, [22, 1]],
	[26, [12, 1]],
]);

export function isSupportedNodeVersion(version: string): boolean {
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
	if (!match) return false;
	const [major, minor, patch] = match.slice(1).map(Number);
	const minimum = MINIMUM_RELEASES.get(major);
	return minimum !== undefined &&
		(minor > minimum[0] || (minor === minimum[0] && patch >= minimum[1]));
}

export function assertSupportedNodeRuntime(): void {
	if (!isSupportedNodeVersion(process.versions.node)) {
		throw new Error(
			`pi-web-access requires stable Node.js 22.23.4+ (22.x), 24.22.1+ (24.x), or 26.12.1+ (26.x); found ${process.versions.node}. ` +
			"Upgrade the host Node runtime for the October 2026 security and eMudhra CA fixes before using web access.",
		);
	}
}
