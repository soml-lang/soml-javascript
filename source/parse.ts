import {ParseError} from './error.ts';
import {formatKey} from './stringify.ts';
import {
	MAX_DEPTH,
	INT64_MIN,
	INT64_MAX,
	MIN_INSTANT,
	MAX_INSTANT,
	DURATION_UNITS,
	createDuration,
	requireTemporal,
	trimTrailingZeros,
	getIntegersOption,
	describeCharacter,
	formatCodePoint,
	describeKey,
	isBareKeyCharacter,
	isSpace,
	skipSpaces,
	skipSpacesBack,
	isBlankLine,
	findNumberEnd,
	findLineEnd,
	findBlockStringEnd,
	abbreviate,
	LF,
	SPACE,
	DOUBLE_QUOTE,
	HASH,
	SINGLE_QUOTE,
	ASTERISK,
	COMMA,
	DASH,
	DOT,
	SLASH,
	COLON,
	OPEN_BRACKET,
	CLOSE_BRACKET,
	OPEN_BRACE,
	CLOSE_BRACE,
} from './shared.ts';

/**
A value in a document.

| Format | JavaScript |
|---|---|
| string | `string` |
| int | `bigint`, or `number` with `integers: 'number'` |
| float | `number` |
| bool | `boolean` |
| null | `null` |
| instant | `Temporal.Instant` |
| duration | `Temporal.Duration`, in hours and smaller units |
| array | `Array` |
| object | plain `Object` |
*/
export type Value<Integer extends bigint | number = bigint> =
	| string
	| Integer
	| number
	| boolean
	| null // eslint-disable-line @typescript-eslint/no-restricted-types -- The format has a null value, and `parse()` returns `null` for it.
	| Temporal.Instant
	| Temporal.Duration
	| Value<Integer>[] // eslint-disable-line @typescript-eslint/array-type
	| ObjectValue<Integer>;

/**
An object in a document.
*/
export type ObjectValue<Integer extends bigint | number = bigint> = {[key: string]: Value<Integer>};

/**
A whole document, which is always an object or an array.
*/
export type Document<Integer extends bigint | number = bigint> = ObjectValue<Integer> | Array<Value<Integer>>;

/**
Options for `parse()`.
*/
export type ParseOptions = {
	/**
	How an int is represented.

	- `'bigint'`: Every int is a `bigint`, and every float is a `number`, so `3` and `3.0` stay different, and every 64-bit int is exact. This is the only conforming mode.
	- `'number'`: Every int is a `number`. An int outside `Number.MIN_SAFE_INTEGER` to `Number.MAX_SAFE_INTEGER` throws a `ParseError` rather than being rounded. `3` and `3.0` both become `3`, so `stringify()` cannot tell them apart afterwards.

	@default 'bigint'
	*/
	readonly integers?: 'bigint' | 'number';
};

/*
A value as the parser builds it. An instant or a duration is a `Time` only in `parseWithTimes()`.
*/
export type ParsedValue = Value<bigint | number> | Time | ParsedValue[] | ParsedObject;
type ParsedObject = {[key: string]: ParsedValue};

const valueEndCharacters = new Uint8Array(128);

// A `/` is here because a block comment may follow a value directly, as in `1/* note */`. A `/` that starts no comment fails where the next token is expected.
for (const character of ' \t\n,]}#/') {
	valueEndCharacters[character.codePointAt(0)!] = 1;
}

/*
Whether a UTF-16 code unit may directly follow a scalar value: whitespace, a separator, a closing bracket, a comment, or the end, where `charCodeAt()` returns `NaN`.
*/
function isValueEnd(code: number): boolean {
	return Number.isNaN(code) || (code < 128 && valueEndCharacters[code] === 1);
}

/*
Whether a value ends at `offset`, so that a suggestion that ends there leaves nothing out. A `/` only starts a comment with a `*` after it, or a `//` comment of another language, which the error for what follows names, so in `km/h` the text goes on.
*/
function isValueEndAt(source: string, offset: number): boolean {
	const code = source.charCodeAt(offset);
	const next = source.charCodeAt(offset + 1);
	return isValueEnd(code) && (code !== SLASH || next === ASTERISK || next === SLASH);
}

/*
Whether a UTF-16 code unit is a space, a tab, a line feed, or the end.
*/
function isSpaceOrLineEnd(code: number): boolean {
	return isSpace(code) || code === LF || Number.isNaN(code);
}

/*
This lookup table is a map rather than an object, so that a property added to `Object.prototype` is never read as an entry.
*/
const RADIX_DIGIT = new Map<string, (code: number) => boolean>([
	// Hexadecimal digits are uppercase only, so `0xff` is not an int.
	['x', code => (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46)],
	['o', code => code >= 0x30 && code <= 0x37],
	['b', code => code === 0x30 || code === 0x31],
]);

/*
The longest token that the instant regular expression and the diagnostic regular expressions look at. Their repeated groups need stack in proportion to the input, so a longer token is rejected with a general message, or described from its first part.
*/
const MAX_DIAGNOSED_LENGTH = 1000;

type Radix = 'x' | 'o' | 'b';
const RADIX_NAME: Record<Radix, string> = {x: 'hexadecimal', o: 'octal', b: 'binary'};
const RADIX_ARTICLE: Record<Radix, string> = {x: 'A', o: 'An', b: 'A'};
const INSTANT_PREFIX = /^\d{4}-\d{2}-\d{2}/v;
const DURATION_UNIT_NAMES = DURATION_UNITS.keys().toArray();
// The fraction may have any number of digits here, so that more than nine gets its own message rather than the general one.
const INSTANT = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d+))?(?<offset>Z|[+\-](?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/v;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/v;
const INSTANT_FORMAT = 'An instant is written as 2026-09-19T14:00:00Z, with an optional fraction of up to nine digits and an offset of Z or ±HH:MM';
type InstantGroups = Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'offset', string> & {fraction?: string; offsetHour?: string; offsetMinute?: string};
// Uppercase digits too, so that the value of such an escape is checked before its spelling.
const UNICODE_ESCAPE = /u\{(?<hex>[\da-f]{1,6})\}/ivy;
// An offset on its own, as after a space in `2026-09-19T14:00:00 Z`.
const OFFSET = /Z|[+\-]\d{2}:\d{2}/vy;
/*
Every C0 control character except tab and line feed, and DEL. They are errors anywhere in a document.
*/
// eslint-disable-next-line no-control-regex, regexp/no-control-character -- Control characters are exactly what must be found.
const CONTROL_CHARACTER = /[\u{0}-\u{8}\u{B}-\u{1F}\u{7F}]/v;
const LITERAL_STRING_END = /[\n']/gv;
const KEY_QUOTING_HINT = '. A key that contains characters other than letters, digits, “_”, and “-” must be quoted';
/*
The characters that may be meant as part of a key: visible ones that have no meaning in the grammar, which includes every bare key character. A `=` is left out, because after a key, as in `name=foo`, it was most likely meant as the `:` of INI and TOML, so a key that holds a `=` gets no quoting hint.
*/
const QUOTABLE_KEY_CHARACTER = String.raw`[^\p{Default_Ignorable_Code_Point}\p{Other}\p{White_Space}"#'*,\/:=\[\]\{\}]`;
const QUOTABLE_KEY_START = new RegExp(`^${QUOTABLE_KEY_CHARACTER}`, 'v');
/*
A key made of them, up to its `:`, so the quoting hint can show it quoted.
*/
const QUOTABLE_KEY = new RegExp(`^${QUOTABLE_KEY_CHARACTER}+(?=:)`, 'v');
const ESCAPED_STRING_SPECIAL = /[\n"\\]/gv;

const SIMPLE_ESCAPES = new Map([
	['\\', '\\'],
	['"', '"'],
	['n', '\n'],
	['t', '\t'],
]);

/*
What a backslash followed by one of these characters was probably meant to be.
*/
const ESCAPE_MISTAKES = new Map([
	['r', String.raw`There is no \r escape, because a carriage return cannot be represented`],
	['\'', 'A \' needs no escape inside "..."'],
	['\n', String.raw`A backslash must be followed by an escape character. Use \\ for a literal backslash, or a '...' string`],
]);

/**
Parse a document. Returns an object or an array, because a document is always a collection.

@param text - The document, as a string or as UTF-8 bytes. Invalid UTF-8 is reported with its position.
@returns The object or array the document contains.
@throws {ParseError} When the document is not valid.
@throws {TypeError} When `text` is not a string or a `Uint8Array`, or `options` is not an object or its `integers` is not `'bigint'` or `'number'`.

@example
```
import {parse} from 'soml-lang';

parse(`
name: 'api-gateway'
replicas: 3
timeout: 30.0
postgres: {host: 'db.internal'}
`);
//=> {name: 'api-gateway', replicas: 3n, timeout: 30, postgres: {host: 'db.internal'}}

parse('port: 8080', {integers: 'number'});
//=> {port: 8080}
```
*/
export function parse(text: string | Uint8Array, options?: ParseOptions & {readonly integers?: 'bigint'}): Document;
/**
Parse a document. Returns an object or an array, because a document is always a collection.

@param text - The document, as a string or as UTF-8 bytes. Invalid UTF-8 is reported with its position.
@returns The object or array the document contains.
@throws {ParseError} When the document is not valid.
@throws {TypeError} When `text` is not a string or a `Uint8Array`, or `options` is not an object or its `integers` is not `'bigint'` or `'number'`.

@example
```
import {parse} from 'soml-lang';

parse(`
name: 'api-gateway'
replicas: 3
timeout: 30.0
postgres: {host: 'db.internal'}
`);
//=> {name: 'api-gateway', replicas: 3n, timeout: 30, postgres: {host: 'db.internal'}}

parse('port: 8080', {integers: 'number'});
//=> {port: 8080}
```
*/
export function parse(text: string | Uint8Array, options: ParseOptions & {readonly integers: 'number'}): Document<number>;
/**
Parse a document. Returns an object or an array, because a document is always a collection.

@param text - The document, as a string or as UTF-8 bytes. Invalid UTF-8 is reported with its position.
@returns The object or array the document contains.
@throws {ParseError} When the document is not valid.
@throws {TypeError} When `text` is not a string or a `Uint8Array`, or `options` is not an object or its `integers` is not `'bigint'` or `'number'`.

@example
```
import {parse} from 'soml-lang';

parse(`
name: 'api-gateway'
replicas: 3
timeout: 30.0
postgres: {host: 'db.internal'}
`);
//=> {name: 'api-gateway', replicas: 3n, timeout: 30, postgres: {host: 'db.internal'}}

parse('port: 8080', {integers: 'number'});
//=> {port: 8080}
```
*/
export function parse(text: string | Uint8Array, options?: ParseOptions): Document | Document<number>;
export function parse(text: string | Uint8Array, options?: ParseOptions): Document<bigint | number> {
	const integers = getIntegersOption(options);
	const source = decode(text);
	checkCharacters(source);
	// The default `createTime` makes a `Temporal` object of every instant and duration, so no `Time` is left.
	return new Parser(source, integers).parseDocument() as Document<bigint | number>;
}

/*
An instant, as nanoseconds since the Unix epoch, or a duration, as its length in nanoseconds.
*/
export class Time {
	readonly type: 'Instant' | 'Duration';
	readonly nanoseconds: bigint;

	constructor(type: 'Instant' | 'Duration', nanoseconds: bigint) {
		this.type = type;
		this.nanoseconds = nanoseconds;
	}

	toTemporal(): Temporal.Instant | Temporal.Duration {
		return this.type === 'Instant' ? new (requireTemporal().Instant)(this.nanoseconds) : createDuration(this.nanoseconds);
	}
}

/*
The same as `parse()` for a string, except that each instant and duration is a `Time` instead of a `Temporal` object, so that it works without `Temporal`. For the tree, which makes the `Temporal` object only when the value is read.
*/
export function parseWithTimes(text: string): ParsedObject | ParsedValue[] {
	checkCharacters(text);
	return new Parser(text, 'bigint', time => time).parseDocument();
}

const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)!.get as (this: unknown) => string | undefined;

function decode(text: unknown): string {
	if (typeof text === 'string') {
		return text;
	}

	// A brand check rather than `instanceof`, so that bytes from another realm, such as a `vm` context, are accepted too. The typed array tag getter reads an internal slot, so it cannot be faked with `Symbol.toStringTag`.
	if (typedArrayTag.call(text) === 'Uint8Array') {
		const bytes = text as Uint8Array;

		try {
			// `ignoreBOM` keeps a BOM in the output, so that it can be rejected rather than silently dropped.
			return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); // eslint-disable-line @typescript-eslint/naming-convention
		} catch (error) {
			const offset = findInvalidUtf8(bytes);

			// Every byte is valid, so the decoder failed for another reason, such as input longer than the longest possible string.
			if (offset === bytes.length) {
				throw error;
			}

			const valid = new TextDecoder('utf-8', {ignoreBOM: true}).decode(bytes.subarray(0, offset)); // eslint-disable-line @typescript-eslint/naming-convention

			// A sequence that the end of the input cuts short decodes without error when more bytes may follow.
			if (isTruncatedUtf8(bytes.subarray(offset))) {
				throw ParseError.create('Incomplete UTF-8 sequence at the end of the input', valid, valid.length);
			}

			throw ParseError.create(`Invalid UTF-8 byte 0x${bytes[offset]!.toString(16).toUpperCase().padStart(2, '0')}`, valid, valid.length);
		}
	}

	throw new TypeError(`Expected a string or a Uint8Array, got ${typeof text === 'object' ? (text === null ? 'null' : 'an object') : typeof text}`);
}

/*
Finds the first byte of the first invalid sequence. Only called on the error path, so each multi-byte sequence is checked with a fatal decoder rather than by reimplementing the UTF-8 rules for overlong forms, surrogates, and the U+10FFFF limit.
*/
function findInvalidUtf8(bytes: Uint8Array): number {
	const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}); // eslint-disable-line @typescript-eslint/naming-convention
	let index = 0;

	while (index < bytes.length) {
		const byte = bytes[index]!;

		if (byte < 0x80) {
			index++;
			continue;
		}

		const length = byte >= 0xF0 ? 4 : (byte >= 0xE0 ? 3 : 2);
		const sequence = bytes.subarray(index, index + length);

		// A fatal decode also throws for a sequence that the end of the input cuts short.
		try {
			decoder.decode(sequence);
		} catch {
			return index;
		}

		index += length;
	}

	return index;
}

