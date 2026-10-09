import {
	MAX_DEPTH,
	INT64_MIN,
	INT64_MAX,
	MIN_INSTANT,
	MAX_INSTANT,
	DURATION_UNITS,
	trimTrailingZeros,
	getIntegersOption,
	requireTemporal,
	isBareKey,
	abbreviate,
	describeText,
} from './shared.ts';

const dateTime = Date.prototype.getTime;
const durationField = (name: string) => Object.getOwnPropertyDescriptor(Temporal.Duration.prototype, name)!.get as () => number;
const durationSizes = DURATION_UNITS.values().toArray();

// Undefined without `Temporal`, and then `requireTemporal()` throws before it is used.
const temporal = typeof Temporal === 'undefined'
	? undefined
	: {
		instantNanoseconds: Object.getOwnPropertyDescriptor(Temporal.Instant.prototype, 'epochNanoseconds')!.get as () => bigint,
		durationCalendarFields: ['years', 'months', 'weeks', 'days'].map(name => durationField(name)),
		// In the order of `DURATION_UNITS`.
		durationTimeFields: ['hours', 'minutes', 'seconds', 'milliseconds', 'microseconds', 'nanoseconds'].map(name => durationField(name)),
		durationToString: Temporal.Duration.prototype.toString,
	};

// In `v` mode, a surrogate pair is one astral code point, so the class names those and a lone surrogate.
const SURROGATE = /[\u{D800}-\u{DFFF}\u{10000}-\u{10FFFF}]/v;

