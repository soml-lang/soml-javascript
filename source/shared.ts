/*
UTF-16 code units of the characters that the lexers look for.
*/
export const TAB = 0x09;
export const LF = 0x0A;
export const SPACE = 0x20;
export const DOUBLE_QUOTE = 0x22;
export const HASH = 0x23;
export const SINGLE_QUOTE = 0x27;
export const ASTERISK = 0x2A;
export const COMMA = 0x2C;
export const DASH = 0x2D;
export const DOT = 0x2E;
export const SLASH = 0x2F;
export const COLON = 0x3A;
export const OPEN_BRACKET = 0x5B;
export const BACKSLASH = 0x5C;
export const CLOSE_BRACKET = 0x5D;
export const OPEN_BRACE = 0x7B;
export const CLOSE_BRACE = 0x7D;

/*
The deepest nesting either direction accepts. A recursive-descent parser would otherwise end in an engine stack overflow.
*/
export const MAX_DEPTH = 100;

// Bound temporary replacement storage for escape-heavy strings and numeric tokens.
export const STRING_CHUNK_LENGTH = 32_768;

export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = (2n ** 63n) - 1n;
export const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
export const MIN_SAFE_INTEGER = -MAX_SAFE_INTEGER;

/**
Half-open UTF-16 offsets into source text.
*/
export type TextRange = readonly [start: number, end: number];

/**
Validate and snapshot a pair of own safe-integer offsets without accepting inherited array slots.
*/
export function readRange(value: unknown): TextRange | undefined {
	if (!Array.isArray(value) || value.length !== 2 || !Object.hasOwn(value, 0)) {
		return undefined;
	}

	const start: unknown = value[0];
	if (!Object.hasOwn(value, 1)) {
		return undefined;
	}

	const end: unknown = value[1];
	return typeof start === 'number' && typeof end === 'number' && Number.isSafeInteger(start) && Number.isSafeInteger(end) ? [start, end] : undefined;
}

/*
The instant range is checked in UTC, so that every instant has a canonical form that can be read back.
*/
export const MIN_INSTANT = -62_135_596_800_000_000_000n; // 0001-01-01T00:00:00Z
export const MAX_INSTANT = 253_402_300_799_999_999_999n; // 9999-12-31T23:59:59.999999999Z

/*
`Temporal` is built into Node.js 26 and later. Before that, only the values of instants and durations need it, so that everything else works without a polyfill, including `format()` and `parseTree()`. It is read at import, so a polyfill must be loaded before this package.
*/
const temporal = typeof Temporal === 'undefined' ? undefined : Temporal;

export function requireTemporal(): typeof globalThis.Temporal {
	if (temporal === undefined) {
		throw new Error('Instants and durations need `Temporal`. Use Node.js 26 or later, or load a polyfill such as `temporal-polyfill/global` before this package');
	}

	return temporal;
}

export type IntegerMode = 'bigint' | 'number';

export type DurationUnit = 'h' | 'm' | 's' | 'ms' | 'us' | 'ns';

/*
The duration units in their required order, with their length in nanoseconds.
*/
export const DURATION_UNITS: ReadonlyMap<string, {readonly rank: number; readonly size: bigint}> = new Map(([
	['h', 3_600_000_000_000n],
	['m', 60_000_000_000n],
	['s', 1_000_000_000n],
	['ms', 1_000_000n],
	['us', 1000n],
	['ns', 1n],
] as const satisfies ReadonlyArray<readonly [DurationUnit, bigint]>).values().map(([unit, size], rank) => [unit, {rank, size}] as const));

/**
Remove the trailing zeros of a run of digits. A loop rather than a regular expression, which would be quadratic on a long run of zeros followed by another digit.
*/
export function trimTrailingZeros(digits: string): string {
	let end = digits.length;

	while (end > 0 && digits.charCodeAt(end - 1) === 0x30) {
		end--;
	}

	return digits.slice(0, end);
}