function isTruncatedUtf8(bytes: Uint8Array): boolean {
	try {
		new TextDecoder('utf-8', {fatal: true}).decode(bytes, {stream: true});
		return true;
	} catch {
		return false;
	}
}

/*
Characters that are errors wherever they appear, so they are checked once, up front.
*/
export function checkCharacters(source: string, fail: (reason: string, offset: number) => never = (reason, offset) => {
	throw ParseError.create(reason, source, offset);
}): void {
	// Only at the start. Elsewhere, U+FEFF is an ordinary character: content in a string or a comment, and an error between tokens like any other.
	if (source.charCodeAt(0) === 0xFE_FF) {
		fail('A byte order mark (BOM) is not allowed', 0);
	}

	const control = CONTROL_CHARACTER.exec(source);

	if (control !== null) {
		const {index} = control;
		const code = source.charCodeAt(index);

		if (code === 0x0D) {
			fail('A carriage return (U+000D) is not allowed anywhere. Use LF line endings', index);
		}

		const escape = String.raw`\u{${code.toString(16)}}`;
		fail(`A raw control character (${formatCodePoint(code)}) is not allowed anywhere, including in strings and comments. In a string, write it as the escape ${escape} inside "..."`, index);
	}

	if (source.isWellFormed()) {
		return;
	}

	// With the `v` flag, a surrogate in the class matches only when it is unpaired.
	const offset = /[\u{D800}-\u{DFFF}]/v.exec(source)!.index;
	fail(`A lone surrogate (${describeCharacter(source.charCodeAt(offset))}) is not a Unicode scalar value`, offset);
}