// A `\` or a `"` alone does not need the escaped form, because a literal string holds both as they are.
// eslint-disable-next-line no-control-regex, regexp/no-control-character -- Control characters are exactly what must be found.
const NEEDS_ESCAPED_STRING = /[\u{0}-\u{1F}'\u{7F}]/v;

// eslint-disable-next-line no-control-regex, regexp/no-control-character -- As above, plus a lone surrogate, which the `v` flag matches only when it is unpaired.
const NEEDS_ATTENTION = /[\u{0}-\u{1F}'\u{7F}\u{D800}-\u{DFFF}]/v;

// eslint-disable-next-line no-control-regex, regexp/no-control-character -- Control characters are exactly what must be escaped.
const ESCAPED_CHARACTER = /[\u{0}-\u{1F}"\\\u{7F}]/gv;

// A map rather than an object, so that a property added to `Object.prototype` is never written as an escape.
const ESCAPES = new Map([
	['\\', '\\\\'],
	['"', String.raw`\"`],
	['\n', String.raw`\n`],
	['\t', String.raw`\t`],
]);

/**
Options for `stringify()`.
*/
export type StringifyOptions = {
	/**
	How an int is represented in `value`.

	- `'bigint'`: A `bigint` is written as an int, and a `number` is always written as a float, so `8080` becomes `8080.0`.
	- `'number'`: A `number` that is a safe integer is written as an int, and any other `number` as a float. A `bigint` is still written as an int.

	@default 'bigint'
	*/
	readonly integers?: 'bigint' | 'number';

	/**
	Write exact canonical form, with the members of every object sorted by key, for hashing, signing, or comparing.

	By default, members keep the order of `value`, which reads better in a file for people, and every other rule of canonical form is followed. JavaScript puts integer-like keys, such as `404` or `10`, before every other key, in numeric order, so their order in `value` cannot be kept.

	@default false

	@example
	```
	import {stringify} from 'soml-lang';

	stringify({name: 'api', description: 'The edge service'});
	//=> "name: 'api'\ndescription: 'The edge service'\n"

	stringify({name: 'api', description: 'The edge service'}, {canonical: true});
	//=> "description: 'The edge service'\nname: 'api'\n"
	```
	*/
	readonly canonical?: boolean;
};

/**
The options of `stringify()`, checked, with their defaults.

@internal
*/
export type WriterOptions = {
	readonly integers: 'bigint' | 'number';
	readonly canonical: boolean;
};

type Container = unknown[] | Record<string, unknown>;

/**
Serialize an object or an array to SOML. Nesting is written with braces and tabs, and the output ends with one line feed. Comments and block strings are never written.

Members keep the order of `value`, which reads better in a file for people, and every other rule of canonical form is followed. With the `canonical: true` option, members are sorted by key, and the output is canonical form: two equal values produce the same bytes, so it can be hashed, signed, or compared.

JavaScript puts integer-like keys, such as `404` or `10`, before every other key, in numeric order, so their order in `value` cannot be kept.

A `bigint` is written as an int and a `number` as a float, so `{port: 8080}` becomes `port: 8080.0`. Use `8080n`, or the `integers: 'number'` option.

Besides the types that `parse()` returns, a `Date` is accepted and written as an instant, a `Temporal.Duration` is accepted when it has no years, months, weeks, or days, because those are not a fixed length, and a member whose value is `undefined` is left out, as `JSON.stringify` does.

@param value - A plain object or an array.
@param options - How an int is represented in `value`, and whether to sort members.
@returns The document, ending with one line feed.
@throws {TypeError} For a value that cannot be represented: `NaN`, a function, a symbol value, an object that is neither a plain object nor an array (such as a class instance or a `Map`), `undefined` in an array, a circular reference, a non-collection at the top level, an invalid `Date`, a `Temporal.Duration` with years, months, weeks, or days, an object that only claims to be a `Date`, a `Temporal.Instant`, or a `Temporal.Duration`, and a string or key with a lone surrogate or a carriage return. Also when `options` is not an object, its `integers` is not `'bigint'` or `'number'`, or its `canonical` is not a boolean.
@throws {RangeError} For an int outside the 64-bit range, an instant outside the years 0001 to 9999, a duration outside the 64-bit range of nanoseconds, and nesting deeper than 100 levels.

@example
```
import {stringify} from 'soml-lang';

stringify({name: 'api-gateway', replicas: 3n, timeout: 30});
//=> "name: 'api-gateway'\nreplicas: 3\ntimeout: 30.0\n"

stringify({port: 8080}, {integers: 'number'});
//=> 'port: 8080\n'

stringify({name: 'api', description: 'The edge service'}, {canonical: true});
//=> "description: 'The edge service'\nname: 'api'\n"
```
*/
// `object` rather than `Record<string, unknown>`, so that a value typed with an interface is accepted too. The value is checked at runtime.
export function stringify(value: object, options?: StringifyOptions): string { // eslint-disable-line @typescript-eslint/no-restricted-types
	if (!Array.isArray(value) && !isPlainObject(value)) {
		throw new TypeError(`The top-level value must be an object or an array, because a document is a collection. Got ${describeType(value)}`);
	}

	return new Writer(getStringifyOptions(options)).writeDocument(value);
}

/**
Serialize one value as it is written in a document: a scalar on one line, and an object or an array in braces or brackets over several lines, with each level indented by one more tab. There is no line feed at the end.

For showing a value, as in a message, or for writing it into a template. Use `stringify()` to write a whole document, and `edit()` to change a value in one.

It takes the same values and options as `stringify()`, and any of them at the top level, so `1.5` gives `'1.5'` and `'it\'s'` gives `"it's"`. Members keep their order, as in `stringify()`, unless the `canonical: true` option sorts them.

Canonical form gives equal values the same text, so it also tells whether two values are equal. The order of the keys does not matter, and with the default `integers` option, an int and a float are never equal, as in the spec.

@param value - A value of any type that `stringify()` accepts in a document.
@param options - How an int is represented in `value`, and whether to sort members.
@returns The value as it is written in a document.
@throws {TypeError} For a value that cannot be represented, as for `stringify()`, and for `undefined`.
@throws {RangeError} For a value out of range, as for `stringify()`.

@example
```
import {stringifyValue} from 'soml-lang';

stringifyValue(0.1 + 0.2);
//=> '0.30000000000000004'

stringifyValue(8080n);
//=> '8080'

stringifyValue({b: 1n, a: [true]});
//=> '{\n\tb: 1\n\ta: [\n\t\ttrue\n\t]\n}'

stringifyValue({b: 1n, a: [true]}, {canonical: true});
//=> '{\n\ta: [\n\t\ttrue\n\t]\n\tb: 1\n}'

const isEqual = (first, second) => stringifyValue(first, {canonical: true}) === stringifyValue(second, {canonical: true});

isEqual({b: 1n, a: [true]}, {a: [true], b: 1n});
//=> true

isEqual(3n, 3);
//=> false
```
*/
export function stringifyValue(value: unknown, options?: StringifyOptions): string {
	return new Writer(getStringifyOptions(options)).writeValue(value, 1, '');
}

/**
One value as `stringifyValue()` writes it, for `edit()`. A container's own depth is `depth`, and its lines after the first are indented by `indent`, so the value fits where it is written. With `isOneLine`, a container is written on one line instead, as in `[1, {a: 2}]`, for a value inside a container that is on one line.

@internal
*/
export function stringifyValueAt(value: unknown, {depth, indent, isOneLine, ...options}: WriterOptions & {depth: number; indent: string; isOneLine: boolean}): string {
	return new Writer(options, isOneLine).writeValue(value, depth, indent);
}

/**
The options of `stringify()`, `stringifyValue()`, and `edit()`, checked, with the defaults for those that are left out.

@internal
*/
export function getStringifyOptions(options: unknown): WriterOptions {
	const integers = getIntegersOption(options);
	// An own property only, so that a `canonical` on the prototype, such as on `Object.prototype`, is not read as the option. `undefined` is the same as a missing option.
	const canonical = Object.hasOwn(options ?? {}, 'canonical') ? (options as {canonical?: unknown}).canonical : undefined;

	if (canonical !== undefined && typeof canonical !== 'boolean') {
		throw new TypeError(`The \`canonical\` option must be a boolean, got ${canonical === null ? 'null' : typeof canonical}`);
	}

	return {integers, canonical: canonical ?? false};
}

/*
Appends to one array of parts that is joined once at the end, so the time is linear in the output whatever the nesting. A scalar and its line are one part.
*/
class Writer {
	readonly #integers: 'bigint' | 'number';
	readonly #isCanonical: boolean;
	readonly #isOneLine: boolean;
	readonly #ancestors = new Set<Container>();
	readonly #parts: string[] = [];

	constructor({integers, canonical}: WriterOptions, isOneLine = false) {
		this.#integers = integers;
		this.#isCanonical = canonical;
		this.#isOneLine = isOneLine;
	}

	/*
	What comes before the item at `index` in a container whose items are indented by `indent`: a comma and a space after the first item on one line, and otherwise the indentation of a new line.
	*/
	#itemPrefix(index: number, indent: string): string {
		if (this.#isOneLine) {
			return index === 0 ? '' : ', ';
		}

		return indent;
	}

	/*
	Writes `prefix`, the value, and `suffix`. A container's own depth is `depth`, and its lines are indented by `indent`.
	*/
	#writeItem(prefix: string, value: unknown, depth: number, indent: string, suffix: string, key?: string): void {
		const scalar = this.#formatScalar(value, key);

		if (scalar === undefined) {
			this.#parts.push(prefix);
			this.#writeContainer(value as Container, depth, indent);
			this.#parts.push(suffix);
		} else {
			this.#parts.push(`${prefix}${scalar}${suffix}`);
		}
	}

	/*
	Formats a scalar, or returns `undefined` for an array or a plain object.
	*/
	#formatScalar(value: unknown, key: string | undefined): string | undefined {
		switch (typeof value) {
			case 'string': {
				return formatStringKind(value, 'string');
			}

			case 'bigint': {
				return formatInteger(value);
			}

			case 'number': {
				return this.#integers === 'number' && Number.isSafeInteger(value) ? formatInteger(BigInt(value)) : formatFloat(value);
			}

			case 'boolean': {
				return value ? 'true' : 'false';
			}

			case 'object': {
				break;
			}

			default: {
				throw new TypeError(`Cannot serialize ${describeType(value)}${key === undefined ? '' : ` at key “${describeText(abbreviate(key))}”`}`);
			}
		}

		if (value === null) {
			return 'null';
		}

		if (Array.isArray(value) || isPlainObject(value)) {
			return undefined;
		}

		// A brand check rather than `instanceof`, so that an instant or a date from another realm, such as a `vm` context, is accepted too. The tag is only a cheap filter, since `Symbol.toStringTag` can fake it. The getters read internal slots, so they throw for anything else.
		const brand = Object.prototype.toString.call(value);

		if (brand === '[object Temporal.Instant]') {
			requireTemporal();
			return formatInstant(readBranded(temporal!.instantNanoseconds, value, 'Temporal.Instant'));
		}

		if (brand === '[object Temporal.Duration]') {
			return formatDuration(value);
		}

		if (brand === '[object Date]') {
			const milliseconds = readBranded(dateTime, value, 'Date');

			if (Number.isNaN(milliseconds)) {
				throw new TypeError('Cannot serialize an invalid Date');
			}

			return formatInstant(BigInt(milliseconds) * 1_000_000n);
		}

		throw new TypeError(`Cannot serialize ${describeType(value)}. Only plain objects, arrays, and the scalar types can be serialized`);
	}

	#enter(value: Container, depth: number): void {
		if (depth > MAX_DEPTH) {
			throw new RangeError(`Cannot serialize a value nested more than ${MAX_DEPTH} levels deep`);
		}

		if (this.#ancestors.has(value)) {
			throw new TypeError('Cannot serialize a circular structure');
		}

		this.#ancestors.add(value);
	}

	#writeContainer(value: Container, depth: number, indent: string): void {
		this.#enter(value, depth);
		const parts = this.#parts;
		const innerIndent = `${indent}\t`;
		const lineEnd = this.#isOneLine ? '' : '\n';
		const closingIndent = this.#isOneLine ? '' : indent;

		if (Array.isArray(value)) {
			// The length is read once, as `JSON.stringify()` does, so a getter that adds items cannot make it go on forever.
			const {length} = value;

			if (length === 0) {
				parts.push('[]');
			} else {
				parts.push(`[${lineEnd}`);

				for (let index = 0; index < length; index++) {
					const item: unknown = value[index];

					// A hole reads as `undefined`, and both would otherwise have to be guessed into something.
					if (item === undefined) {
						throw new TypeError(`Cannot serialize undefined in an array, at index ${index}`);
					}

					this.#writeItem(this.#itemPrefix(index, innerIndent), item, depth + 1, innerIndent, lineEnd);
				}

				parts.push(`${closingIndent}]`);
			}
		} else {
			const members = readMembers(value, this.#isCanonical);

			if (members.length === 0) {
				parts.push('{}');
			} else {
				parts.push(`{${lineEnd}`);
				this.#writeMembers(members, depth + 1, innerIndent);
				parts.push(`${closingIndent}}`);
			}
		}

		this.#ancestors.delete(value);
	}

	#writeMembers(members: Array<[string, unknown]>, depth: number, indent: string): void {
		const lineEnd = this.#isOneLine ? '' : '\n';

		for (const [index, [key, member]] of members.entries()) {
			this.#writeItem(`${this.#itemPrefix(index, indent)}${formatKey(key)}: `, member, depth, indent, lineEnd, key);
		}
	}

	writeValue(value: unknown, depth: number, indent: string): string {
		this.#writeItem('', value, depth, indent, '');
		return this.#parts.join('');
	}

	writeDocument(value: Container): string {
		if (Array.isArray(value)) {
			this.#writeContainer(value, 1, '');
			this.#parts.push('\n');
			return this.#parts.join('');
		}

		const members = readMembers(value, this.#isCanonical);

		// A brace-less object needs at least one entry, so the empty object keeps its braces, like an array. It is written from the members already read, because reading them again would call each getter twice, and one that returns a value the second time would give a braced object that is not canonical.
		if (members.length === 0) {
			this.#parts.push('{}\n');
		} else {
			this.#enter(value, 1);
			this.#writeMembers(members, 2, '');
		}

		return this.#parts.join('');
	}
}

