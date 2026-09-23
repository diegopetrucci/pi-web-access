import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isIP } from "node:net";

export const SETTINGS_RELATIVE_PATH = ["extensions", "pi-web-access", "settings.json"] as const;
export const CACHE_RELATIVE_PATH = ["cache", "pi-web-access"] as const;
export const MAX_SETTINGS_BYTES = 64 * 1024;
export const DEFAULT_FETCH_TIMEOUT_SECONDS = 30;
export const MIN_FETCH_TIMEOUT_SECONDS = 1;
export const MAX_FETCH_TIMEOUT_SECONDS = 120;
export const MAX_DOMAIN_POLICY_ENTRIES = 64;
export const MIN_INLINE_CONTENT_CHARS = 512;
export const DEFAULT_MAX_INLINE_CONTENT_CHARS = 12_000;
export const MAX_INLINE_CONTENT_CHARS = 30_000;

export interface DomainPolicy {
	allow: string[];
	deny: string[];
}

export type WebSettings = Record<string, unknown>;

function settingsError(message: string): Error {
	return new Error(`[pi-web-access] ${message}`);
}

/** Return the configured TLH profile, without falling back to any legacy path. */
export function requireAgentDir(): string {
	const value = process.env.PI_CODING_AGENT_DIR?.trim();
	if (!value) {
		throw settingsError("PI_CODING_AGENT_DIR is required for pi-web-access tool use");
	}
	if (value.includes("\0") || !isAbsolute(value)) {
		throw settingsError("PI_CODING_AGENT_DIR must be an absolute path");
	}
	return value;
}

export function getSettingsPath(agentDir = requireAgentDir()): string {
	return join(agentDir, ...SETTINGS_RELATIVE_PATH);
}

export function getCacheDir(agentDir = requireAgentDir()): string {
	return join(agentDir, ...CACHE_RELATIVE_PATH);
}

export function getCachePath(name: string, agentDir = requireAgentDir()): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)) {
		throw settingsError("cache file name is invalid");
	}
	return join(getCacheDir(agentDir), name);
}

/**
 * Settings are deliberately read on every call. The file is small and request
 * credentials/policies must rotate without restarting the extension.
 */
export function readSettings(): WebSettings {
	const path = getSettingsPath();
	let raw: string;
	try {
		const stat = statSync(path);
		if (!stat.isFile()) throw settingsError("settings.json is not a regular file");
		if (stat.size > MAX_SETTINGS_BYTES) {
			throw settingsError(`settings.json exceeds the ${MAX_SETTINGS_BYTES}-byte limit`);
		}
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if (isMissingFileError(err)) return {};
		throw redactError(err);
	}

	if (Buffer.byteLength(raw, "utf8") > MAX_SETTINGS_BYTES) {
		throw settingsError(`settings.json exceeds the ${MAX_SETTINGS_BYTES}-byte limit`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw settingsError("settings.json is not valid JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw settingsError("settings.json must contain a JSON object");
	}
	return parsed as WebSettings;
}

function isMissingFileError(err: unknown): boolean {
	return !!err && typeof err === "object" && (err as { code?: unknown }).code === "ENOENT";
}

function normalizedString(value: unknown, maxLength: number): string | null {
	if (typeof value !== "string") return null;
	const result = value.trim();
	return result.length > 0 && result.length <= maxLength ? result : null;
}

export function getConfiguredExaApiKey(settings: WebSettings = readSettings()): string | null {
	return normalizedString(settings.exaApiKey, 4096);
}

/** Resolve the model-visible content page size without silently accepting bad settings. */
export function getMaxInlineContentChars(settings: WebSettings = readSettings()): number {
	if (!Object.prototype.hasOwnProperty.call(settings, "maxInlineContentChars")) {
		return DEFAULT_MAX_INLINE_CONTENT_CHARS;
	}
	const value = settings.maxInlineContentChars;
	if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_INLINE_CONTENT_CHARS || value > MAX_INLINE_CONTENT_CHARS) {
		throw settingsError(`maxInlineContentChars must be an integer from ${MIN_INLINE_CONTENT_CHARS} to ${MAX_INLINE_CONTENT_CHARS}`);
	}
	return value;
}

function getFetchContentSettings(settings: WebSettings): Record<string, unknown> | null {
	const value = settings.fetchContent;
	if (value === undefined || value === null) return null;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw settingsError("fetchContent must be an object");
	}
	return value as Record<string, unknown>;
}