/*
Creates an own property without ever invoking a setter, like `JSON.parse`. Plain assignment is used when `Object.prototype` has no property of that name, which is the fast common case. Otherwise, as for `__proto__`, `toString`, or anything a library added to the prototype, assignment would call a setter or fail on a frozen prototype. Also used by `evaluate()` in the tree, which makes the same plain objects.
*/
export function defineMember(object: ParsedObject, key: string, value: ParsedValue): void {
	if (Reflect.has(Object.prototype, key)) {
		Object.defineProperty(object, key, {
			value,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	} else {
		object[key] = value;
	}
}

export class Parser {
	readonly #source: string;
	#index = 0;
	readonly #integers: 'bigint' | 'number';
	readonly #createTime: (time: Time) => Temporal.Instant | Temporal.Duration | Time;
	readonly #onError: ((reason: string) => never) | undefined;
	/*
	Where the document's collection starts, after the comments and whitespace before it.
	*/
	#documentStart = 0;

	constructor(source: string, integers: 'bigint' | 'number', createTime: (time: Time) => Temporal.Instant | Temporal.Duration | Time = time => time.toTemporal(), onError?: (reason: string) => never) {
		this.#source = source;
		this.#integers = integers;
		this.#createTime = createTime;
		this.#onError = onError;
	}

	#fail(reason: string, offset = this.#index): never {
		// Isolated editor scalars need a reason, not an exception with a code frame and stack.
		if (this.#onError) {
			return this.#onError(reason);
		}

		throw ParseError.create(reason, this.#source, offset);
	}

	#code(offset = this.#index): number {
		return this.#source.charCodeAt(offset);
	}

	#isAtEnd(): boolean {
		return this.#index >= this.#source.length;
	}

	/*
	`bare-object = entry ( entry-sep entry )*`, where a separator is one or more line breaks.
	*/
	#parseBareObject(): ParsedObject {
		const object: ParsedObject = {};
		const start = this.#index;

		// The brace-less object is level 1 of the nesting, as a braced one is, although it never passes the depth check in `#parseItems()`, which level 1 cannot fail.
		try {
			this.#parseEntry(object, 1);
		} catch (error) {
			if (error instanceof ParseError) {
				this.#diagnoseBareValue(start);
			}

			throw error;
		}

		let hasLineBreak = this.#skipTrivia();

		while (!this.#isAtEnd()) {
			if (this.#code() === COMMA) {
				this.#fail('Top-level entries are separated by line breaks, not commas. Use braces for a one-line object');
			}

			if (!hasLineBreak) {
				this.#fail(`Expected a line break before the next entry, but found ${this.#describeHere()}${this.#slashCommentHint()}`);
			}

			this.#parseEntry(object, 1);
			hasLineBreak = this.#skipTrivia();
		}

		return object;
	}

	/*
	A whole document that is one scalar, such as `5` or an instant, fails as an entry. That failure is reported as what it is.
	*/
	#diagnoseBareValue(start: number): void {
		this.#index = start;
		let isBareValue = false;

		try {
			this.#parseValue(1);
			this.#skipTrivia();
			isBareValue = this.#isAtEnd();
		} catch {
			// Not a bare value either, so the original error stands.
		}

		if (isBareValue) {
			this.#fail('A bare value is not a document. A document is an object or an array, so write it as `key: value` or `[value]`', start);
		}
	}

	/*
	Skips spaces, tabs, line breaks, and comments, and reports whether a line break was crossed. A line break inside a block comment does not count.
	*/
	#skipTrivia(): boolean {
		const source = this.#source;
		let hasCrossedLineBreak = false;

		for (;;) {
			const code = source.charCodeAt(this.#index);

			if (isSpace(code)) {
				this.#index++;
			} else if (code === LF) {
				hasCrossedLineBreak = true;
				this.#index++;
			} else if (!this.#skipComment()) {
				return hasCrossedLineBreak;
			}
		}
	}

	/*
	Skips the comment that starts here, or returns `false` when there is none.
	*/
	#skipComment(): boolean {
		const source = this.#source;
		const code = source.charCodeAt(this.#index);

		if (code === HASH) {
			// Stops at the line feed, so that `#skipTrivia()` counts it as a line break.
			this.#index = findLineEnd(source, this.#index);
			return true;
		}

		if (code === SLASH && source.charCodeAt(this.#index + 1) === ASTERISK) {
			this.#skipBlockComment();
			return true;
		}

		return false;
	}

	#skipBlockComment(): void {
		const source = this.#source;
		const start = this.#index;
		// From after the `/*`, so that in `/*/ x */` the `*` of the opening does not also start the closing `*/`.
		const end = source.indexOf('*/', start + 2);

		if (end === -1) {
			this.#fail('Unterminated block comment', start);
		}

		const nested = source.indexOf('/*', start + 2);

		// The body may not contain `/*`. An opening that overlaps the closing `*/`, as in `/*/`, is not inside the body.
		if (nested !== -1 && nested + 2 <= end) {
			this.#fail('Block comments cannot be nested, and their body may not contain “/*”', nested);
		}

		this.#index = end + 2;
	}

	/*
	`entry = key ":" ws value`.
	*/
	#parseEntry(object: ParsedObject, depth: number): void {
		const keyStart = this.#index;
		const key = this.#parseKey();
		// Nothing may come between a key and its `:`, so no whitespace or comment is skipped here.
		const code = this.#code();

		if (code === DOT) {
			this.#failDotInKey(keyStart);
		}

		if (code !== COLON) {
			this.#failMissingColon(keyStart);
		}

		const colon = this.#index;
		this.#index++;
		this.#skipTrivia();
		let value: ParsedValue;

		try {
			value = this.#parseValue(depth + 1);
		} catch (error) {
			if (error instanceof ParseError) {
				this.#diagnoseBadValue(error, key, keyStart, colon);
			}

			throw error;
		}

		if (Object.hasOwn(object, key)) {
			this.#fail(`Duplicate key ${describeKey(key)}`, keyStart);
		}

		defineMember(object, key, value);
	}

	/*
	Reports a value that failed to parse as what the entry was meant to be, when that is clear.
	*/
	#diagnoseBadValue(error: ParseError, key: string, keyStart: number, colon: number): void {
		// A key that contains a `:`, as in `12:30: 'lunch'`, ends at the first `:`, and the rest is read as the value.
		if (isBareKeyCharacter(this.#code(colon + 1))) {
			this.#diagnoseKeyWithColon(keyStart);
		}

		this.#index = colon + 1;
		const isValueOnNextLine = this.#skipTrivia();
		const valueStart = this.#index;
		const commentHint = this.#describeCommentAsValue(colon);

		if (isValueOnNextLine) {
			this.#diagnoseMissingValue(valueStart, key, keyStart, commentHint);
		}

		// A value that was left out at the end of the document or of an object.
		const code = this.#code(valueStart);

		if (commentHint !== '' && error.offset === valueStart && (code === CLOSE_BRACE || Number.isNaN(code))) {
			this.#fail(`${error.reason}${commentHint}`, valueStart);
		}
	}

	/*
	A bare key followed directly by `:` and more of a key, up to a `:` that ends the key, as in `a:b: 1`.
	*/
	#diagnoseKeyWithColon(keyStart: number): void {
		const source = this.#source;

		for (let index = keyStart; index < keyStart + MAX_DIAGNOSED_LENGTH; index++) {
			const code = source.charCodeAt(index);

			if (code === COLON) {
				const next = source.charCodeAt(index + 1);

				if (next === LF || isSpace(next) || Number.isNaN(next)) {
					this.#fail(`A key that contains “:” must be quoted, as in '${abbreviate(source.slice(keyStart, index))}'`, keyStart);
				}
			} else if (!isBareKeyCharacter(code)) {
				return;
			}
		}
	}

	/*
	The hint for a `#` directly after a `:`, as in `color: #FFF`, which starts a comment rather than a value.
	*/
	#describeCommentAsValue(colon: number): string {
		const source = this.#source;
		const hash = skipSpaces(source, colon + 1);

		if (source.charCodeAt(hash) !== HASH) {
			return '';
		}

		// A `#` followed by a space, or by another `#`, starts an ordinary comment. A separator or a closing bracket after the value is not part of it. The regular expression, which needs stack in proportion to its match, only sees the start of a long comment, which is cut short in the message anyway.
		const match = /^#[^\t\n #,\]\}][^\t\n ,\]\}]*/v.exec(source.slice(hash, hash + MAX_DIAGNOSED_LENGTH));
		return match === null ? '' : `. “#” starts a comment, so a value that starts with “#” must be quoted${quotingExample(match[0])}`;
	}

	/*
	An entry whose value was left out, as in `a:` followed by `'b': 1` on the next line, reads the next key as the value. That failure is reported as what it is.
	*/
	#diagnoseMissingValue(start: number, parent: string, keyStart: number, commentHint: string): void {
		// A YAML block sequence.
		if (this.#code(start) === DASH && isSpace(this.#code(start + 1))) {
			this.#fail('Expected a value, but found a “-” list. An array is written in brackets, as in [80, 443]', start);
		}

		this.#index = start;
		let key: string | undefined;

		try {
			key = this.#parseKey();
		} catch {
			// Not a key either, so the original error stands.
		}

		if (key === undefined || this.#code() !== COLON) {
			return;
		}

		// Whitespace or the end follows the `:` of a bare key. A digit follows the `:` in an instant such as `2026-09-19T25:00:00Z`, whose own error is more precise. A quoted key cannot be part of a value, so anything may follow its `:`.
		const next = this.#code(this.#index + 1);
		const firstCode = this.#code(start);

		if (firstCode !== SINGLE_QUOTE && firstCode !== DOUBLE_QUOTE && next !== LF && !isSpace(next) && !Number.isNaN(next)) {
			return;
		}

		const hint = commentHint === '' ? this.#describeIndentedKey(parent, key, keyStart, start) : commentHint;
		this.#fail(`Expected a value, but found the key ${describeKey(key)}${hint}`, start);
	}

	/*
	The hint for a key at `start` that is indented under the entry whose value is missing, as YAML nests an object.
	*/
	#describeIndentedKey(parent: string, key: string, keyStart: number, start: number): string {
		const keyIndentation = getIndentation(this.#source, keyStart);
		const indentation = getIndentation(this.#source, start);

		// The keys are written as in a document, so that the suggestion is valid, rather than as JSON strings like the rest of the message, whose escapes, such as `\b`, are not all valid.
		const hint = `. Indentation does not nest objects, so write ${abbreviate(formatKey(parent), 200)}: {${abbreviate(formatKey(key), 200)}: …}`;
		return keyIndentation === undefined || indentation === undefined || indentation <= keyIndentation ? '' : hint;
	}

	#failMissingColon(keyStart: number): never {
		const source = this.#source;
		const next = skipSpaces(source, this.#index);
		const nextCode = source.charCodeAt(next);

		if (nextCode === COLON && next > this.#index) {
			this.#fail('Whitespace is not allowed between a key and its “:”');
		}

		// A block comment followed by the ":" was meant to come before it.
		if (nextCode === SLASH && source.charCodeAt(next + 1) === ASTERISK) {
			const commentEnd = source.indexOf('*/', next + 2);

			if (commentEnd !== -1 && source.charCodeAt(skipSpaces(source, commentEnd + 2)) === COLON) {
				this.#fail('A comment is not allowed between a key and its “:”', next);
			}
		}

		const colon = source.indexOf(':', next);

		// A key with a space in it, such as `the name: 1`. The hint is only given for plain words, because quoting a quoted key would change what it means, and for a `:` that whitespace or the end follows, because quoting the words before the `:` in `server localhost:8080` would give a valid document with another meaning. So `the name:1` gets no hint.
		if (colon !== -1 && next > this.#index && isBareKeyCharacter(nextCode) && colon < findLineEnd(source, next) && isSpaceOrLineEnd(source.charCodeAt(colon + 1))) {
			// Only spaces and tabs are trimmed, because `trimEnd()` would also remove characters that are not whitespace in SOML, such as U+00A0.
			const key = source.slice(keyStart, skipSpacesBack(source, colon));

			if (isWordsWithSpaces(key)) {
				this.#fail(`A bare key cannot contain spaces. Quote it, as in '${abbreviate(key)}'`, keyStart);
			}
		}

		if (this.#isAtEnd() || this.#code() === LF) {
			this.#fail('Expected “:” after the key');
		}

		// A character directly after a bare key is most likely meant to be part of it.
		const previousCode = source.charCodeAt(this.#index - 1);
		const hint = previousCode !== SINGLE_QUOTE && previousCode !== DOUBLE_QUOTE && next === this.#index && QUOTABLE_KEY_START.test(source.slice(next, next + 2)) ? KEY_QUOTING_HINT : '';
		this.#index = next;
		this.#fail(`Expected “:” after the key, but found ${this.#describeHere()}${hint}`);
	}

	#parseKey(): string {
		const source = this.#source;
		const start = this.#index;
		const code = source.charCodeAt(start);

		if (code === SINGLE_QUOTE || code === DOUBLE_QUOTE) {
			if (source.charCodeAt(start + 1) === code && source.charCodeAt(start + 2) === code) {
				this.#fail('A block string cannot be a key');
			}

			// A key is a string, so it may hold anything a string can, including a line feed written as an escape.
			return code === SINGLE_QUOTE ? this.#parseLiteralString() : this.#parseEscapedString();
		}

		let end = start;

		while (isBareKeyCharacter(source.charCodeAt(end))) {
			end++;
		}

		if (end === start) {
			if (code === OPEN_BRACKET) {
				this.#diagnoseTableHeader();
			}

			this.#fail(this.#isAtEnd() ? 'Expected a key' : `Expected a key, but found ${this.#describeHere()}${this.#keyQuotingHint()}${this.#slashCommentHint()}`);
		}

		this.#index = end;
		return source.slice(start, end);
	}

	/*
	The hint for a key that starts with a character a bare key cannot hold, such as the `$` in `$schema`, or nothing for a character with another meaning, such as `}`.
	*/
	#keyQuotingHint(): string {
		if (!QUOTABLE_KEY_START.test(this.#source.slice(this.#index, this.#index + 2))) {
			return '';
		}

		// A longer key gets the hint without the example, and the regular expression, which backtracks, never sees a huge run.
		const key = QUOTABLE_KEY.exec(this.#source.slice(this.#index, this.#index + MAX_DIAGNOSED_LENGTH))?.[0];
		return key === undefined ? KEY_QUOTING_HINT : `${KEY_QUOTING_HINT}, as in '${abbreviate(key)}'`;
	}

	/*
	A `.` after a key, as in `example.com: 1`. A key is never a path, so the `.` is meant either as part of the key or as nesting.
	*/
	#failDotInKey(keyStart: number): never {
		const source = this.#source;
		let end = this.#index;

		while (end < keyStart + MAX_DIAGNOSED_LENGTH && (isBareKeyCharacter(source.charCodeAt(end)) || source.charCodeAt(end) === DOT)) {
			end++;
		}

		const key = source.slice(keyStart, end);
		const words = key.split('.');

		// The suggestions are only given for a bare key whose dots each have a word on both sides, so that both are valid.
		if (source.charCodeAt(end) !== COLON || !isBareKeyCharacter(source.charCodeAt(keyStart)) || words.includes('')) {
			this.#fail('A key cannot contain “.” unless it is quoted. Quote the whole key, or use braces to nest, as in a: {b: …}');
		}

		const nested = `${words.join(': {')}: …${'}'.repeat(words.length - 1)}`;
		this.#fail(`A bare key cannot contain “.”. Quote it, as in '${abbreviate(key)}', or use braces to nest, as in ${abbreviate(nested)}`);
	}

	#parseObject(depth: number): ParsedObject {
		const object: ParsedObject = {};

		this.#parseItems(depth, CLOSE_BRACE, () => {
			this.#parseEntry(object, depth);
		});

		return object;
	}

	#parseArray(depth: number): ParsedValue[] {
		const array: ParsedValue[] = [];

		this.#parseItems(depth, CLOSE_BRACKET, () => {
			array.push(this.#parseValue(depth + 1));
		});

		return array;
	}

	/*
	`{` or `[` at depth `depth`, then items separated by a comma, a line break, or both, with an optional trailing comma, then the `closing` bracket. A comma must be on the line of the item before it.
	*/
	#parseItems(depth: number, closing: typeof CLOSE_BRACE | typeof CLOSE_BRACKET, parseItem: () => void): void {
		// Only a collection is a level, so the check is here rather than in `#parseValue()`, and a scalar inside the deepest collection is accepted.
		if (depth > MAX_DEPTH) {
			this.#fail(`The document is nested more than ${MAX_DEPTH} levels deep`);
		}

		const start = this.#index;
		this.#index++;
		this.#skipTrivia();

		// A trailing comma needs no case of its own: after the comma, the loop ends at the closing bracket.
		while (this.#code() !== closing) {
			let hasLineBreak = false;
			let itemEnd = this.#index;

			// At the end, no item is parsed, so that the error is about the unterminated collection rather than a missing item.
			if (!this.#isAtEnd()) {
				parseItem();
				itemEnd = this.#index;
				hasLineBreak = this.#skipTrivia();
			}

			if (this.#isAtEnd()) {
				this.#fail(`Unterminated ${closing === CLOSE_BRACE ? 'object' : 'array'}: expected “${String.fromCharCode(closing)}”`, start);
			}

			if (this.#code() === COMMA) {
				if (hasLineBreak) {
					this.#fail('A comma must be on the same line as the item before it. The line break already separates the items, so remove the comma');
				}

				this.#index++;
				this.#skipTrivia();
			} else if (!hasLineBreak && this.#code() !== closing) {
				const item = closing === CLOSE_BRACE ? 'an object member' : 'an array item';
				// Without a line break that separates, a line break in the gap is inside a block comment.
				const hint = this.#source.slice(itemEnd, this.#index).includes('\n') ? '. A line break inside a block comment does not separate items' : this.#slashCommentHint();
				this.#fail(`Expected “,”, a line break, or “${String.fromCharCode(closing)}” after ${item}, but found ${this.#describeHere()}${hint}`);
			}
		}

		this.#index++;
	}

	#parseValue(depth: number): ParsedValue {
		const code = this.#code();

		if (code === OPEN_BRACE) {
			return this.#parseObject(depth);
		}

		if (code === OPEN_BRACKET) {
			return this.#parseArray(depth);
		}

		const start = this.#index;
		let value: ParsedValue;
		// An int or a float written with digits.
		let isNumber = false;

		if (code === SINGLE_QUOTE || code === DOUBLE_QUOTE) {
			value = this.#parseString();
		} else if (code === 0x74 /* t */ && this.#isKeyword('true')) {
			value = true;
		} else if (code === 0x66 /* f */ && this.#isKeyword('false')) {
			value = false;
		} else if (code === 0x6E /* n */ && this.#isKeyword('null')) {
			value = null;
		} else if (code === 0x69 /* i */ && this.#isKeyword('infinity')) {
			value = Infinity;
		} else if (code === DASH && this.#isKeyword('-infinity')) {
			value = -Infinity;
		} else if (code === DASH || isDigit(code)) {
			value = this.#parseNumberOrInstant();
			isNumber = typeof value === 'bigint' || typeof value === 'number';
		} else {
			this.#failUnexpectedValue();
		}

		if (!isValueEnd(this.#code())) {
			this.#failAfterValue(start, isNumber);
		}

		if (isNumber && isSpace(this.#code())) {
			this.#diagnoseUnitAfterSpace(start);
		}

		return value;
	}

	/*
	A character that cannot follow the value that starts at `start`.
	*/
	#failAfterValue(start: number, isNumber: boolean): never {
		const code = this.#code();

		// Go writes microseconds as `µs`, with the micro sign or the Greek letter mu. The duration is only suggested when it is valid, which a number with an exponent or a radix prefix, for example, is not.
		if (isNumber && (code === 0xB5 || code === 0x3_BC) && this.#code(this.#index + 1) === 0x73 /* s */) {
			const number = this.#source.slice(start, this.#index);
			this.#fail(`The unit for microseconds is written us${isValidValue(`${number}us`) ? `, as in ${abbreviate(number)}us` : ''}`);
		}

		// A `''` inside a '...' string, as SQL and YAML escape a quote, ends the string.
		if (code === SINGLE_QUOTE && this.#code(start) === SINGLE_QUOTE) {
			this.#fail('There is no \'\' escape in a \'...\' string. Write a string that contains \' as "...", as in "it\'s"');
		}

		this.#fail(`Unexpected ${this.#describeHere()} after a value`);
	}

	/*
	A number followed by a space and a word, such as `512 MiB` or `10 seconds`, which is an error anyway. A word followed by more than spaces, a separator, or a comment is left to the general errors, because it may be a key, as in `a: 1 b: 2`, or a sentence.
	*/
	#diagnoseUnitAfterSpace(start: number): void {
		const source = this.#source;
		const unitStart = skipSpaces(source, this.#index);
		let unitEnd = unitStart;

		while (isLetter(source.charCodeAt(unitEnd))) {
			unitEnd++;
		}

		const unit = source.slice(unitStart, unitEnd);

		// A keyword after a number is a missing comma.
		if (unit === '' || !isValueEndAt(source, skipSpaces(source, unitEnd)) || ['true', 'false', 'null', 'infinity'].includes(unit)) {
			return;
		}

		const number = source.slice(start, this.#index);
		// The duration is only suggested when it is valid, which a number with an exponent or a radix prefix, a fraction of a nanosecond, a negative zero, or a value outside the 64-bit range is not. The string is always offered, because a unit such as `m` may mean meters rather than minutes.
		const duration = DURATION_UNITS.has(unit) && isValidValue(`${number}${unit}`) ? `${abbreviate(number)}${unit}` : '10s';
		this.#fail(`A unit cannot follow a number after a space. Write a duration without the space, as in ${duration}, and anything else, such as a size, as a string, as in '${abbreviate(`${number} ${unit}`)}'`, unitStart);
	}

	#isKeyword(word: string): boolean {
		if (!this.#source.startsWith(word, this.#index)) {
			return false;
		}

		const next = this.#code(this.#index + word.length);

		// A longer word, such as `nullable`, is not the keyword.
		if (isBareKeyCharacter(next)) {
			return false;
		}

		this.#index += word.length;
		return true;
	}

	#failUnexpectedValue(): never {
		if (this.#isAtEnd()) {
			this.#fail('Expected a value, but reached the end of the document');
		}

		const code = this.#code();

		if (code === 0x2B /* + */) {
			this.#fail('A “+” sign is not allowed. A number without a sign is positive');
		}

		// A `.` that no digit follows begins a string, such as `.env` or `./foo`, rather than a number.
		if (code === DOT) {
			this.#fail(isDigit(this.#code(this.#index + 1)) ? 'A number cannot begin with “.”; write a digit before it, as in 0.5' : describeUnknownWord('.', this.#unquotedText()));
		}

		let wordEnd = this.#index;

		while (isBareKeyCharacter(this.#code(wordEnd))) {
			wordEnd++;
		}

		if (wordEnd > this.#index) {
			const word = this.#source.slice(this.#index, wordEnd);

			// A key where a value should be, as when the value of an entry is left out and the next line has a key, or as in `[a: 1]`, is reported as a key. A word after the `:` of a member and a space, as in `msg: Error: file not found` or `url: https://example.com`, is that member's value instead, an unquoted string. Without the space, as in `a:b: 1`, the first `:` was most likely meant as part of the key.
			const spacesStart = skipSpacesBack(this.#source, this.#index);
			const isMemberValue = spacesStart < this.#index && this.#code(spacesStart - 1) === COLON;

			if (!isMemberValue && this.#code(wordEnd) === COLON) {
				this.#fail(`Expected a value, but found the key ${abbreviate(word)}`);
			}

			this.#diagnoseTableHeader(true);
			this.#fail(describeUnknownWord(word, this.#unquotedText()));
		}

		this.#fail(`Expected a value, but found ${this.#describeHere()}${this.#isBlockScalarIndicator() ? '. Write a multiline string as a block string, between \'\'\' lines' : this.#slashCommentHint()}`);
	}

	/*
	The text from `start` that was most likely meant as one unquoted string, such as `John Smith`: up to the end of the line, a comma, a closing bracket, or a comment after a space or a tab, without the spaces and tabs at its end.
	*/
	#unquotedText(start = this.#index): string {
		const source = this.#source;
		const limit = Math.min(source.length, start + MAX_DIAGNOSED_LENGTH);
		let end = start;

		while (end < limit && !isUnquotedTextEnd(source, end)) {
			end++;
		}

		return source.slice(start, skipSpacesBack(source, end));
	}

	/*
	A TOML table header, as in `[server]` or `[[servers]]` on a line of its own, reads as an array that holds a word, or as a key that starts with "[". Where a value is expected, `isValue`, it is only a table header when its bracket opens the document, because a table cannot be written as an item of an array inside it.
	*/
	#diagnoseTableHeader(isValue = false): void {
		const source = this.#source;
		const lineStart = source.lastIndexOf('\n', this.#index - 1) + 1;

		if (isValue && skipSpaces(source, lineStart) !== this.#documentStart) {
			return;
		}

		const line = source.slice(lineStart, Math.min(findLineEnd(source, this.#index), lineStart + MAX_DIAGNOSED_LENGTH));
		// The name is a valid key, so that the suggestion is valid.
		const match = /^[\t ]*\[\[?(?<name>[A-Z_a-z][\w\-]*)\]\]?[\t ]*$/v.exec(line);

		if (match === null) {
			return;
		}

		const {name} = match.groups as {name: string};
		this.#fail(`There are no table headers. Write the table as an object, as in ${abbreviate(name)}: {…}`);
	}

	/*
	A YAML literal block scalar indicator, as in `key: |` or `key: |-`, at the end of its line.
	*/
	#isBlockScalarIndicator(): boolean {
		const code = this.#code();

		// A folded block scalar, `>`, joins its lines, which a block string does not, so only `|` gets the hint.
		if (code !== 0x7C /* | */) {
			return false;
		}

		const chomping = this.#code(this.#index + 1);
		const end = skipSpaces(this.#source, chomping === DASH || chomping === 0x2B /* + */ ? this.#index + 2 : this.#index + 1);
		const next = this.#code(end);
		return next === LF || Number.isNaN(next);
	}

	/*
	The hint for a `//` comment, as in JavaScript.
	*/
	#slashCommentHint(): string {
		return this.#code() === SLASH && this.#code(this.#index + 1) === SLASH ? '. A comment starts with “#”' : '';
	}

	#describeHere(): string {
		if (this.#isAtEnd()) {
			return 'the end of the document';
		}

		const code = this.#source.codePointAt(this.#index)!;

		return code === LF ? 'a line break' : describeCharacter(code);
	}

	#parseString(): string {
		const source = this.#source;
		const code = this.#code();

		if (source.charCodeAt(this.#index + 1) === code && source.charCodeAt(this.#index + 2) === code) {
			return this.#parseBlockString(code);
		}

		return code === SINGLE_QUOTE ? this.#parseLiteralString() : this.#parseEscapedString();
	}

	/*
	`'...'` has no escapes, so its value is the source text between the quotes.
	*/
	#parseLiteralString(): string {
		const source = this.#source;
		const start = this.#index;
		// Stops at the first quote or line break, so that a one-line document with many strings stays linear.
		LITERAL_STRING_END.lastIndex = start + 1;
		const match = LITERAL_STRING_END.exec(source);

		if (match === null || source.charCodeAt(match.index) === LF) {
			this.#fail('Unterminated string. A \'...\' string must end on the line it starts on; use a block string (\'\'\') for multiple lines', start);
		}

		const end = match.index;
		this.#index = end + 1;
		// No character needs a check, because `checkCharacters()` has already refused the control characters and lone surrogates everywhere.
		return source.slice(start + 1, end);
	}

	#parseEscapedString(): string {
		const source = this.#source;
		const start = this.#index;
		let chunkStart = start + 1;
		let value = '';

		for (;;) {
			ESCAPED_STRING_SPECIAL.lastIndex = chunkStart;
			const match = ESCAPED_STRING_SPECIAL.exec(source);

			if (match === null || match[0] === '\n') {
				this.#fail('Unterminated string. A "..." string must end on the line it starts on; use a block string (""") for multiple lines', start);
			}

			value += source.slice(chunkStart, match.index);

			if (match[0] === '"') {
				this.#index = match.index + 1;
				return value;
			}

			const {text, end} = this.#parseEscape(match.index);
			value += text;
			chunkStart = end;
		}
	}

	/*
	Decodes the escape at `offset`, which is a backslash.
	*/
	#parseEscape(offset: number): {text: string; end: number} {
		const source = this.#source;
		const character = source[offset + 1];
		const simple = SIMPLE_ESCAPES.get(character ?? '');

		if (simple !== undefined) {
			return {text: simple, end: offset + 2};
		}

		if (character === 'u') {
			UNICODE_ESCAPE.lastIndex = offset + 1;
			const match = UNICODE_ESCAPE.exec(source);

			if (match === null) {
				this.#fail(describeBadUnicodeEscape(source, offset + 1), offset);
			}

			const {hex} = match.groups as {hex: string};
			const codePoint = Number.parseInt(hex, 16);

			// The value is checked before the spelling, so that the uppercase and leading zeros errors never point to an escape that is not allowed either.
			if (codePoint === 0x0D) {
				this.#fail(String.raw`A carriage return (U+000D) cannot be represented, so \u{${hex}} is not allowed`, offset);
			}

			if (codePoint >= 0xD8_00 && codePoint <= 0xDF_FF) {
				this.#fail(String.raw`\u{${hex}} is a surrogate, which is not a Unicode scalar value`, offset);
			}

			if (codePoint > 0x10_FF_FF) {
				this.#fail(String.raw`\u{${hex}} is above U+10FFFF, the largest Unicode scalar value`, offset);
			}

			if (/[A-F]/v.test(hex)) {
				this.#fail('A Unicode escape uses lowercase hexadecimal digits', offset);
			}

			if (hex.length > 1 && hex.startsWith('0')) {
				this.#fail(String.raw`A Unicode escape may not have leading zeros; write \u{${hex.replace(/^0+(?=.)/v, '')}}`, offset);
			}

			return {text: String.fromCodePoint(codePoint), end: offset + 1 + match[0].length};
		}

		// A backslash at the end of the document is the same mistake as one at the end of a line.
		const reason = ESCAPE_MISTAKES.get(character ?? '\n') ?? `Unknown escape “\\${String.fromCodePoint(source.codePointAt(offset + 1)!)}”. The escapes are \\\\, \\", \\n, \\t, and \\u{…}; use a '...' string for literal backslashes`;
		this.#fail(reason, offset);
	}

	/*
	A block string opens with a run of three or more quotes and a line break, and closes at the first line whose first non-whitespace content is a run of exactly that many quotes. The closing line's indentation is removed from every content line, except a blank one, which holds only spaces and tabs and becomes an empty line.
	*/
	#parseBlockString(quote: number): string {
		const source = this.#source;
		const start = this.#index;
		let delimiterLength = 0;

		while (source.charCodeAt(start + delimiterLength) === quote) {
			delimiterLength++;
		}

		this.#index = start + delimiterLength;

		if (this.#isAtEnd()) {
			this.#fail('Unterminated block string', start);
		}

		// As in Swift, the opening delimiter is followed directly by a line break, not even by trailing whitespace.
		if (this.#code() !== LF) {
			this.#fail('A block string\'s opening delimiter must be followed directly by a line break, and its content starts on the next line');
		}

		const contentStart = this.#index + 1;
		const closing = findBlockStringEnd(source, contentStart, quote, delimiterLength);

		if (closing === undefined) {
			this.#fail(`Unterminated block string${this.#describeInlineClosingDelimiter(contentStart, quote, delimiterLength)}`, start);
		}

		const indentation = source.slice(closing.lineStart, closing.delimiterStart);
		this.#index = closing.delimiterStart + delimiterLength;
		const contents: Array<{text: string; offset: number}> = [];

		for (let lineStart = contentStart; lineStart < closing.lineStart; lineStart = findLineEnd(source, lineStart) + 1) {
			const line = source.slice(lineStart, findLineEnd(source, lineStart));

			// A blank line, which is empty or holds only spaces and tabs, may leave out the indentation, and it becomes an empty line. Swift is stricter here: there only a completely empty line may leave it out.
			if (isBlankLine(line)) {
				contents.push({text: '', offset: lineStart});
			} else if (line.startsWith(indentation)) {
				contents.push({text: line.slice(indentation.length), offset: lineStart + indentation.length});
			} else {
				this.#fail('This line does not start with the indentation of its block string\'s closing delimiter. Every line except a blank one must start with exactly the same spaces and tabs', lineStart);
			}
		}

		// Blank lines directly after the opening delimiter and directly before the closing one are not content. Every blank line is empty by now.
		let first = 0;
		let last = contents.length;

		while (first < last && contents[first]!.text === '') {
			first++;
		}

		while (last > first && contents[last - 1]!.text === '') {
			last--;
		}

		const kept = contents.slice(first, last);

		return quote === SINGLE_QUOTE ? kept.map(line => line.text).join('\n') : kept.map(line => this.#unescapeLine(line.text, line.offset)).join('\n');
	}

	/*
	The hint for a content line that ends with the delimiter, as TOML allows. Adding a closing line after it would keep the delimiter as content.
	*/
	#describeInlineClosingDelimiter(contentStart: number, quote: number, delimiterLength: number): string {
		const source = this.#source;
		const quoteCharacter = String.fromCharCode(quote);
		const delimiter = quoteCharacter.repeat(delimiterLength);
		let line = source.slice(0, contentStart).split('\n').length;

		for (let lineStart = contentStart; lineStart < source.length; lineStart = findLineEnd(source, lineStart) + 1) {
			const text = source.slice(skipSpaces(source, lineStart), skipSpacesBack(source, findLineEnd(source, lineStart)));

			// A line of only quotes, longer than the delimiter, is content.
			if (text.endsWith(delimiter) && text !== quoteCharacter.repeat(text.length)) {
				return `. Its closing delimiter must start a line, so move the ${delimiter} at the end of line ${line} to a new line`;
			}

			line++;
		}

		return '';
	}

	/*
	Decodes the escapes of one content line of a `"""` block. That happens after the indentation is removed and the blank lines at the start and end are dropped, so a line that holds only the escape `\t` is content rather than blank. Each escape is read from the source at its offset, so a `\` at the end of a line sees the line feed and fails, because there is no line continuation.
	*/
	#unescapeLine(text: string, offset: number): string {
		let value = '';
		let chunkStart = 0;

		for (let index = text.indexOf('\\'); index !== -1; index = text.indexOf('\\', chunkStart)) {
			value += text.slice(chunkStart, index);
			const escape = this.#parseEscape(offset + index);
			value += escape.text;
			chunkStart = escape.end - offset;
		}

		return value + text.slice(chunkStart);
	}

	#parseNumberOrInstant(): bigint | number | Temporal.Instant | Temporal.Duration | Time {
		const plain = this.#parsePlainNumber();

		if (plain !== undefined) {
			return plain;
		}

		const start = this.#index;
		const end = findNumberEnd(this.#source, start);
		const text = this.#source.slice(start, end);
		this.#index = end;

		// A token that starts with a date cannot be a number or a duration, so it gets the instant errors even when the rest is malformed.
		if (INSTANT_PREFIX.test(text)) {
			return this.#parseInstant(text, start);
		}

		const kind = classifyNumber(text);

		if (kind === undefined && isDurationLike(text)) {
			return this.#parseDuration(text, start);
		}

		switch (kind) {
			case 'int': {
				if (text === '-0') {
					this.#fail('“-0” is not allowed, because zero has one spelling: 0', start);
				}

				return this.#integer(text.replaceAll('_', ''), text, start);
			}

			case 'float': {
				const value = Number(text.replaceAll('_', ''));

				if (!Number.isFinite(value)) {
					this.#fail(`${abbreviate(text)} is too large to be a finite float. Use ${value < 0 ? '-infinity' : 'infinity'} if you mean it`, start);
				}

				if (value === 0) {
					// A nonzero digit before the exponent means the literal is not zero, so it underflowed.
					if (/[1-9]/v.test(text.split('e', 1)[0]!)) {
						this.#fail(`${abbreviate(text)} is too small to be told apart from zero. Write 0.0 if you mean zero`, start);
					}

					// Negative zero is the same value as zero.
					return 0;
				}

				return value;
			}

			default: {
				break;
			}
		}

		this.#fail(this.#describeThousandsSeparator(text, start) ?? describeBadNumber(text, this.#unquotedText(start)), start);
	}

	/*
	A comma used as a thousands separator, as in `[1,000]`, makes the group after it a separate item, which fails only when it has a leading zero. Writing that item in octal, as the leading zero message suggests, would parse to the wrong items.
	*/
	#describeThousandsSeparator(text: string, start: number): string | undefined {
		if (!/^0\d{2}$/v.test(text) || this.#code(start - 1) !== COMMA) {
			return undefined;
		}

		const getGroupStart = (groupEnd: number): number => {
			let groupStart = groupEnd;

			while (isDigit(this.#code(groupStart - 1))) {
				groupStart--;
			}

			return groupStart;
		};

		let groupEnd = start - 1;
		let numberStart = getGroupStart(groupEnd);

		// Earlier groups of three digits, as in `12,345,000`.
		while (groupEnd - numberStart === 3 && this.#code(numberStart - 1) === COMMA && isDigit(this.#code(numberStart - 2))) {
			groupEnd = numberStart - 1;
			numberStart = getGroupStart(groupEnd);
		}

		const before = this.#code(numberStart - 1);

		// The first group has one to three digits, which are not the end of a float, of a number with underscores, or of a number with a radix prefix.
		if (
			numberStart === groupEnd
			|| before === DOT
			|| before === 0x5F /* _ */
			|| numberStart < groupEnd - 3
			|| isLetter(before)
		) {
			return undefined;
		}

		// The sign belongs to the number, as in `-1,000`.
		if (before === DASH) {
			numberStart--;
		}

		const groupsStart = start + text.length;
		const groups = /^(?:,\d{3}(?!\d))*/v.exec(this.#source.slice(groupsStart, groupsStart + MAX_DIAGNOSED_LENGTH))![0];
		const number = this.#source.slice(numberStart, groupsStart + groups.length);
		const reason = `Leading zeros are not allowed in a decimal number. A comma separates items, so ${abbreviate(number)} is not one number`;
		// Both spellings are the same int, so they are suggested only when it is in range.
		const withUnderscores = number.replaceAll(',', '_');
		return isValidValue(withUnderscores) ? `${reason}. Write it as ${abbreviate(withUnderscores)} or ${abbreviate(number.replaceAll(',', ''))}` : reason;
	}

	/*
	The common case, a short decimal int or float such as `8080`, `-3`, or `30.5`, without the general path's maximal-run scan and classification. Anything else, including every error, returns `undefined` and is left to the general path.
	*/
	#parsePlainNumber(): bigint | number | undefined {
		const source = this.#source;
		const start = this.#index;
		let index = source.charCodeAt(start) === DASH ? start + 1 : start;
		const integerStart = index;

		while (isDigit(source.charCodeAt(index))) {
			index++;
		}

		const integerLength = index - integerStart;

		// No digits, or a leading zero followed by more digits, which the general path reports as an error or reads as an instant before the year 1000.
		if (integerLength === 0 || (integerLength > 1 && source.charCodeAt(integerStart) === 0x30)) {
			return;
		}

		let isFloat = false;

		if (source.charCodeAt(index) === DOT) {
			const fractionStart = index + 1;
			index = fractionStart;

			while (isDigit(source.charCodeAt(index))) {
				index++;
			}

			if (index === fractionStart) {
				return;
			}

			isFloat = true;
		}

		// At most 15 digits, so an int is exact as a number. A character that may continue a number, such as `e`, `_`, or `-`, needs the general path.
		if (index - integerStart > 15 || !isValueEnd(source.charCodeAt(index))) {
			return;
		}

		const value = Number(source.slice(start, index));

		if (isFloat) {
			this.#index = index;

			// Negative zero is the same value as zero.
			return value === 0 ? 0 : value;
		}

		// `-0` is an error, which the general path reports.
		if (value === 0 && index - start > 1) {
			return;
		}

		this.#index = index;
		return this.#integers === 'bigint' ? BigInt(value) : value;
	}

	/*
	`digits` is the int without underscores. More than 64 significant digits is out of range in any radix, which is decided before `BigInt` spends time on a huge digit string.
	*/
	#integer(digits: string, text: string, start: number): bigint | number {
		// Only a radix prefix puts a letter second, as the `x` in `0xFF`. A decimal int has a digit there.
		const isRadix = digits.length > 1 && digits.charCodeAt(1) > 0x39;
		let significant = digits.charCodeAt(0) === DASH ? 1 : 0;

		if (isRadix) {
			significant = 2;

			while (digits.charCodeAt(significant) === 0x30) {
				significant++;
			}
		}

		// `BigInt()` reads the `0x`, `0o`, and `0b` prefixes itself. A run of only zeros after the prefix keeps one, because `BigInt('0x')` throws.
		const value = digits.length - significant > 64 ? undefined : BigInt(isRadix ? `${digits.slice(0, 2)}${digits.length === significant ? '0' : digits.slice(significant)}` : digits);

		if (value === undefined || value < INT64_MIN || value > INT64_MAX) {
			this.#fail(`The integer ${abbreviate(text)} is outside the 64-bit range (-9223372036854775808 to 9223372036854775807)`, start);
		}

		if (this.#integers === 'bigint') {
			return value;
		}

		if (value < Number.MIN_SAFE_INTEGER || value > Number.MAX_SAFE_INTEGER) {
			this.#fail(`The integer ${abbreviate(text)} cannot be represented exactly as a JavaScript number. Remove the \`integers: 'number'\` option to get a BigInt`, start);
		}

		return Number(value);
	}

	/*
	An offset on its own after spaces, as in `2026-09-19T14:00:00 Z`, which belongs directly after the time, or `undefined`.
	*/
	#findOffsetAfterSpace(): string | undefined {
		const source = this.#source;
		const offsetStart = skipSpaces(source, this.#index);

		if (offsetStart === this.#index) {
			return undefined;
		}

		OFFSET.lastIndex = offsetStart;
		const offset = OFFSET.exec(source)?.[0];
		return offset !== undefined && isValueEndAt(source, offsetStart + offset.length) ? offset : undefined;
	}

	#parseInstant(text: string, start: number): Temporal.Instant | Temporal.Duration | Time {
		const match = text.length > MAX_DIAGNOSED_LENGTH ? null : INSTANT.exec(text);

		if (match === null) {
			// A date, a space, and a time, as TOML and Python write a date and time.
			const timeStart = this.#index + 1;
			const end = this.#code() === SPACE && isDigit(this.#code(timeStart)) ? findNumberEnd(this.#source, timeStart) : this.#index;
			const time = this.#source.slice(timeStart, end);
			// More of the instant may follow, as in `14:00:00,5Z` or `14:00:00[Europe/Oslo]`, so it may have an offset.
			const isWholeValue = isValueEndAt(this.#source, end) && !(this.#code(end) === COMMA && isDigit(this.#code(end + 1)));
			this.#fail(describeBadInstant(text, time, isWholeValue, this.#findOffsetAfterSpace()), start);
		}

		const {year, month, day, hour, minute, second, fraction, offset, offsetHour, offsetMinute} = match.groups as InstantGroups;
		const check = (isValid: boolean, reason: string): void => {
			if (!isValid) {
				this.#fail(`Invalid instant ${abbreviate(text)}: ${reason}`, start);
			}
		};

		check(fraction === undefined || fraction.length <= 9, 'a fractional second has at most nine digits');
		check(year !== '0000', 'the year must be 0001 to 9999');
		check(month >= '01' && month <= '12', 'the month must be 01 to 12');
		const lastDay = daysInMonth(Number(year), Number(month));
		check(day >= '01' && Number(day) <= lastDay, `the day must be 01 to ${lastDay} in that month`);
		check(hour <= '23', 'the hour must be 00 to 23');
		check(minute <= '59', 'the minute must be 00 to 59');
		check(second <= '59', 'the second must be 00 to 59, and a leap second is not representable');

		if (offset !== 'Z') {
			check(offsetHour! <= '23', 'the offset hour must be 00 to 23');
			check(offsetMinute! <= '59', 'the offset minute must be 00 to 59');
			check(offset !== '-00:00', '-00:00 means “offset unknown” in RFC 3339, which is not representable; use Z or +00:00');
		}

		// `Date.parse()` reads this format exactly, for every year from 0001 to 9999 and every offset, so the range check needs no `Temporal`.
		const milliseconds = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`);
		// The fraction is left out of `Date.parse()`, which would keep only its first three digits, and added here as nanoseconds.
		const nanoseconds = (BigInt(milliseconds) * 1_000_000n) + BigInt((fraction ?? '').padEnd(9, '0'));
		check(nanoseconds >= MIN_INSTANT && nanoseconds <= MAX_INSTANT, 'in UTC it falls outside the years 0001 to 9999');
		return this.#createTime(new Time('Instant', nanoseconds));
	}

	/*
	A scan of the parts in order, so that each error names the part it is about.
	*/
	#parseDuration(text: string, start: number): Temporal.Instant | Temporal.Duration | Time {
		const fail = (reason: string): never => {
			this.#fail(`Invalid duration ${abbreviate(text)}: ${reason}`, start);
		};

		const isNegative = text.charCodeAt(0) === DASH;
		let index = isNegative ? 1 : 0;
		let previousRank = -1;
		let total = 0n;
		// The fraction of the last part, and that part's unit size. Only the last part may have one, so the value checks wait until every part is read.
		let fraction = '';
		let size = 0n;

		while (index < text.length) {
			const digitsEnd = skipIntegerPart(text, index);
			const next = text.charCodeAt(digitsEnd);

			if (digitsEnd === index) {
				const code = text.charCodeAt(index);

				if (code === DASH && isDigit(text.charCodeAt(index + 1))) {
					fail('only the whole duration takes a sign, as in -1h30m');
				}

				fail(code === 0x2B /* + */ ? 'a “+” sign is not allowed' : `expected a number at “${abbreviate(text.slice(index), 10)}”`);
			}

			if (text.charCodeAt(index) === 0x30 && (next === 0x5F /* _ */ || isDigit(next))) {
				fail('leading zeros are not allowed');
			}

			if (next === 0x5F /* _ */) {
				fail('an underscore must be between two digits');
			}

			fraction = '';
			let unitStart = digitsEnd;

			if (next === DOT) {
				unitStart = skipDigits(text, digitsEnd + 1, isDigit);

				if (unitStart === digitsEnd + 1) {
					fail('a “.” must be followed by a digit');
				}

				if (text.charCodeAt(unitStart) === 0x5F /* _ */) {
					fail('an underscore must be between two digits');
				}

				// Trailing zeros change nothing, and leaving them out keeps the arithmetic small however many there are.
				fraction = trimTrailingZeros(text.slice(digitsEnd + 1, unitStart).replaceAll('_', ''));
			}

			let unitEnd = unitStart;

			while (isLetter(text.charCodeAt(unitEnd))) {
				unitEnd++;
			}

			const unit = text.slice(unitStart, unitEnd);
			const rank = DURATION_UNIT_NAMES.indexOf(unit);

			if (rank === -1) {
				fail(describeBadDurationUnit(unit, text));
			}

			if (rank <= previousRank) {
				fail('the units are in the order h, m, s, ms, us, ns, and each appears at most once');
			}

			if (next === DOT && isDigit(text.charCodeAt(unitEnd))) {
				fail('only the last part may have a fraction');
			}

			size = DURATION_UNITS.get(unit)!;
			const digits = text.slice(index, digitsEnd).replaceAll('_', '');
			// More than 19 digits is out of range in any unit, which is decided before `BigInt` spends time on a huge digit string. `INT64_MAX * 2n` is past the range for either sign, and the range error waits until every part is checked.
			total += digits.length > 19 ? INT64_MAX * 2n : BigInt(digits) * size;
			index = unitEnd;
			previousRank = rank;
		}

		// More than 13 fraction digits without a trailing zero is finer than a nanosecond in any unit, which is decided before `BigInt` spends time on a huge digit string.
		if (fraction.length > 13) {
			fail('it is not a whole number of nanoseconds');
		}

		if (fraction !== '') {
			const scale = 10n ** BigInt(fraction.length);
			const fractionNanoseconds = BigInt(fraction) * size;

			if (fractionNanoseconds % scale !== 0n) {
				fail('it is not a whole number of nanoseconds');
			}

			total += fractionNanoseconds / scale;
		}

		if (isNegative && total === 0n) {
			fail('“-” is not allowed before zero, because zero has one spelling: 0s');
		}

		if (total > (isNegative ? -INT64_MIN : INT64_MAX)) {
			fail('it is outside the 64-bit range of nanoseconds, about 292 years either way');
		}

		return this.#createTime(new Time('Duration', isNegative ? -total : total));
	}

	/*
	Parses one value that fills the source, without the character check that `parseWithTimes()` does and without wrapping the value in `[...]` to make it a document, both of which cost a string and a scan of every scalar, which dominates building the tree. A scalar parses the same on its own as in an array, and its source is a substring of a document that the caller already checked, so the value is the same. The tree lexer measures the scalar exactly, so a value that leaves part of the source is a bug in the caller.
	*/
	parseScalar(): ParsedValue {
		const value = this.#parseValue(1);

		if (this.#index !== this.#source.length) {
			this.#fail('The scalar is not one value', this.#index);
		}

		return value;
	}

	parseDocument(): ParsedObject | ParsedValue[] {
		this.#skipTrivia();
		this.#documentStart = this.#index;

		if (this.#isAtEnd()) {
			this.#fail('A document must contain an object or an array, but this one is empty');
		}

		const code = this.#code();
		let value: ParsedObject | ParsedValue[];

		if (code === OPEN_BRACE) {
			value = this.#parseObject(1);
		} else if (code === OPEN_BRACKET) {
			value = this.#parseArray(1);
		} else {
			value = this.#parseBareObject();
		}

		this.#skipTrivia();

		if (!this.#isAtEnd()) {
			this.#fail(`Unexpected ${this.#describeHere()} after the end of the document`);
		}

		return value;
	}
}