/*
The members to write, with each value read once, sorted by key when `isCanonical` is true and otherwise in the object's own order. A member whose value is `undefined` is left out, as `JSON.stringify` does.
*/
function readMembers(object: Record<string, unknown>, isCanonical: boolean): Array<[string, unknown]> {
	// Symbol keys and non-enumerable properties are left out, as `JSON.stringify()` does.
	const keys = Object.keys(object);

	if (isCanonical) {
		// The default sort compares UTF-16 code units, which matches code point order unless a surrogate pair meets a character from U+E000 to U+FFFF. A lone surrogate is refused later.
		if (keys.some(key => SURROGATE.test(key))) {
			keys.sort(compareKeys);
		} else {
			keys.sort(); // The native string order is the point, and it is much faster than a comparator.
		}
	}

	const members: Array<[string, unknown]> = [];

	for (const key of keys) {
		const value = object[key];

		if (value !== undefined) {
			members.push([key, value]);
		}
	}

	return members;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const prototype: unknown = Object.getPrototypeOf(value);
	// The last check also accepts a plain object from another realm, such as a `vm` context, whose `Object.prototype` is not this one.
	return prototype === null || prototype === Object.prototype || Object.getPrototypeOf(prototype) === null;
}

function describeType(value: unknown): string {
	if (value === null) {
		return 'null';
	}

	if (typeof value === 'function') {
		return 'a function';
	}

	if (typeof value === 'object') {
		const name = (value as {constructor?: {name?: string}}).constructor?.name;
		return Array.isArray(value) ? 'an array' : (name === undefined || name === '' ? 'an object' : `an instance of ${describeText(name)}`);
	}

	return value === undefined ? 'undefined' : `a ${typeof value}`;
}

