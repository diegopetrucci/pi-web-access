const INLINE_DATA_MARKER = "[inline data omitted]";

/** A compact omission record kept only so callers can tell whether a value changed. */
export interface DataUriOmission {}

type Enclosure =
	| { kind: "quote"; close: string }
	| { kind: "parenthesis" }
	| { kind: "angle" }
	| null;

function lowerCode(code: number): number {
	return code >= 65 && code <= 90 ? code + 32 : code;
}

function isDataScheme(text: string, index: number): boolean {
	return index + 5 <= text.length &&
		lowerCode(text.charCodeAt(index)) === 100 &&
		lowerCode(text.charCodeAt(index + 1)) === 97 &&
		lowerCode(text.charCodeAt(index + 2)) === 116 &&
		lowerCode(text.charCodeAt(index + 3)) === 97 &&
		text.charCodeAt(index + 4) === 58;
}

function hasSchemeBoundary(text: string, index: number): boolean {
	if (index === 0) return true;
	const code = text.charCodeAt(index - 1);
	const alphanumeric = (code >= 48 && code <= 57) ||
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122);
	return !alphanumeric && code !== 43 && code !== 45 && code !== 46;
}

function nextDataScheme(text: string, from: number): number {
	for (let index = from; index + 5 <= text.length; index++) {
		if (isDataScheme(text, index) && hasSchemeBoundary(text, index)) return index;
	}
	return -1;
}

function enclosureAt(text: string, start: number): Enclosure {
	if (start === 0) return null;
	const previous = text[start - 1];
	if (previous === "\"" || previous === "'" || previous === "`") {
		return { kind: "quote", close: previous };
	}
	let opener = start - 1;
	while (opener >= 0 && (text[opener] === " " || text[opener] === "\t")) opener--;
	if (text[opener] === "(") return { kind: "parenthesis" };
	if (text[opener] === "<") return { kind: "angle" };
	return null;
}

function bareTerminator(character: string): boolean {
	const code = character.charCodeAt(0);
	return code <= 32 || code === 127 || character === '"' || character === "'" ||
		character === "`" || character === "<" || character === ">";
}

function candidateEnd(text: string, start: number): number {
	const enclosure = enclosureAt(text, start);
	let depth = enclosure?.kind === "parenthesis" ? 1 : 0;
	for (let index = start + 5; index < text.length; index++) {
		const character = text[index];
		if (enclosure?.kind === "quote") {
			if (character === "\\") {
				index++;
				continue;
			}
			if (character === enclosure.close) return index;
		} else if (enclosure?.kind === "angle") {
			if (character === ">") return index;
		} else if (enclosure?.kind === "parenthesis") {
			if (character === "(") depth++;
			else if (character === ")" && --depth === 0) return index;
		} else if (bareTerminator(character)) {
			return index;
		}
	}
	return text.length;
}

/**
 * Remove RFC 2397 payloads without decoding, hashing, or retaining their
 * diagnostics. The fixed marker is deliberately safe for model-visible text.
 */
export function sanitizeInlineDataUris(text: string, _sourcePath?: string): {
	text: string;
	omissions: DataUriOmission[];
} {
	let cursor = 0;
	let scanFrom = 0;
	let output = "";
	const omissions: DataUriOmission[] = [];

	while (scanFrom < text.length) {
		const start = nextDataScheme(text, scanFrom);
		if (start < 0) break;
		const end = candidateEnd(text, start);
		const enclosure = enclosureAt(text, start);
		// Keep ordinary prose such as "data: value" intact.
		if (end === start + 5 && enclosure === null) {
			scanFrom = end;
			continue;
		}
		output += text.slice(cursor, start) + INLINE_DATA_MARKER;
		omissions.push({});
		cursor = end;
		scanFrom = end;
	}

	return omissions.length === 0
		? { text, omissions }
		: { text: output + text.slice(cursor), omissions };
}