/*
Whether `text` is one valid value, so that an error message only suggests a fix that works.
*/
function isValidValue(text: string): boolean {
	// In an array, because a bare scalar is not a document, and the length check refuses text that holds more than one value, such as `1, 2`. A `Time` is kept as it is, so that this works without `Temporal`.
	try {
		return (new Parser(`[${text}]`, 'bigint', time => time).parseDocument() as ParsedValue[]).length === 1;
	} catch {
		return false;
	}
}

/*
Whether `text` is an int, in any radix, or a float, following the grammar. A run of digits may have single underscores between digits.
*/
function classifyNumber(text: string): 'int' | 'float' | undefined {
	const radix = text.charCodeAt(0) === 0x30 ? RADIX_DIGIT.get(text.charAt(1)) : undefined;

	if (radix !== undefined) {
		const end = skipDigits(text, 2, radix);
		return end > 2 && end === text.length ? 'int' : undefined;
	}

	let index = text.charCodeAt(0) === DASH ? 1 : 0;

	// The integer part is `0` or has no leading zero.
	const integerEnd = skipIntegerPart(text, index);

	if (integerEnd === index) {
		return undefined;
	}

	index = integerEnd;

	let kind: 'int' | 'float' = 'int';

	if (text.charCodeAt(index) === DOT) {
		const end = skipDigits(text, index + 1, isDigit);

		if (end === index + 1) {
			return undefined;
		}

		index = end;
		kind = 'float';
	}

	if (text.charCodeAt(index) === 0x65 /* e */) {
		const isNegative = text.charCodeAt(index + 1) === DASH;
		const exponentStart = index + (isNegative ? 2 : 1);
		// The exponent follows the same leading-zero rule as the integer part, and its zero has one spelling, `e0`, so `e-0` is not an exponent.
		const end = isNegative && text.charCodeAt(exponentStart) === 0x30 ? exponentStart : skipIntegerPart(text, exponentStart);

		if (end === exponentStart) {
			return undefined;
		}

		index = end;
		kind = 'float';
	}

	return index === text.length ? kind : undefined;
}