/**
Compare two keys in canonical order, which is by their Unicode scalar values, as `stringify()` sorts members with the `canonical: true` option. For a sort, such as in a lint rule that keeps the members of an object in canonical order.

The default `Array#sort()` compares UTF-16 code units, which puts U+E000 to U+FFFF after every character above U+FFFF, so it differs from canonical order for keys that hold such characters.

@param left - A key.
@param right - Another key.
@returns A negative number when `left` comes first, a positive number when `right` comes first, and `0` when they are equal.

@example
```
import {compareKeys} from 'soml-lang';

['b', 'a', '😀', 'ﬀ'].toSorted(compareKeys);
//=> ['a', 'b', 'ﬀ', '😀']
```
*/
export function compareKeys(left: string, right: string): number {
	// The code units are compared with the surrogates moved above U+E000 to U+FFFF, which gives code point order.
	const length = Math.min(left.length, right.length);

	for (let index = 0; index < length; index++) {
		let leftCode = left.charCodeAt(index);
		let rightCode = right.charCodeAt(index);

		if (leftCode !== rightCode) {
			// Every code unit from U+D800 up stays at U+D800 or above when moved, so when only one of them is that high, the difference already has the right sign.
			if (leftCode >= 0xD8_00 && rightCode >= 0xD8_00) {
				leftCode = toCodePointOrder(leftCode);
				rightCode = toCodePointOrder(rightCode);
			}

			return leftCode - rightCode;
		}
	}

	return left.length - right.length;
}