/**
A duration as a `Temporal.Duration` in hours and smaller units, which hold any int64 count of nanoseconds exactly.
*/
export function createDuration(nanoseconds: bigint): Temporal.Duration {
	// BigInt division truncates toward zero and its remainder keeps the dividend sign, so every field gets the sign of the whole, as `Temporal.Duration` requires.
	const hours = Number(nanoseconds / 3_600_000_000_000n);
	const minutes = Number(nanoseconds / 60_000_000_000n % 60n);
	const seconds = Number(nanoseconds / 1_000_000_000n % 60n);
	const milliseconds = Number(nanoseconds / 1_000_000n % 1000n);
	const microseconds = Number(nanoseconds / 1000n % 1000n);
	const nanosecondsPart = Number(nanoseconds % 1000n);
	return new (requireTemporal().Duration)(0, 0, 0, 0, hours, minutes, seconds, milliseconds, microseconds, nanosecondsPart);
}

/**
The `integers` option of `parse()`, `stringify()`, and `edit()`, checked, or its default when it is left out.
*/
export function getIntegersOption(options: unknown): IntegerMode {
	// An own property only, so that an `integers` on the prototype, such as on `Object.prototype`, is not read as the option. `undefined` is the same as a missing option.
	const integers = getOwnOption(options, 'integers');

	if (integers !== undefined && integers !== 'bigint' && integers !== 'number') {
		throw new TypeError(`The \`integers\` option must be 'bigint' or 'number', got ${describeOption(integers)}`);
	}

	return integers ?? 'bigint';
}

/**
Read an own option exactly once, ignoring prototype properties and treating omitted options as an empty object.
*/
export function getOwnOption(options: unknown, key: 'integers' | 'canonical' | 'style' | 'stringStyle' | 'side' | 'layout' | 'indentationLevel'): unknown {
	if (options === undefined) {
		return undefined;
	}

	if (typeof options !== 'object' || options === null) {
		throw new TypeError(`The options must be an object, got ${options === null ? 'null' : typeof options}`);
	}

	return Object.hasOwn(options, key) ? (options as Record<string, unknown>)[key] : undefined;
}

/**
Describe an invalid option without coercing objects or exposing unbounded or terminal-active text.
*/
export function describeOption(value: unknown): string {
	return typeof value === 'string' ? `'${describeText(abbreviate(value))}'` : typeof value;
}

/*
Names for the characters that are invisible or easy to mistake, so an error can say what it found.
*/
const CHARACTER_NAMES: ReadonlyMap<number, string> = new Map([
	[0x06_1C, 'ARABIC LETTER MARK'],
	[0x85, 'NEXT LINE'],
	[0xA0, 'NO-BREAK SPACE'],
	[0xAD, 'SOFT HYPHEN'],
	[0x16_80, 'OGHAM SPACE MARK'],
	[0x20_00, 'EN QUAD'],
	[0x20_01, 'EM QUAD'],
	[0x20_02, 'EN SPACE'],
	[0x20_03, 'EM SPACE'],
	[0x20_04, 'THREE-PER-EM SPACE'],
	[0x20_05, 'FOUR-PER-EM SPACE'],
	[0x20_06, 'SIX-PER-EM SPACE'],
	[0x20_07, 'FIGURE SPACE'],
	[0x20_08, 'PUNCTUATION SPACE'],
	[0x20_09, 'THIN SPACE'],
	[0x20_0A, 'HAIR SPACE'],
	[0x20_0B, 'ZERO WIDTH SPACE'],
	[0x20_0C, 'ZERO WIDTH NON-JOINER'],
	[0x20_0D, 'ZERO WIDTH JOINER'],
	[0x20_0E, 'LEFT-TO-RIGHT MARK'],
	[0x20_0F, 'RIGHT-TO-LEFT MARK'],
	[0x20_28, 'LINE SEPARATOR'],
	[0x20_29, 'PARAGRAPH SEPARATOR'],
	[0x20_2A, 'LEFT-TO-RIGHT EMBEDDING'],
	[0x20_2B, 'RIGHT-TO-LEFT EMBEDDING'],
	[0x20_2C, 'POP DIRECTIONAL FORMATTING'],
	[0x20_2D, 'LEFT-TO-RIGHT OVERRIDE'],
	[0x20_2E, 'RIGHT-TO-LEFT OVERRIDE'],
	[0x20_2F, 'NARROW NO-BREAK SPACE'],
	[0x20_5F, 'MEDIUM MATHEMATICAL SPACE'],
	[0x20_60, 'WORD JOINER'],
	[0x20_66, 'LEFT-TO-RIGHT ISOLATE'],
	[0x20_67, 'RIGHT-TO-LEFT ISOLATE'],
	[0x20_68, 'FIRST STRONG ISOLATE'],
	[0x20_69, 'POP DIRECTIONAL ISOLATE'],
	[0x30_00, 'IDEOGRAPHIC SPACE'],
	[0xFE_FF, 'ZERO WIDTH NO-BREAK SPACE'],
]);