/*
Returns the index after a run of digits that may have single underscores between them, or `index` when there is no digit there.
*/
function skipDigits(text: string, index: number, isValidDigit: (code: number) => boolean): number {
	if (!isValidDigit(text.charCodeAt(index))) {
		return index;
	}

	index++;

	for (;;) {
		const code = text.charCodeAt(index);

		if (isValidDigit(code)) {
			index++;
		} else if (code === 0x5F /* _ */ && isValidDigit(text.charCodeAt(index + 1))) {
			index += 2;
		} else {
			return index;
		}
	}
}

/*
Returns the index after an integer part, which is `0` or digits without a leading zero, or `index` when there is none. Anything after a leading `0`, such as the `5` in `05`, is left for the caller to reject.
*/
function skipIntegerPart(text: string, index: number): number {
	return text.charCodeAt(index) === 0x30 ? index + 1 : skipDigits(text, index, isDigit);
}

function isDigit(code: number): boolean {
	return code >= 0x30 && code <= 0x39;
}

function isLetter(code: number): boolean {
	return (code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A);
}

/*
Whether a token that is not a number or an instant was meant as a duration: its first letter could begin a unit, or a day or a week, or it is a year unit. A radix prefix, an exponent, and other letters, such as the `T` in `20260919T140000Z` or the `x` in `1.5x`, are left to the number errors.
*/
function isDurationLike(text: string): boolean {
	const start = text.charCodeAt(0) === DASH ? 1 : 0;

	if (!isDigit(text.charCodeAt(start))) {
		return false;
	}

	// A scan rather than a regular expression, because a fraction may have any number of trailing zeros, so the first letter can be millions of characters in.
	let index = start;

	while (isDigit(text.charCodeAt(index)) || text.charCodeAt(index) === 0x5F) {
		index++;
	}

	if (text.charCodeAt(index) === DOT) {
		index++;

		while (isDigit(text.charCodeAt(index)) || text.charCodeAt(index) === 0x5F) {
			index++;
		}
	}

	// A year unit, as in `1y` or `2years`, is only one when the token or another part follows it, so that a word such as `100yen` stays a string to quote. The longest unit and the character after it fit in 6 characters.
	return /^[dhmnsuw]$/iv.test(text.charAt(index)) || /^(?:y|yrs?|years?)(?:$|\d)/iv.test(text.slice(index, index + 6));
}