/*
Moves U+E000 to U+FFFF down by 0x800 and the surrogates up by 0x2000, so the surrogates sort last.
*/
function toCodePointOrder(code: number): number {
	if (code >= 0xE0_00) {
		return code - 0x8_00;
	}

	return code >= 0xD8_00 ? code + 0x20_00 : code;
}

/**
A key as it must be written in a document: bare when it can be, and otherwise as a `'...'` or `"..."` string. The same choice `stringify()` makes.

@param key - The decoded key.
@returns The key as it is written in a document.

@example
```
import {formatKey} from 'soml-lang';

formatKey('name');
//=> 'name'

formatKey('content type');
//=> "'content type'"
```
*/
export function formatKey(key: string): string {
	return isBareKey(key) ? key : formatStringKind(key, 'key');
}

/**
A string as it must be written in a document: a `'...'` literal string when it needs no escapes, and otherwise a `"..."` escaped string. The same choice `stringifyValue()` makes. A block string is never written.

@param string - The decoded string.
@returns The string as it is written in a document.
@throws {TypeError} For a string with a lone surrogate or a carriage return, as for `stringify()`.

@example
```
import {formatString} from 'soml-lang';

formatString('api-gateway');
//=> "'api-gateway'"

formatString("it's");
//=> '"it\'s"'
```
*/
export function formatString(string: string): string {
	return formatStringKind(string, 'string');
}

