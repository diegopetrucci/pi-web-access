const STRINGIFIED_ARRAY_KEYS = ["queries", "domainFilter"] as const;

/** Prepare web_search array arguments before the host validates its schema. */
export function prepareWebSearchArguments(args: unknown): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const input = args as Record<string, unknown>;
	let output: Record<string, unknown> | undefined;
	for (const key of STRINGIFIED_ARRAY_KEYS) {
		const value = input[key];
		if (typeof value !== "string" || !value.trim().startsWith("[")) continue;
		try {
			const parsed: unknown = JSON.parse(value);
			if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
				output ??= { ...input };
				output[key] = parsed;
			}
		} catch {
			// Leave malformed compatibility inputs for normal schema validation.
		}
	}
	return output ?? args;
}