function describeBadDurationUnit(unit: string, text: string): string {
	if (unit === '') {
		return 'every number needs a unit: h, m, s, ms, us, or ns';
	}

	if (/^d(?:ays?)?$/v.test(unit)) {
		return 'there is no day unit, because a day is not a fixed length. Write 24h for a fixed 24 hours';
	}

	if (/^w(?:eeks?)?$/v.test(unit)) {
		return 'there is no week unit, because a day is not a fixed length. Write 168h for a fixed 168 hours';
	}

	if (/^(?:y|yrs?|years?)$/iv.test(unit)) {
		return 'there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days';
	}

	if (unit === 'M') {
		// A number with `M` alone is more often a size, as in `memory: 512M`, and `512m` would read as minutes.
		const sizeHint = text.length <= MAX_DIAGNOSED_LENGTH && /^\d[\d_]*M$/v.test(text) ? `. A size, such as 512M, is a string: '${abbreviate(text)}'` : '';
		return `there is no month unit, because a month is not a fixed length${sizeHint}`;
	}

	return DURATION_UNITS.has(unit.toLowerCase()) ? `the units are lowercase: ${unit.toLowerCase()}` : `“${abbreviate(unit, 10)}” is not a unit. The units are h, m, s, ms, us, and ns, and a string must be quoted`;
}