/**
Write a string as a block string without a trailing line feed. Literal blocks use a delimiter longer than any leading quote run in the content. Values whose blank lines or control characters cannot be preserved literally use an escaped block with one encoded content line.

The output is unindented. To nest it, prefix every line after the opening delimiter with the same spaces or tabs, including the closing delimiter. Block strings cannot be used as keys.

@param string - The decoded string value.
@throws {TypeError} For a carriage return or lone surrogate, which SOML cannot represent.

@example
```
import {formatBlockString} from 'soml-lang';

formatBlockString('hello\nworld');
//=> "'''\nhello\nworld\n'''"
```
*/
export function formatBlockString(string: string): string {
	const singleLine = formatString(string);
	const lines = string.split('\n');
	// eslint-disable-next-line no-control-regex, regexp/no-control-character -- Literal blocks cannot hold these control characters.
	const canUseLiteral = !/[\u{0}-\u{8}\u{B}-\u{1F}\u{7F}]/v.test(string)
		&& (string === '' || lines.every((line, index) => !/^[\t ]*$/v.test(line) || (line === '' && index > 0 && index < lines.length - 1)));
	if (!canUseLiteral) {
		// A spaces-only string needs an escape too, otherwise block dedenting discards it.
		const content = singleLine.startsWith('"') ? singleLine.slice(1, -1) : singleLine.slice(1, -1).replaceAll(' ', String.raw`\u{20}`);
		return `"""\n${content}\n"""`;
	}

	let delimiterLength = 3;
	for (const line of lines) {
		const quotes = /^[\t ]*(?<quotes>'+)/v.exec(line)?.groups?.['quotes'];
		if (quotes !== undefined) {
			delimiterLength = Math.max(delimiterLength, quotes.length + 1);
		}
	}

	const delimiter = '\''.repeat(delimiterLength);
	return `${delimiter}\n${string}\n${delimiter}`;
}

/*
A string as it is written, with the kind only for the error message of a lone surrogate or a carriage return, which `formatKey()` reports as “key” and `formatString()` as “string”.
*/
function formatStringKind(string: string, kind: 'string' | 'key'): string {
	// One scan settles the common case: no quote, no control character, and no lone surrogate.
	if (!NEEDS_ATTENTION.test(string)) {
		return `'${string}'`;
	}

	if (!string.isWellFormed()) {
		throw new TypeError(`Cannot serialize a ${kind} containing a lone surrogate, which is not a Unicode scalar value`);
	}

	if (string.includes('\r')) {
		throw new TypeError(`Cannot serialize a ${kind} containing a carriage return (U+000D), which is not representable`);
	}

	return NEEDS_ESCAPED_STRING.test(string) ? `"${string.replaceAll(ESCAPED_CHARACTER, character => ESCAPES.get(character) ?? String.raw`\u{${character.codePointAt(0)!.toString(16)}}`)}"` : `'${string}'`;
}

function formatInteger(value: bigint): string {
	if (value < INT64_MIN || value > INT64_MAX) {
		throw new RangeError(`Cannot serialize the integer ${value}, because it is outside the 64-bit range`);
	}

	return String(value);
}

/**
A number as it must be written in a document: the shortest decimal that reads back as the same binary64 value, laid out as ECMAScript `Number::toString` does, which is also RFC 8785's choice, with `infinity` and `-infinity`. A fractional part is added when there is neither one nor an exponent, so that a float never reads back as an int. The same writer `stringifyValue()` uses.

@param value - The float to write.
@returns The float as it is written in a document.
@throws {TypeError} For `NaN`, which is not representable.

@example
```
import {formatFloat} from 'soml-lang';

formatFloat(30);
//=> '30.0'

formatFloat(0.1 + 0.2);
//=> '0.30000000000000004'

formatFloat(Infinity);
//=> 'infinity'
```
*/
export function formatFloat(value: number): string {
	if (Number.isNaN(value)) {
		throw new TypeError('Cannot serialize NaN, which is not representable. Use null for a missing value');
	}

	if (value === Infinity) {
		return 'infinity';
	}

	if (value === -Infinity) {
		return '-infinity';
	}

	// Covers -0 too, since zero has one value whatever its sign.
	if (value === 0) {
		return '0.0';
	}

	const text = String(value);

	if (text.includes('e')) {
		// `Number::toString` writes a positive exponent as `1e+21`, and a `+` is an error anywhere in a SOML number.
		return text.replace('e+', 'e');
	}

	return text.includes('.') ? text : `${text}.0`;
}

function readBranded<Type>(getter: () => Type, value: unknown, name: string): Type {
	try {
		return getter.call(value);
	} catch {
		throw new TypeError(`Cannot serialize an object that claims to be a ${name} but is not one`);
	}
}

/*
The total is computed from the fields as BigInts, because `Temporal.Duration#total()` returns a float, which cannot hold every int64 count of nanoseconds.
*/
function formatDuration(duration: unknown): string {
	requireTemporal();
	const {durationCalendarFields, durationTimeFields, durationToString} = temporal!;

	if (durationCalendarFields.some(getter => readBranded(getter, duration, 'Temporal.Duration') !== 0)) {
		throw new TypeError(`Cannot serialize the duration ${durationToString.call(duration)}, because years, months, weeks, and days are not a fixed length. Use hours or smaller units`);
	}

	let nanoseconds = 0n;

	// The brand is already checked by the first `readBranded()` above, so these getters cannot throw.
	for (const [index, getter] of durationTimeFields.entries()) {
		nanoseconds += BigInt(getter.call(duration)) * durationSizes[index]!;
	}

	if (nanoseconds < INT64_MIN || nanoseconds > INT64_MAX) {
		throw new RangeError(`Cannot serialize the duration ${durationToString.call(duration)}, because it is outside the 64-bit range of nanoseconds`);
	}

	if (nanoseconds === 0n) {
		return '0s';
	}

	const magnitude = nanoseconds < 0n ? -nanoseconds : nanoseconds;
	const hours = magnitude / 3_600_000_000_000n;
	const minutes = (magnitude / 60_000_000_000n) % 60n;
	const seconds = (magnitude / 1_000_000_000n) % 60n;
	const fraction = magnitude % 1_000_000_000n;
	let text = nanoseconds < 0n ? '-' : '';

	if (hours > 0n) {
		text += `${hours}h`;
	}

	if (minutes > 0n) {
		text += `${minutes}m`;
	}

	if (seconds > 0n || fraction > 0n) {
		text += `${seconds}${formatFraction(fraction)}s`;
	}

	return text;
}

/*
`Date#toISOString()` writes the date and the time of day exactly for every instant that a `Date` or a `Temporal.Instant` can hold, so a `Date` needs no `Temporal`. Only the fraction comes from the nanoseconds.
*/
function formatInstant(nanoseconds: bigint): string {
	// The fraction is never negative, so an instant before 1970 is a whole second plus a fraction, as it is written.
	const fraction = ((nanoseconds % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n;
	const milliseconds = Number((nanoseconds - fraction) / 1_000_000n);
	const text = `${new Date(milliseconds).toISOString().slice(0, -'.000Z'.length)}${formatFraction(fraction)}Z`;

	if (nanoseconds < MIN_INSTANT || nanoseconds > MAX_INSTANT) {
		throw new RangeError(`Cannot serialize the instant ${text}, because it is outside the years 0001 to 9999`);
	}

	return text;
}

/*
The fraction of a second, from its nanoseconds, as canonical form writes it for an instant and a duration: nothing when it is zero, and otherwise a `.` and nine digits with the trailing zeros removed.
*/
function formatFraction(nanoseconds: bigint): string {
	return nanoseconds === 0n ? '' : `.${trimTrailingZeros(String(nanoseconds).padStart(9, '0'))}`;
}
