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

export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = (2n ** 63n) - 1n;

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

/*
The duration units in their required order, with their length in nanoseconds.
*/
export const DURATION_UNITS = new Map([
	['h', 3_600_000_000_000n],
	['m', 60_000_000_000n],
	['s', 1_000_000_000n],
	['ms', 1_000_000n],
	['us', 1000n],
	['ns', 1n],
]);

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
	// The units are taken from the magnitude, and every field gets the sign of the whole, because `Temporal.Duration` rejects fields with mixed signs.
	const sign = nanoseconds < 0n ? -1n : 1n;
	let rest = nanoseconds * sign;
	const parts: number[] = [];

	for (const size of DURATION_UNITS.values()) {
		parts.push(Number(sign * (rest / size)));
		rest %= size;
	}

	const [hours, minutes, seconds, milliseconds, microseconds, nanosecondsPart] = parts;
	return new (requireTemporal().Duration)(0, 0, 0, 0, hours, minutes, seconds, milliseconds, microseconds, nanosecondsPart);
}

/**
The `integers` option of `parse()`, `stringify()`, and `edit()`, checked, or its default when it is left out.
*/
export function getIntegersOption(options: unknown): 'bigint' | 'number' {
	if (options === undefined) {
		return 'bigint';
	}

	if (typeof options !== 'object' || options === null) {
		throw new TypeError(`The options must be an object, got ${options === null ? 'null' : typeof options}`);
	}

	// An own property only, so that an `integers` on the prototype, such as on `Object.prototype`, is not read as the option. `undefined` is the same as a missing option.
	const integers = Object.hasOwn(options, 'integers') ? (options as {integers?: unknown}).integers : undefined;

	if (integers !== undefined && integers !== 'bigint' && integers !== 'number') {
		throw new TypeError(`The \`integers\` option must be 'bigint' or 'number', got ${typeof integers === 'string' ? `'${describeText(abbreviate(integers))}'` : typeof integers}`);
	}

	return integers ?? 'bigint';
}

/*
Names for the characters that are invisible or easy to mistake, so an error can say what it found.
*/
const CHARACTER_NAMES = new Map([
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

/*
Letters, digits, `_`, and `-`, the characters of a bare key, as a lookup table by code unit.
*/
const bareKeyCharacters = new Uint8Array(128);

for (const character of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-') {
	bareKeyCharacters[character.charCodeAt(0)] = 1;
}

/*
A number, an instant, or a duration is lexed as one maximal run of these characters, and then validated as a whole. The validation is a hand-written scan rather than a regular expression, because a regular expression with a repeated group runs out of stack on a token of a few million characters.
*/
const numberCharacters = new Uint8Array(128);

for (const character of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:+-') {
	numberCharacters[character.charCodeAt(0)] = 1;
}

/**
Whether a UTF-16 code unit can be part of a bare key. `NaN`, which `charCodeAt()` returns past the end of a string, cannot.
*/
export function isBareKeyCharacter(code: number): boolean {
	return code < 128 && bareKeyCharacters[code] === 1;
}

/**
Whether a key can be written without quotes, as a bare key: one or more ASCII letters, digits, `_`, or `-`, in any order, so `404` and `-x` are bare keys too. `stringify()` writes such a key bare and quotes every other key.

@param key - The decoded key.
@returns Whether `key` can be a bare key.

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
	if (key === '') {
		return false;
	}

	for (let index = 0; index < key.length; index++) {
		if (!isBareKeyCharacter(key.charCodeAt(index))) {
			return false;
		}
	}

	return true;
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
	let end = start + 1;

	while (isNumberCharacter(source.charCodeAt(end))) {
		end++;
	}

	return end;
}

function isNumberCharacter(code: number): boolean {
	return code < 128 && numberCharacters[code] === 1;
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
		let runLength = 0;

		while (source.charCodeAt(delimiterStart + runLength) === quote) {
			runLength++;
		}

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
	while (isSpace(text.charCodeAt(index))) {
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
Whether a line in a block string is blank: empty, or only spaces and tabs. A blank line becomes an empty line in the value.
*/
export function isBlankLine(line: string): boolean {
	return skipSpaces(line, 0) === line.length;
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
		const isWhitespace = /^[\p{White_Space}\u{200B}\u{FEFF}]$/v.test(String.fromCodePoint(codePoint));
		return `${formatCodePoint(codePoint)} (${name}${isWhitespace ? '; only space, tab, and line feed are whitespace' : ''})`;
	}

	const character = String.fromCodePoint(codePoint);

	// Control, format, private-use, unassigned, surrogate, separator, and default-ignorable characters are invisible or ambiguous, so they are shown by code point.
	return codePoint !== 0x20 && /^[\p{Default_Ignorable_Code_Point}\p{Other}\p{Separator}]$/v.test(character) ? formatCodePoint(codePoint) : `“${character}”`;
}