const NAMED_WHITESPACE = /^[\p{White_Space}\u{200B}\u{FEFF}]$/v;
const INVISIBLE_CHARACTER = /^[\p{Default_Ignorable_Code_Point}\p{Other}\p{Separator}]$/v;

/*
Letters, digits, `_`, and `-`, the characters of a bare key, as a lookup table by code unit.
*/
const bareKeyCharacters = new Uint8Array(128);

for (const character of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-') {
	bareKeyCharacters[character.charCodeAt(0)] = 1;
}

/*
A number, an instant, or a duration is lexed as one maximal run of these ASCII characters, and then validated as a whole. Searching for one boundary character needs no regex backtracking stack, even on tokens of a few million characters. Match UTF-16 code units so the boundary is the start of an astral character too.
*/
const NUMBER_END = /[^\w+\-.:]/g; // eslint-disable-line require-unicode-regexp -- UTF-16 code units keep an astral boundary at its first surrogate.

/**
Whether a UTF-16 code unit can be part of a bare key. `NaN`, which `charCodeAt()` returns past the end of a string, cannot.
*/
export function isBareKeyCharacter(code: number): boolean {
	return code < 128 && bareKeyCharacters[code] === 1;
}

/**
Whether a UTF-16 code unit opens a quoted string or key.
*/
export function isQuote(code: number): boolean {
	return code === SINGLE_QUOTE || code === DOUBLE_QUOTE;
}

/**
Whether a UTF-16 code unit is an ASCII decimal digit.
*/
export function isDigit(code: number): boolean {
	return code >= 0x30 && code <= 0x39;
}

/**
The first offset after a run of bare-key characters, shared by strict and recovered syntax scanners.
*/
export function findBareKeyEnd(source: string, start: number): number {
	while (isBareKeyCharacter(source.charCodeAt(start))) {
		start++;
	}

	return start;
}

/**
The first offset after a run of the block string's quote character.
*/
export function findQuoteRunEnd(source: string, start: number, quote: number): number {
	while (source.charCodeAt(start) === quote) {
		start++;
	}

	return start;
}

/**
Reject non-string inputs before any string method or coercion can execute user code.
*/
export function requireString(value: unknown): asserts value is string {
	if (typeof value !== 'string') {
		throw new TypeError(`Expected a string, got ${value === null ? 'null' : typeof value}`);
	}
}

/**
Whether a key can be written without quotes, as a bare key: one or more ASCII letters, digits, `_`, or `-`, in any order, so `404` and `-x` are bare keys too. `stringify()` writes such a key bare and quotes every other key.

@param key - The decoded key.
@returns Whether `key` can be a bare key.
@throws {TypeError} When `key` is not a string.

@example
```
import {isBareKey} from 'soml-lang';

isBareKey('content-type');
//=> true

isBareKey('a.b');
//=> false
```
*/
export function isBareKey(key: string): boolean {
	requireString(key);
	return key !== '' && findBareKeyEnd(key, 0) === key.length;
}

/**
A key as an error message shows it: bare when it can be, and otherwise quoted, and cut short when it is long.
*/
export function describeKey(key: string): string {
	return isBareKey(key) ? abbreviate(key) : JSON.stringify(abbreviate(key));
}

/*
The characters that a terminal acts on rather than shows: control characters, such as an escape or a carriage return, format characters, and line and paragraph separators. They become escapes in text an error message shows, so that a value from user input, such as a key, cannot send commands to a terminal.
*/
const TERMINAL_CHARACTER = /[\p{Control}\p{Format}\p{Line_Separator}\p{Paragraph_Separator}]/gv;