/*
The number of spaces and tabs before `offset` on its line, or `undefined` when something else comes before it.
*/
function getIndentation(source: string, offset: number): number | undefined {
	const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
	return skipSpaces(source, lineStart) === offset ? offset - lineStart : undefined;
}

function isWordsWithSpaces(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);

		if (!isSpace(code) && !isBareKeyCharacter(code)) {
			return false;
		}
	}

	return true;
}

function daysInMonth(year: number, month: number): number {
	if (month === 2) {
		const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
		return isLeapYear ? 29 : 28;
	}

	return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isUnquotedTextEnd(source: string, index: number): boolean {
	const code = source.charCodeAt(index);
	const isComment = code === HASH || (code === SLASH && source.charCodeAt(index + 1) === ASTERISK);
	return code === LF || code === COMMA || code === CLOSE_BRACKET || code === CLOSE_BRACE || (isComment && isSpace(source.charCodeAt(index - 1)));
}

/*
The example in a message that a string must be quoted, which quotes `text` as a `'...'` string. That cannot hold a `'`, so then there is no simple example.
*/
function quotingExample(text: string): string {
	return text.includes('\'') ? '' : `, as in '${abbreviate(text)}'`;
}

/*
`text` is the unquoted string that `word` begins, which the suggestion quotes.
*/
function describeUnknownWord(word: string, text: string): string {
	// A keyword hint is only for the word on its own. In `Yes please` or `Nan Goldin`, following it would leave text behind or change the value.
	const lowercase = text === word ? word.toLowerCase() : '';

	if (['true', 'false', 'yes', 'no', 'on', 'off'].includes(lowercase)) {
		return `“${word}” is not a value. Booleans are written true and false, in lowercase`;
	}

	if (['null', 'nil', 'none', 'undefined'].includes(lowercase)) {
		return `“${word}” is not a value. Null is written null, in lowercase`;
	}

	if (lowercase === 'nan') {
		return 'NaN is not representable. Use null for a missing value';
	}

	return ['inf', 'infinity'].includes(lowercase) ? `“${word}” is not a value. Infinity is written infinity, in lowercase` : `Unexpected “${abbreviate(word)}”. A string value must be quoted${quotingExample(text)}`;
}

function describeBadUnicodeEscape(source: string, offset: number): string {
	const rest = source.slice(offset, offset + 12);

	if (/^u[\dA-Fa-f]{4}/v.test(rest)) {
		return describeFourDigitEscape(rest);
	}

	if (/^u\{[\dA-Fa-f]*[A-F]/v.test(rest)) {
		return 'A Unicode escape uses lowercase hexadecimal digits';
	}

	if (rest.startsWith('u{}')) {
		return 'A Unicode escape needs one to six hexadecimal digits';
	}

	return /^u\{[\da-f]{7}/v.test(rest) ? 'A Unicode escape has at most six hexadecimal digits' : String.raw`A Unicode escape is written \u{…} with one to six lowercase hexadecimal digits`;
}

/*
The JSON form `\uXXXX`, from its `u`, with the escape to write instead. JSON writes a character above U+FFFF as two of them, a surrogate pair, which is one `\u{…}` escape here. Here, a lone surrogate and a carriage return have no escape.
*/
function describeFourDigitEscape(rest: string): string {
	const code = Number.parseInt(rest.slice(1, 5), 16);
	const low = /^\\u[\dA-Fa-f]{4}/v.test(rest.slice(5)) ? rest.slice(7, 11) : undefined;
	const lowCode = low === undefined ? NaN : Number.parseInt(low, 16);

	if (code >= 0xD8_00 && code <= 0xDB_FF && lowCode >= 0xDC_00 && lowCode <= 0xDF_FF) {
		const codePoint = 0x1_00_00 + ((code - 0xD8_00) * 0x4_00) + (lowCode - 0xDC_00);
		return `The four-digit \\${rest.slice(0, 5)}\\u${low} form is not an escape. Write \\u{${codePoint.toString(16)}}`;
	}

	const form = `The four-digit \\${rest.slice(0, 5)} form is not an escape`;

	if (code >= 0xD8_00 && code <= 0xDF_FF) {
		return String.raw`${form}, and a lone surrogate is not a Unicode scalar value. Write the character it is half of as one \u{…} escape`;
	}

	return code === 0x0D ? `${form}, and a carriage return (U+000D) cannot be represented` : String.raw`${form}. Write \u{${code.toString(16)}}`;
}

/*
`unquotedText` is the unquoted string that `fullText` begins, for the suggestion to quote it.
*/
function describeBadNumber(fullText: string, unquotedText: string): string {
	const text = fullText.slice(0, MAX_DIAGNOSED_LENGTH);

	if (text.includes('+')) {
		return 'A “+” sign is not allowed in a number, including in an exponent';
	}

	if (/^-?0[BOX]/v.test(text)) {
		return 'A number prefix is lowercase: 0x, 0o, or 0b';
	}

	// The whole number, not the part cut at the diagnosed length, because a cut can end before the digit or the underscore that the message is about. Each check below takes linear time.
	const radixMatch = /^(?<sign>-?)0(?<radix>[box])(?<digits>.*)$/v.exec(fullText);

	if (radixMatch !== null) {
		const {sign, radix, digits} = radixMatch.groups as {sign: string; radix: Radix; digits: string};
		const name = RADIX_NAME[radix];

		if (sign === '-') {
			return `${RADIX_ARTICLE[radix]} ${name} integer cannot have a sign, because it states a bit pattern rather than a quantity`;
		}

		if (digits === '') {
			return `Expected ${name} digits after “0${radix}”`;
		}

		if (radix === 'x' && /[a-f]/v.test(digits) && !/[^\da-f_]/iv.test(digits)) {
			// The uppercase spelling is only suggested when it is valid, so a misplaced underscore is reported first, and a value outside the 64-bit range gets no example.
			if (!/^[\da-f]+(?:_[\da-f]+)*$/iv.test(digits)) {
				return 'An underscore in a number must be between two digits';
			}

			const uppercase = `0x${digits.toUpperCase()}`;
			return isValidValue(uppercase) ? `Hexadecimal digits are uppercase: ${abbreviate(uppercase)}` : 'Hexadecimal digits are uppercase';
		}

		// A lowercase hexadecimal digit is a digit in the wrong case, so the one named is a character that is no digit in either case.
		const validCharacter = {x: /[\da-f_]/iv, o: /[0-7_]/v, b: /[01_]/v}[radix];
		const character = [...digits].find(character => !validCharacter.test(character));

		return character === undefined ? 'An underscore in a number must be between two digits' : `Invalid ${name} digit “${character}”`;
	}

	// Only when the “E” is where an exponent marker goes, with digits, a `-`, or nothing after it. In `5EUR` or `10EB`, it is part of a word, so lowercasing it would not help.
	if (/^-?\d[\d_]*(?:\.[\d_]+)?E-?[\d_]*$/v.test(text)) {
		return 'An exponent marker is a lowercase “e”';
	}

	if (/^-?[\d_]+\.(?:$|[^\d_])/v.test(text)) {
		return 'A decimal point must be followed by a digit';
	}

	if (text.startsWith('-.')) {
		return 'A number cannot begin with “.”; write a digit before it, as in -0.5';
	}

	if (/^\d+(?::\d+)+$/v.test(text)) {
		return /^\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/v.test(text) ? 'A time of day is a string, so it must be quoted' : `Invalid number “${abbreviate(text)}”. A value that contains “:” must be quoted, as in '${abbreviate(text)}'`;
	}

	// A value with a `:` that starts with a zero, such as the MAC address `00:1A:2B`, is not a number with a leading zero, because removing the zero would not make it valid.
	if (/^-?0[\d_]/v.test(text) && !text.includes(':')) {
		// Removing the zero gives a valid number with a different meaning, so the message says what the zero usually meant.
		// A `'...'` string cannot hold a `'`, so then there is no example.
		const identifier = `an identifier, such as a ZIP code, as a string${unquotedText.includes('\'') ? '' : `: '${abbreviate(unquotedText)}'`}`;

		// The octal suggestion is only for the number on its own, not for one that more text follows, as in `0412 345 678`, and only when it is in range. It is decided on the whole number, because a cut can end before a digit that is not octal or that changes the value.
		const digits = fullText.replace(/^0+/v, '');
		const octal = `0o${digits === '' ? '0' : digits}`;

		if (unquotedText === fullText && /^0[0-7]+$/v.test(fullText) && isValidValue(octal)) {
			return `Leading zeros are not allowed in a decimal number. Write an octal number, such as a file mode, as ${abbreviate(octal)}, and ${identifier}`;
		}

		return /^0\d+$/v.test(text) ? `Leading zeros are not allowed in a decimal number. Write ${identifier}` : 'Leading zeros are not allowed in a decimal number';
	}

	// Only in a number: an underscore next to a letter other than the exponent marker is part of a word, such as `4k_video`.
	if (/_(?:$|\D)|(?:^|\D)_/v.test(text) && !/[^\d\-._e]/v.test(text)) {
		return 'An underscore in a number must be between two digits';
	}

	if (/^-?\d[\d_]*(?:\.[\d_]+)?e-?0_?\d/v.test(text)) {
		return 'Leading zeros are not allowed in an exponent';
	}

	if (/^-?\d[\d_]*(?:\.[\d_]+)?e-0$/v.test(text)) {
		return '“e-0” is not allowed, because an exponent of zero has one spelling: e0';
	}

	// Only a number ends with its exponent marker. A word that ends with an “e”, such as `1byte` or `-verbose`, has no exponent.
	if (/^-?\d[\d_]*(?:\.[\d_]+)?e-?$/v.test(text)) {
		return 'Expected digits after the exponent marker “e”';
	}

	if (text.split('.').length > 2) {
		return `Invalid number “${abbreviate(text)}”. A value with several dots, such as a version number, must be quoted`;
	}

	if (/^-(?:\D|$)/v.test(text)) {
		// The whole word, as for one without the “-”, so that a word such as `-nano` or `-info` is not taken for NaN or infinity.
		if (/^-nan$/iv.test(text)) {
			return 'NaN is not representable. Use null for a missing value';
		}

		return /^-inf(?:inity)?$/iv.test(text) ? `“${abbreviate(text)}” is not a value. Negative infinity is written -infinity` : 'Expected a digit or “infinity” after “-”';
	}

	return /[A-Za-z]/v.test(text) ? `Invalid number “${abbreviate(text)}”. A string value must be quoted${quotingExample(unquotedText)}` : `Invalid number “${abbreviate(text)}”`;
}

/*
A date alone, which is not an instant. The instant it could be is only shown when the date exists, so that the example is valid.
*/
function describeDate(date: string): string {
	const [year, month, day] = date.split('-').map(Number) as [number, number, number];
	const isExisting = year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
	return `${date} is a date, not an instant. Write a date as a string, as in '${date}'${isExisting ? `. An instant needs a time and an offset, as in ${date}T00:00:00Z` : ''}`;
}

/*
`time` is the token after a space that follows `text`, or an empty string. `isWholeValue` is whether nothing that may be part of the instant follows `text` and `time`. `offset` is an offset after a space that follows `text`, or `undefined`.
*/
function describeBadInstant(text: string, time: string, isWholeValue: boolean, offset: string | undefined): string {
	if (text.length > MAX_DIAGNOSED_LENGTH) {
		return `Invalid instant “${abbreviate(text)}”. ${INSTANT_FORMAT}`;
	}

	if (/^\d{4}-\d{2}-\d{2}$/v.test(text)) {
		return /^\d{2}:\d{2}/v.test(time) ? describeSpaceSeparatedInstant(text, time, isWholeValue) : describeDate(text);
	}

	if (/^\d{4}-\d{2}-\d{2}t/v.test(text)) {
		return 'The date and time separator in an instant is an uppercase “T”';
	}

	if (text.endsWith('z')) {
		return 'The UTC offset in an instant is an uppercase “Z”';
	}

	if (/[+\-]\d{4}$/v.test(text)) {
		return 'An instant\'s offset is written with a colon, as in +07:00';
	}

	if (!LOCAL_DATE_TIME.test(text)) {
		return `Invalid instant “${abbreviate(text)}”. ${INSTANT_FORMAT}`;
	}

	if (offset !== undefined) {
		// The instant has the offset it was meant in, so it is not a local time to write as a string.
		const reason = 'An instant\'s offset follows its time directly, without a space';
		return isValidValue(`${text}${offset}`) ? `${reason}, as in ${abbreviate(`${text}${offset}`)}` : reason;
	}

	return isWholeValue ? `An instant needs an offset: Z or ±HH:MM. A date and time without an offset is a local time, which is not an instant, so write it as a string, as in '${abbreviate(text)}', or add the offset it was meant in` : 'An instant needs an offset: Z or ±HH:MM';
}

/*
A date and a time with a space between them, where an instant has a "T". Following the example must not turn a local time into UTC silently, so a time without an offset is described as what it is. An instant is only shown when it is valid, so a date that does not exist, a time out of range, or an instant outside the years 0001 to 9999 in UTC gets the general format instead.
*/
function describeSpaceSeparatedInstant(date: string, time: string, isWholeValue: boolean): string {
	const separator = 'The date and time separator in an instant is an uppercase “T”, not a space';
	const instant = `${date}T${time}`;

	if (instant.length > MAX_DIAGNOSED_LENGTH) {
		return `${separator}. ${INSTANT_FORMAT}`;
	}

	if (isValidValue(instant)) {
		return `${separator}, as in ${abbreviate(instant)}`;
	}

	return isWholeValue && LOCAL_DATE_TIME.test(instant) && isValidValue(`${instant}Z`) ? `${separator}, and an instant needs the offset it was meant in, as in ${abbreviate(instant)}Z for UTC. A date and time without an offset is a local time, which is not an instant, so write it as a string, as in '${abbreviate(`${date} ${time}`)}'` : `${separator}. ${INSTANT_FORMAT}`;
}
