/**
 * redact.ts
 *
 * Key-redaction helpers for log and error output.
 * Prevents raw API credentials from appearing in error messages, logs,
 * or any other observable surface.
 *
 * Design:
 *   - `redactKey(key)`  — produce a safe display form of a key string.
 *   - `scrubKey(text, key)` — remove any literal occurrence of `key` from text,
 *     replacing each occurrence with the redacted form.
 *
 * Consistent redaction format: `exa-***` for Exa keys (prefix preserved so the
 * key type is identifiable), `***` for anything else.
 */

/**
 * Produce a safe display form of an API key.
 *
 * Examples:
 *   redactKey("exa-MARKER-do-not-leak-12345") → "exa-***"
 *   redactKey("sk-abcdef")                    → "***"
 *   redactKey(null)                           → ""
 *   redactKey("")                             → ""
 */
export function redactKey(key: string | null | undefined): string {
	if (!key || typeof key !== "string" || key.trim().length === 0) return "";
	if (key.startsWith("exa-")) return "exa-***";
	return "***";
}

/**
 * Replace every literal occurrence of `key` in `text` with the redacted form.
 * Safe to call with a null/undefined key (returns text unchanged).
 */
export function scrubKey(text: string, key: string | null | undefined): string {
	if (!key || typeof key !== "string" || key.trim().length === 0) return text;
	const redacted = redactKey(key);
	return text.split(key).join(redacted);
}