function getDomainPolicySettings(settings: WebSettings): Record<string, unknown> | null {
	const fetchContent = getFetchContentSettings(settings);
	const value = fetchContent?.domainPolicy;
	if (value === undefined || value === null) return null;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw settingsError("fetchContent.domainPolicy must be an object");
	}
	return value as Record<string, unknown>;
}

function normalizeDomainEntry(value: unknown): string {
	if (typeof value !== "string") throw settingsError("domain policy entries must be hostnames");
	const hostname = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
	if (!hostname || hostname.length > 253 || /[\s\\/:?#@*]/.test(hostname)) {
		throw settingsError("domain policy contains an invalid hostname");
	}
	if (isIP(hostname)) return hostname;
	if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(hostname)) {
		throw settingsError("domain policy contains an invalid hostname");
	}
	return hostname;
}

function normalizeDomainList(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > MAX_DOMAIN_POLICY_ENTRIES) {
		throw settingsError(`domain policy lists are limited to ${MAX_DOMAIN_POLICY_ENTRIES} hostnames`);
	}
	const values: string[] = [];
	for (const item of value) {
		const normalized = normalizeDomainEntry(item);
		if (!values.includes(normalized)) values.push(normalized);
	}
	return values;
}

export function getDomainPolicy(settings: WebSettings = readSettings()): DomainPolicy {
	const value = getDomainPolicySettings(settings);
	if (!value) return { allow: [], deny: [] };
	return {
		allow: normalizeDomainList(value.allow),
		deny: normalizeDomainList(value.deny),
	};
}

function getFetchSettings(settings: WebSettings): Record<string, unknown> | null {
	const value = settings.fetch;
	if (value === undefined) return null;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw settingsError("fetch must be an object");
	}
	return value as Record<string, unknown>;
}

function validTimeoutSeconds(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) &&
		value >= MIN_FETCH_TIMEOUT_SECONDS && value <= MAX_FETCH_TIMEOUT_SECONDS;
}

export function getFetchTimeoutMs(settings: WebSettings = readSettings()): number {
	const fetchSettings = getFetchSettings(settings);
	if (!fetchSettings || !Object.prototype.hasOwnProperty.call(fetchSettings, "timeout")) {
		return DEFAULT_FETCH_TIMEOUT_SECONDS * 1000;
	}
	if (!validTimeoutSeconds(fetchSettings.timeout)) {
		throw settingsError("fetch.timeout must be an integer from 1 to 120 seconds");
	}
	return (fetchSettings.timeout as number) * 1000;
}

export function configuredSecrets(settings: WebSettings = readSettings()): string[] {
	const values = [getConfiguredExaApiKey(settings), normalizedString(process.env.EXA_API_KEY, 4096)];
	return [...new Set(values.filter((value): value is string => !!value))];
}

/** Replace exact configured secrets without putting credentials in diagnostics. */
export function redactText(value: string, secrets: readonly string[] = []): string {
	let result = value;
	const replacements = new Set<string>();
	for (const secret of secrets) {
		if (typeof secret !== "string" || secret.length === 0) continue;
		replacements.add(secret);
		try {
			replacements.add(encodeURIComponent(secret));
		} catch {
		}
	}
	for (const secret of [...replacements].sort((a, b) => b.length - a.length)) {
		result = result.split(secret).join("[redacted]");
	}
	return result;
}

export function redactError(err: unknown, secrets: readonly string[] = []): Error {
	const message = err instanceof Error ? err.message : String(err);
	const concise = redactText(message.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim(), secrets);
	return new Error(concise.slice(0, 600) || "Request failed");
}