/**
Text as an error message shows it, with every terminal-active character as an escape, such as `\u{9b}` for the 8-bit control that starts a terminal escape sequence.
*/
export function describeText(text: string): string {
	return text.replaceAll(TERMINAL_CHARACTER, character => String.raw`\u{${character.codePointAt(0)!.toString(16)}}`);
}

/**
The end of the number, instant, duration, or keyword token that starts at `start`.
*/
export function findNumberEnd(source: string, start: number): number {
	NUMBER_END.lastIndex = start + 1;
	return NUMBER_END.test(source) ? NUMBER_END.lastIndex - 1 : source.length;
}

/**
The offset of the line feed that ends the line containing `offset`, or the length of `source` on the last line.
*/
export function findLineEnd(source: string, offset: number): number {
	const end = source.indexOf('\n', offset);
	return end === -1 ? source.length : end;
}

/**
Find the closing delimiter of a block string: the first line from `offset` on that holds, after zero or more spaces and tabs, a run of exactly `length` of the `quote` character. A longer run is content. Returns where that line and its delimiter start, or `undefined` when no line closes the block.
*/
export function findBlockStringEnd(source: string, offset: number, quote: number, length: number): {lineStart: number; delimiterStart: number} | undefined {
	for (let lineStart = offset; lineStart < source.length; lineStart = findLineEnd(source, lineStart) + 1) {
		const delimiterStart = skipSpaces(source, lineStart);
		if (source.charCodeAt(delimiterStart) !== quote) {
			continue;
		}

		const runLength = findQuoteRunEnd(source, delimiterStart, quote) - delimiterStart;

		if (runLength === length) {
			return {lineStart, delimiterStart};
		}
	}

	// Past the last line, either because the source ended with a line break or because the last line was content.
	return undefined;
}

/**
Whether a UTF-16 code unit is a space or a tab, the whitespace within a line.
*/
export function isSpace(code: number): boolean {
	return code === SPACE || code === TAB;
}

/*
Whitespace within a line is scanned with loops rather than regular expressions such as `/[\t ]*:/`, because a regular expression that backtracks over a run of a few million spaces runs out of stack.
*/

/**
The index after the spaces and tabs from `index` on.
*/
export function skipSpaces(text: string, index: number): number {
	// Note: Not using `trimStart()` because it also removes Unicode whitespace that SOML treats as content.
	while (isSpace(text.charCodeAt(index))) {
		index++;
	}

	return index;
}

/**
Skips spaces, tabs, and line feeds, but not comments. Returns the first offset after them.
*/
export function skipWhitespace(text: string, index: number): number {
	while (isSpace(text.charCodeAt(index)) || text.charCodeAt(index) === LF) {
		index++;
	}

	return index;
}

/**
The index after the last character before `index` that is not a space or a tab.
*/
export function skipSpacesBack(text: string, index: number): number {
	while (index > 0 && isSpace(text.charCodeAt(index - 1))) {
		index--;
	}

	return index;
}

/**
Whether a line in a block string is blank: empty, or only spaces and tabs. The range excludes its line feed. A blank line becomes an empty line in the value.
*/
export function isBlankLine(source: string, start: number, end: number): boolean {
	return start === end || skipSpaces(source, start) === end;
}

/**
Shorten text quoted in an error message, so a huge token does not make a huge message. The cut never splits a surrogate pair.
*/
export function abbreviate(text: string, maximumLength = 40): string {
	if (text.length <= maximumLength) {
		return text;
	}

	const lastCode = text.charCodeAt(maximumLength - 1);
	const end = lastCode >= 0xD8_00 && lastCode <= 0xDB_FF ? maximumLength - 1 : maximumLength;
	return `${text.slice(0, end)}…`;
}

export function formatCodePoint(codePoint: number): string {
	return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
Describe a character for an error message, such as `“$”` or `U+00A0 (NO-BREAK SPACE)`.
*/
export function describeCharacter(codePoint: number): string {
	const name = CHARACTER_NAMES.get(codePoint);

	if (name !== undefined) {
		// U+200B and U+FEFF are not `White_Space` in Unicode, but their names call them spaces, so they get the hint too.
		const isWhitespace = NAMED_WHITESPACE.test(String.fromCodePoint(codePoint));
		return `${formatCodePoint(codePoint)} (${name}${isWhitespace ? '; only space, tab, and line feed are whitespace' : ''})`;
	}

	const character = String.fromCodePoint(codePoint);

	// Control, format, private-use, unassigned, surrogate, separator, and default-ignorable characters are invisible or ambiguous, so they are shown by code point.
	return codePoint !== 0x20 && INVISIBLE_CHARACTER.test(character) ? formatCodePoint(codePoint) : `“${character}”`;
}

/**
The start of the line containing a UTF-16 offset. A line feed at the offset still belongs to that line.
*/
export function findLineStart(source: string, offset: number): number {
	// `lastIndexOf` treats a negative start as 0, so it would find a line break at offset 0 that is not before `offset`.
	return offset === 0 ? 0 : source.lastIndexOf('\n', offset - 1) + 1;
}

/**
Whether the half-open source range contains no line feed. Bound the search to the range so repeated lookups on a long line stay linear.
*/
export function isSameLine(source: string, start: number, end: number): boolean {
	return !source.slice(start, end).includes('\n');
}

/*
Whether a line between `start` and `end` holds only spaces and tabs, if anything. A slice bounds the search for a line break to `end`.
*/

/**
Whether a bounded source range contains an empty or spaces-and-tabs-only line between two line feeds. Scan without regex backtracking or stack growth on long whitespace runs.
*/
export function hasBlankLine(source: string, start: number, end: number): boolean {
	const text = source.slice(start, end);
	let lineBreak = text.indexOf('\n');
	while (lineBreak !== -1) {
		const next = skipSpaces(text, lineBreak + 1);
		if (text.charCodeAt(next) === LF) {
			return true;
		}

		lineBreak = text.indexOf('\n', next);
	}

	return false;
}

/**
Whether two optional half-open ranges describe exactly the same source span.
*/
export function areRangesEqual(first: readonly [number, number] | undefined, second: readonly [number, number] | undefined): boolean {
	return first !== undefined && first[0] === second?.[0] && first[1] === second[1];
}

/**
Whether a non-empty range contains a cursor with left or right boundary affinity.
*/
export function isOffsetInRange(range: TextRange, offset: number, side: 'left' | 'right' = 'right'): boolean {
	return range[0] < range[1] && (side === 'left' ? range[0] < offset && offset <= range[1] : range[0] <= offset && offset < range[1]);
}

/**
Reject cursor positions before reading syntax or invoking caller-controlled conversions.
*/
export function requireOffset(offset: unknown): asserts offset is number {
	if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
		throw new TypeError('Expected a non-negative safe integer offset');
	}
}

/**
The first item whose range starts at or after the offset, in a source-ordered list.
*/
export function lowerBound(items: ReadonlyArray<{readonly range: readonly [number, number]}>, offset: number): number {
	let low = 0;
	let high = items.length;

	while (low < high) {
		const middle = Math.floor((low + high) / 2);

		if (items[middle]!.range[0] < offset) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}

	return low;
}

// Stop at the first delimiter or line break, without scanning each literal character in JavaScript.
const LITERAL_STRING_BOUNDARY = /[\n']/gv;
const ESCAPED_STRING_BOUNDARY = /[\n"\\]/gv;

/**
The end of a single-line string's lexical region, including its closing quote. Unfinished strings stop before LF or at EOF. Escapes consume the following code unit, except LF, without validating it.
*/
export function findStringEnd(source: string, start: number): number {
	const isLiteral = source.charCodeAt(start) === SINGLE_QUOTE;
	const boundary = isLiteral ? LITERAL_STRING_BOUNDARY : ESCAPED_STRING_BOUNDARY;
	boundary.lastIndex = start + 1;

	for (;;) {
		if (!boundary.test(source)) {
			return source.length;
		}

		const end = boundary.lastIndex;
		const code = source.charCodeAt(end - 1);

		if (code === LF) {
			return end - 1;
		}

		if (isLiteral || code === DOUBLE_QUOTE) {
			return end;
		}

		boundary.lastIndex = source.charCodeAt(end) === LF ? end : end + 1;
	}
}
