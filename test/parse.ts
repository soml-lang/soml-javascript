import {test, suite} from 'node:test';
import {Buffer} from 'node:buffer';
import {spawnSync} from 'node:child_process';
import process from 'node:process';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
	parse,
	format,
	edit,
	stringify,
	ParseError,
	type ParseOptions,
	type Value,
} from '../source/index.ts';
import {durationNanoseconds} from './helpers.ts';

type Member<Type = unknown> = {a: Type};

const sourceUrl = pathToFileURL(path.join(import.meta.dirname, '../source/index.ts')).href;

suite('input', () => {
	test('accepts a string', () => {
		assert.deepEqual(parse('a: 1'), {a: 1n});
	});

	test('accepts a Uint8Array of UTF-8', () => {
		assert.deepEqual(parse(new TextEncoder().encode('a: \'é😀\'')), {a: 'é😀'});
	});

	test('accepts a Buffer, which is a Uint8Array', () => {
		assert.deepEqual(parse(Buffer.from('a: 1')), {a: 1n});
	});

	test('accepts a Uint8Array view into a larger buffer', () => {
		const bytes = new TextEncoder().encode('xxa: 1xx');
		assert.deepEqual(parse(bytes.subarray(2, 6)), {a: 1n});
	});

	test('accepts an empty Uint8Array as an empty, invalid document', () => {
		assert.throws(() => parse(new Uint8Array()), {name: 'ParseError', reason: /empty/v});
	});

	test('rejects other input types with a TypeError', () => {
		for (const input of [undefined, null, 1, true, {}, [], new ArrayBuffer(1), new Uint16Array(1), Symbol('x')]) {
			// @ts-expect-error -- Invalid input types.
			assert.throws(() => parse(input), TypeError);
		}
	});

	test('the TypeError names what it got', () => {
		// @ts-expect-error -- Invalid input type.
		assert.throws(() => parse(1), {message: 'Expected a string or a Uint8Array, got number'});
		// @ts-expect-error -- Invalid input type.
		assert.throws(() => parse(null), {message: 'Expected a string or a Uint8Array, got null'});
		// @ts-expect-error -- Invalid input type.
		assert.throws(() => parse({}), {message: 'Expected a string or a Uint8Array, got an object'});
	});

	test('a byte order mark in bytes is rejected rather than stripped', () => {
		assert.throws(() => parse(new Uint8Array([0xEF, 0xBB, 0xBF, 0x61, 0x3A, 0x20, 0x31])), {reason: /byte order mark/v});
	});

	test('invalid UTF-8 is reported with the line and column of the bad byte', () => {
		const bytes = new Uint8Array([...new TextEncoder().encode('a: 1\nb: \'é'), 0xFF, 0x27]);
		assert.throws(() => parse(bytes), {reason: 'Invalid UTF-8 byte 0xFF', line: 2, column: 6});
	});

	test('invalid UTF-8 after a byte order mark counts the mark as a column', () => {
		assert.throws(() => parse(new Uint8Array([0xEF, 0xBB, 0xBF, 0x61, 0xFF])), {reason: 'Invalid UTF-8 byte 0xFF', line: 1, column: 3});
	});

	test('invalid UTF-8 at the very start', () => {
		assert.throws(() => parse(new Uint8Array([0x80])), {reason: 'Invalid UTF-8 byte 0x80', line: 1, column: 1});
	});

	test('a lone surrogate in a string input is rejected', () => {
		assert.throws(() => parse('a: \'\u{D800}\''), {reason: /lone surrogate \(U\+D800\)/v, column: 5});
		assert.throws(() => parse('a: \'\u{DC00}\''), {reason: /lone surrogate \(U\+DC00\)/v});
		assert.throws(() => parse('a: \'x\u{D83D}\''), {reason: /lone surrogate/v, column: 6});
		assert.throws(() => parse('# \u{D800}\na: 1'), {reason: /lone surrogate/v});
	});

	test('a surrogate pair is accepted', () => {
		assert.deepEqual(parse('a: \'\u{1F600}\''), {a: '😀'});
	});
});

suite('options', () => {
	test('`integers` defaults to bigint', () => {
		assert.deepEqual(parse('a: 1\nb: 1.0'), {a: 1n, b: 1});
	});

	test('`integers: \'bigint\'` is explicit', () => {
		assert.deepEqual(parse('a: 1', {integers: 'bigint'}), {a: 1n});
	});

	test('`integers: \'number\'` returns numbers', () => {
		assert.deepEqual(parse('a: 1\nb: -1\nc: [0xFF, 0o7, 0b1]\nd: 1.5', {integers: 'number'}), {
			a: 1, b: -1, c: [255, 7, 1], d: 1.5,
		});
	});

	test('`integers: \'number\'` accepts the safe integer bounds', () => {
		assert.deepEqual(parse('a: 9007199254740991\nb: -9007199254740991', {integers: 'number'}), {a: Number.MAX_SAFE_INTEGER, b: Number.MIN_SAFE_INTEGER});
	});

	test('`integers: \'number\'` throws for an int it cannot hold exactly', () => {
		for (const value of ['9007199254740992', '-9007199254740992', '9223372036854775807', '0x7FFFFFFFFFFFFFFF']) {
			assert.throws(() => parse(`a: ${value}`, {integers: 'number'}), {name: 'ParseError', reason: /cannot be represented exactly as a JavaScript number/v});
		}
	});

	test('`integers: \'number\'` still rejects an int outside int64 with the int64 error', () => {
		assert.throws(() => parse('a: 9223372036854775808', {integers: 'number'}), {reason: /64-bit range/v});
	});

	test('`integers: \'number\'` does not change floats', () => {
		assert.deepEqual(parse('a: 9007199254740993.0', {integers: 'number'}), {a: 9_007_199_254_740_992});
	});

	test('an unknown `integers` value throws a TypeError', () => {
		// @ts-expect-error -- Invalid `integers` value.
		assert.throws(() => parse('a: 1', {integers: 'string'}), {name: 'TypeError', message: /must be 'bigint' or 'number', got 'string'/v});
		// @ts-expect-error -- Invalid `integers` value.
		assert.throws(() => parse('a: 1', {integers: null}), TypeError);
		// @ts-expect-error -- Invalid `integers` value.
		assert.throws(() => parse('a: 1', {integers: true}), TypeError);
		// An `integers` value that a terminal acts on is escaped, not written raw.
		// @ts-expect-error -- Invalid `integers` value.
		assert.throws(() => parse('a: 1', {integers: 'x\u{9B}31m'}), {name: 'TypeError', message: /\\u\{9b\}/v});
	});

	test('options that are not an object throw a TypeError', () => {
		// @ts-expect-error -- Invalid options.
		assert.throws(() => parse('a: 1', null), {name: 'TypeError', message: 'The options must be an object, got null'});
		// @ts-expect-error -- Invalid options.
		assert.throws(() => stringify({}, 'number'), {name: 'TypeError', message: 'The options must be an object, got string'});
		// @ts-expect-error -- Invalid options.
		assert.throws(() => edit('a: 1', ['a'], 2n, null), {name: 'TypeError', message: 'The options must be an object, got null'});
	});

	test('`integers: undefined` uses the default', () => {
		assert.deepEqual(parse('a: 1', {integers: undefined}), {a: 1n});
	});

	test('the option is checked before the input', () => {
		// @ts-expect-error -- Invalid input and `integers` value.
		assert.throws(() => parse(1, {integers: 'x'}), {message: /integers/v});
	});
});

suite('type mapping', () => {
	test('every type', () => {
		const value = parse(`
string: 'x'
int: 1
float: 1.0
true: true
false: false
null: null
instant: 2026-09-19T14:00:00Z
array: []
object: {}
`) as Record<'string' | 'int' | 'float' | 'true' | 'false' | 'null' | 'instant' | 'array' | 'object', unknown>;

		assert.equal(typeof value.string, 'string');
		assert.equal(typeof value.int, 'bigint');
		assert.equal(typeof value.float, 'number');
		assert.equal(value.true, true);
		assert.equal(value.false, false);
		assert.equal(value.null, null);
		assert.ok(value.instant instanceof Temporal.Instant);
		assert.ok(Array.isArray(value.array));
		assert.equal(Object.getPrototypeOf(value.object), Object.prototype);
	});

	test('objects are plain objects with Object.prototype', () => {
		const value = parse('a: {b: [{c: 1}]}') as {a: {b: unknown[]}};
		assert.equal(Object.getPrototypeOf(value), Object.prototype);
		assert.equal(Object.getPrototypeOf(value.a), Object.prototype);
		assert.equal(Object.getPrototypeOf(value.a.b[0]), Object.prototype);
	});

	test('the top-level array is a plain array', () => {
		assert.equal(Object.getPrototypeOf(parse('[1]')), Array.prototype);
	});

	test('negative zero becomes zero', () => {
		assert.ok(Object.is((parse('a: -0.0') as Member).a, 0));
		assert.ok(Object.is((parse('a: -0e5') as Member).a, 0));
	});

	test('infinity', () => {
		assert.deepEqual(parse('a: infinity\nb: -infinity'), {a: Infinity, b: -Infinity});
	});

	test('instants keep nanoseconds', () => {
		assert.equal((parse('a: 2026-09-19T14:00:00.123456789Z') as Member<Temporal.Instant>).a.epochNanoseconds, 1_789_826_400_123_456_789n);
	});

	test('instants are normalized to the same instant regardless of offset', () => {
		const {a, b} = parse('a: 2026-09-19T14:00:00Z\nb: 2026-09-19T16:00:00+02:00') as Record<'a' | 'b', Temporal.Instant>;
		assert.ok(a.equals(b));
	});

	test('an int is exact across the whole int64 range', () => {
		assert.equal((parse('a: 9223372036854775807') as Member).a, 9_223_372_036_854_775_807n);
		assert.equal((parse('a: -9223372036854775808') as Member).a, -9_223_372_036_854_775_808n);
		assert.equal((parse('a: 9007199254740993') as Member).a, 9_007_199_254_740_993n);
	});
});

suite('documents', () => {
	test('a brace-less object', () => {
		assert.deepEqual(parse('name: \'x\'\nversion: \'1.0.0\''), {name: 'x', version: '1.0.0'});
	});

	test('a braced object is the same value', () => {
		assert.deepEqual(parse('{name: \'x\', version: \'1.0.0\'}'), parse('name: \'x\'\nversion: \'1.0.0\''));
	});

	test('an array', () => {
		assert.deepEqual(parse('[1, \'two\', true, null]'), [1n, 'two', true, null]);
	});

	test('the form is decided by the first character after comments', () => {
		assert.deepEqual(parse('# x\n/* y */ [1]'), [1n]);
		assert.deepEqual(parse('# x\n/* y */ {a: 1}'), {a: 1n});
	});

	test('order of members does not change the value', () => {
		assert.deepEqual(parse('{a: 1, b: 2}'), parse('{b: 2, a: 1}'));
	});
});

suite('keys', () => {
	test('a quoted key with a dot is one key', () => {
		assert.deepEqual(parse('\'a.b\': 1\n"example.com": 2\n\'3.14\': 3'), {'a.b': 1n, 'example.com': 2n, 3.14: 3n});
		assert.deepEqual(parse('{\'a.b\': {\'a.b\': 1}}'), {'a.b': {'a.b': 1n}});
	});

	test('a quoted key may hold a line feed written as an escape', () => {
		assert.deepEqual(parse(String.raw`"a\nb": 1`), {'a\nb': 1n});
		assert.deepEqual(parse(String.raw`{"\n": 1}`), {'\n': 1n});
	});
});

suite('duplicate keys', () => {
	test('are decided on the decoded key', () => {
		for (const second of ['a', '\'a\'', '"a"', String.raw`"\u{61}"`]) {
			assert.throws(() => parse(`a: 1\n${second}: 2`), {reason: 'Duplicate key a', line: 2, column: 1});
		}
	});

	test('do not normalize Unicode', () => {
		assert.deepEqual(Object.keys(parse('"\\u{e9}": 1\n"e\\u{301}": 2')), ['\u{E9}', 'e\u{301}']);
	});

	test('are case-sensitive', () => {
		// eslint-disable-next-line @typescript-eslint/naming-convention -- The test needs a key that differs only in case.
		assert.deepEqual(parse('a: 1\nA: 2'), {a: 1n, A: 2n});
	});
});

suite('prototype safety', () => {
	test('`__proto__` is an own property and does not change the prototype', () => {
		const value = parse('__proto__: {polluted: true}') as {polluted?: unknown};
		assert.equal(Object.getPrototypeOf(value), Object.prototype);
		assert.ok(Object.hasOwn(value, '__proto__'));
		assert.deepEqual(Object.keys(value), ['__proto__']);
		assert.equal(value.polluted, undefined);
		assert.ok(!Object.hasOwn(Object.prototype, 'polluted'));
	});

	test('`__proto__` in braces, in arrays, and quoted', () => {
		for (const source of ['{__proto__: {polluted: true}}', '[{__proto__: {polluted: true}}]', '\'__proto__\': {polluted: true}', '"__proto__": {polluted: true}']) {
			const value = parse(source);
			const object = (Array.isArray(value) ? value[0] : value) as {polluted?: unknown};
			assert.equal(Object.getPrototypeOf(object), Object.prototype);
			assert.equal(object.polluted, undefined);
		}

		assert.ok(!Object.hasOwn(Object.prototype, 'polluted'));
	});

	test('`__proto__` duplicates are detected', () => {
		assert.throws(() => parse('__proto__: 1\n__proto__: 2'), {reason: 'Duplicate key __proto__'});
	});

	test('keys that shadow Object.prototype members are plain members', () => {
		const value = parse('constructor: 1\nhasOwnProperty: 2\ntoString: 3\nvalueOf: 4\nisPrototypeOf: 5');
		assert.equal(value.constructor, 1n);
		assert.equal(value.toString, 3n);
		assert.equal(Object.getPrototypeOf(value), Object.prototype);
		assert.deepEqual(parse('constructor: {prototype: {polluted: true}}'), {constructor: {prototype: {polluted: true}}});
		assert.ok(!Object.hasOwn(Object.prototype, 'polluted'));
	});

	test('a key named like a prototype member is not mistaken for an existing key', () => {
		assert.deepEqual(parse('toString: {a: 1, b: 2}'), {toString: {a: 1n, b: 2n}});
		assert.deepEqual(parse('hasOwnProperty: 1'), {hasOwnProperty: 1n});
	});

	test('an option inherited from the options object\'s prototype is not read', () => {
		// A property on the options object's own prototype is not an option, as a property on `Object.prototype` is not either, so it changes nothing. `options` is otherwise an empty object.
		const makeOptions = (prototype: Record<string, unknown>): ParseOptions => Object.create(prototype) as ParseOptions;
		assert.deepEqual(parse('a: 8080', makeOptions({integers: 'number'})), {a: 8080n});
		assert.deepEqual(parse('a: 1', makeOptions({integers: 'invalid'})), {a: 1n});
	});
});

suite('strings', () => {
	test('literal strings are literal', () => {
		assert.equal((parse(String.raw`a: 'C:\Users\n\t\u{41}'`) as Member).a, String.raw`C:\Users\n\t\u{41}`);
	});

	test('escaped strings decode every escape', () => {
		assert.equal((parse(String.raw`a: "\\\"\n\t\u{0}\u{41}\u{1f600}"`) as Member).a, '\\"\n\t\u{0}A😀');
	});

	test('a long escaped string with many escapes', () => {
		const expected = 'x\n'.repeat(10_000);
		assert.equal((parse(`a: "${String.raw`x\n`.repeat(10_000)}"`) as Member).a, expected);
	});

	test('a long literal string', () => {
		const expected = 'é'.repeat(100_000);
		assert.equal((parse(`a: '${expected}'`) as Member).a, expected);
	});

	test('block strings dedent by the closing delimiter', () => {
		assert.equal((parse('a: \'\'\'\n\t\tone\n\t\t\ttwo\n\t\t\'\'\'') as Member).a, 'one\n\ttwo');
	});

	test('block strings drop blank lines at the edges only', () => {
		assert.equal((parse('a: \'\'\'\n\n\n\tx\n\n\ty\n\n\n\t\'\'\'') as Member).a, 'x\n\ny');
	});

	test('a blank line in a block string needs no indentation and becomes an empty line', () => {
		assert.equal((parse('a: \'\'\'\n    \n  x\n  \'\'\'') as Member).a, 'x');
		assert.equal((parse('a: \'\'\'\n  x\n     \n  \'\'\'') as Member).a, 'x');
		assert.equal((parse('a: \'\'\'\n  x\n \n  y\n  \'\'\'') as Member).a, 'x\n\ny');
		assert.equal((parse('a: \'\'\'\n\tx\n \t \n\ty\n\t\'\'\'') as Member).a, 'x\n\ny');
		assert.equal((parse('a: """\n\tx\n\t\t\n\ty\n\t"""') as Member).a, 'x\n\ny');
	});

	test('a content line indented less than the closing delimiter is still an error', () => {
		assert.throws(() => parse('a: \'\'\'\n\tx\n y\n\t\'\'\''), {reason: /indentation of its block string's closing delimiter/v, line: 3, column: 1});
	});

	test('escaped block strings decode escapes after dedenting', () => {
		assert.equal((parse('a: """\n\t\\t\\u{41}\n\t"""') as Member).a, '\tA');
	});

	test('an escape error in a block string points at the escape', () => {
		assert.throws(() => parse('a: """\n\tok\n\t  x\\q\n\t"""'), {reason: /Unknown escape “\\q”/v, line: 3, column: 5});
	});

	test('a block string closed by a longer delimiter can hold the shorter run', () => {
		assert.equal((parse('a: \'\'\'\'\'\n\t\'\'\'\n\t\'\'\'\'\n\t\'\'\'\'\'') as Member).a, '\'\'\'\n\'\'\'\'');
	});
});

suite('numbers', () => {
	test('int forms', () => {
		assert.deepEqual((parse('a: [0, 1, -1, 1_000, 0xFF, 0x00FF, 0o17, 0b1010, 0xDEAD_BEEF]') as Member).a, [0n, 1n, -1n, 1000n, 255n, 255n, 15n, 10n, 3_735_928_559n]);
	});

	test('float forms', () => {
		assert.deepEqual((parse('a: [1.5, 1e10, 100e2, 1.5e-3, -1e-10, 1_0.5_0]') as Member).a, [1.5, 1e10, 10_000, 0.0015, -1e-10, 10.5]);
	});

	test('an exponent of zero has one spelling', () => {
		assert.equal((parse('a: 1e0') as Member).a, 1);
		assert.throws(() => parse('a: 1e-0'), {reason: '“e-0” is not allowed, because an exponent of zero has one spelling: e0', column: 4});
		assert.throws(() => parse('a: 1.5e-0'), {reason: '“e-0” is not allowed, because an exponent of zero has one spelling: e0'});
	});

	test('an exponent has no leading zeros, like the integer part', () => {
		assert.deepEqual((parse('a: [1e0, 1e5, 1e-5, 1e1_0, 1.5e10]') as Member).a, [1, 1e5, 1e-5, 1e10, 1.5e10]);

		for (const text of ['1e05', '1e-05', '1e00', '1e0_5', '1.5e007', '-1e-0_1']) {
			assert.throws(() => parse(`a: ${text}`), {reason: 'Leading zeros are not allowed in an exponent', column: 4});
		}
	});

	test('the int64 boundaries in every radix', () => {
		assert.equal((parse('a: 0x7FFFFFFFFFFFFFFF') as Member).a, (2n ** 63n) - 1n);
		assert.equal((parse('a: 0o777777777777777777777') as Member).a, (2n ** 63n) - 1n);
		assert.equal((parse(`a: 0b${'1'.repeat(63)}`) as Member).a, (2n ** 63n) - 1n);
		assert.throws(() => parse('a: 0x8000000000000000'), {reason: /64-bit range/v});
		assert.throws(() => parse('a: 0o1000000000000000000000'), {reason: /64-bit range/v});
		assert.throws(() => parse(`a: 0b1${'0'.repeat(63)}`), {reason: /64-bit range/v});
	});

	test('a huge int does not hang', () => {
		assert.throws(() => parse(`a: ${'9'.repeat(100_000)}`), {reason: /64-bit range/v});
	});

	test('a float with many digits rounds correctly', () => {
		assert.equal((parse(`a: 0.${'3'.repeat(1000)}`) as Member).a, 1 / 3);
		assert.equal((parse('a: 2.2250738585072011e-308') as Member).a, 2.225073858507201e-308);
	});

	test('the largest finite float and the first one past it', () => {
		assert.equal((parse('a: 1.7976931348623157e308') as Member).a, Number.MAX_VALUE);
		assert.equal((parse('a: 1.7976931348623158e308') as Member).a, Number.MAX_VALUE);
		assert.throws(() => parse('a: 1.7976931348623159e308'), {reason: /too large/v});
	});
});

suite('durations', () => {
	test('a duration is a Temporal.Duration in hours and smaller units', () => {
		const {a} = parse('a: 90m') as Member;
		assert.ok(a instanceof Temporal.Duration);
		assert.equal(a.toString(), 'PT1H30M');
	});

	test('every unit, in its own length', () => {
		const units = {
			h: 3_600_000_000_000n,
			m: 60_000_000_000n,
			s: 1_000_000_000n,
			ms: 1_000_000n,
			us: 1000n,
			ns: 1n,
		};

		for (const [unit, length] of Object.entries(units)) {
			assert.equal(durationNanoseconds((parse(`a: 7${unit}`) as Member<Temporal.Duration>).a), 7n * length, unit);
		}
	});

	test('the int64 bounds are exact', () => {
		assert.equal(durationNanoseconds((parse('a: 9223372036854775807ns') as Member<Temporal.Duration>).a), (2n ** 63n) - 1n);
		assert.equal(durationNanoseconds((parse('a: -9223372036854775808ns') as Member<Temporal.Duration>).a), -(2n ** 63n));
		assert.throws(() => parse('a: 9223372036854775808ns'), {reason: /outside the 64-bit range/v});
		assert.throws(() => parse('a: -9223372036854775809ns'), {reason: /outside the 64-bit range/v});
	});

	test('a fraction is exact', () => {
		assert.equal(durationNanoseconds((parse('a: 1.5h') as Member<Temporal.Duration>).a), 5_400_000_000_000n);
		assert.equal(durationNanoseconds((parse('a: 0.000000001s') as Member<Temporal.Duration>).a), 1n);
		assert.equal(durationNanoseconds((parse('a: 1h0.5ms') as Member<Temporal.Duration>).a), 3_600_000_500_000n);
		assert.equal(durationNanoseconds((parse(`a: 1.5${'0'.repeat(5000)}s`) as Member<Temporal.Duration>).a), 1_500_000_000n);
		assert.throws(() => parse('a: 0.0000000000001h'), {reason: /not a whole number of nanoseconds/v});
	});

	test('the sign applies to the whole duration', () => {
		assert.equal(durationNanoseconds((parse('a: -1h30m') as Member<Temporal.Duration>).a), -5_400_000_000_000n);
	});

	test('a duration-shaped key is a string', () => {
		assert.deepEqual(Object.keys(parse('1h30m: 1')), ['1h30m']);
	});
});

suite('instants', () => {
	test('leap years', () => {
		assert.ok((parse('a: 2024-02-29T00:00:00Z') as Member<Temporal.Instant | undefined>).a);
		assert.ok((parse('a: 2000-02-29T00:00:00Z') as Member<Temporal.Instant | undefined>).a);
		assert.ok((parse('a: 2400-02-29T00:00:00Z') as Member<Temporal.Instant | undefined>).a);
		assert.ok((parse('a: 0004-02-29T00:00:00Z') as Member<Temporal.Instant | undefined>).a);
		assert.throws(() => parse('a: 1900-02-29T00:00:00Z'), ParseError);
		assert.throws(() => parse('a: 2100-02-29T00:00:00Z'), ParseError);
		assert.throws(() => parse('a: 2023-02-29T00:00:00Z'), ParseError);
	});

	test('every month length in a leap year and a common year', () => {
		const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

		for (const [year, isLeap] of [[2023, false], [2024, true]] as const) {
			for (const [index, length] of lengths.entries()) {
				const month = String(index + 1).padStart(2, '0');
				const last = index === 1 && isLeap ? 29 : length;
				assert.ok((parse(`a: ${year}-${month}-${last}T00:00:00Z`) as Member<Temporal.Instant | undefined>).a);
				assert.throws(() => parse(`a: ${year}-${month}-${last + 1}T00:00:00Z`), {reason: new RegExp(`day must be 01 to ${last}`, 'v')});
			}
		}
	});

	test('the range is checked in UTC', () => {
		assert.throws(() => parse('a: 0001-01-01T00:59:59+01:00'), {reason: /outside the years 0001 to 9999/v});
		assert.ok((parse('a: 0001-01-01T01:00:00+01:00') as Member<Temporal.Instant | undefined>).a);
		assert.throws(() => parse('a: 9999-12-31T23:00:00-01:00'), {reason: /outside the years 0001 to 9999/v});
		assert.ok((parse('a: 9999-12-31T22:59:59.999999999-01:00') as Member<Temporal.Instant | undefined>).a);
	});

	test('Temporal\'s leniency is not inherited', () => {
		for (const value of ['2026-09-19t14:00:00Z', '2026-09-19T14:00:00z', '2026-09-19T14:00:00+0700', '2026-12-31T23:59:60Z', '2026-09-19T14:00:00.1234567891Z', '2026-09-19T14:00:00-00:00']) {
			assert.throws(() => parse(`a: ${value}`), ParseError, value);
		}
	});
});

suite('nesting limit', () => {
	test('100 nested arrays are accepted', () => {
		let value: Value | undefined = parse(`${'['.repeat(100)}${']'.repeat(100)}`);
		let depth = 0;

		while (Array.isArray(value)) {
			depth++;
			value = value[0];
		}

		assert.equal(depth, 100);
	});

	test('101 nested arrays are rejected with a ParseError, not a stack overflow', () => {
		assert.throws(() => parse(`${'['.repeat(101)}${']'.repeat(101)}`), {name: 'ParseError', reason: 'The document is nested more than 100 levels deep'});
	});

	test('nested objects count the same way', () => {
		assert.deepEqual(Object.keys(parse(`${'a: {'.repeat(99)}${'}'.repeat(99)}`)), ['a']);
		assert.throws(() => parse(`${'a: {'.repeat(100)}${'}'.repeat(100)}`), {reason: /nested more than 100/v});
	});

	test('an unclosed deep document fails cleanly', () => {
		assert.throws(() => parse('['.repeat(100_000)), {name: 'ParseError'});
		assert.throws(() => parse('a: '.repeat(100_000)), {name: 'ParseError'});
	});

	test('what parses also serializes', () => {
		const value = parse(`${'['.repeat(100)}${']'.repeat(100)}`);
		assert.equal(parse(stringify(value)).length, 1);
	});
});

suite('hardened environments', () => {
	/*
	Freezing `Object.prototype` cannot be undone, so each case runs in its own process. It gets the same flags as this one, so a `Temporal` polyfill loaded with `--import` is loaded there too.
	*/
	function runIsolated(code: string) {
		const result = spawnSync(process.execPath, [...process.execArgv, '--input-type=module', '--eval', `import {parse, parseTree, stringify, stringifyValue} from ${JSON.stringify(sourceUrl)};\n${code}`], {encoding: 'utf8'});
		assert.equal(result.stderr, '');
		return result.stdout.trim();
	}

	test('a frozen Object.prototype does not break keys it has', () => {
		const output = runIsolated(String.raw`
Object.freeze(Object.prototype);
const value = parse('toString: 1\nvalueOf: {a: 2}\nlist: [{hasOwnProperty: 3}]\nconstructor: {name: 4}');
console.log(JSON.stringify(value, (key, member) => typeof member === 'bigint' ? Number(member) : member));
`);
		assert.equal(output, '{"toString":1,"valueOf":{"a":2},"list":[{"hasOwnProperty":3}],"constructor":{"name":4}}');
	});

	test('a setter on Object.prototype is never called, and the member is kept', () => {
		const output = runIsolated(String.raw`
let calls = 0;
Object.defineProperty(Object.prototype, 'admin', {set() { calls++; }, configurable: true});
const value = parse('admin: true\nnested: {admin: true}\nadmin2: {admin: true}');
console.log([calls, Object.hasOwn(value, 'admin'), value.nested.admin === true, Object.hasOwn(value.admin2, 'admin')].join(' '));
`);
		assert.equal(output, '0 true true true');
	});

	test('an escape on Object.prototype is not written into a string', () => {
		const output = runIsolated(String.raw`
Object.prototype['\u{1}'] = '"\nadmin: true\nx: "';
Object.prototype.a = 'x';
console.log(JSON.stringify([stringify({name: 'a\u{1}b'}), stringifyValue('a\u{7f}\tb\\c"d\'')]));
`);
		assert.equal(output, JSON.stringify(['name: "a\\u{1}b"\n', String.raw`"a\u{7f}\tb\\c\"d'"`]));
	});

	test('a radix or an escape on Object.prototype does not change how a number or a string is read', () => {
		const output = runIsolated(String.raw`
for (const key of ['e', '2', '5', 'q', 'r', 'u', 'x']) {
	Object.prototype[key] = key === '2' ? 16 : 'polluted';
}

let reason;

try {
	parse('a: "a\\qb"');
} catch (error) {
	reason = error.reason;
}

const value = parse('a: [0e5, 12, 0x1F, 0o17, 0b11, 1.5e2, 25, "a\\nb\\tc\\u{1f600}"]');
const radixes = parseTree('a: [12, 0x1F, 0o17, 0b11, 25]').body.members[0].value.elements.map(element => element.radix);
console.log(JSON.stringify([value, reason, radixes], (key, member) => typeof member === 'bigint' ? Number(member) : member));
`);
		assert.equal(output, JSON.stringify([{a: [0, 12, 31, 15, 3, 150, 25, 'a\nb\tc😀']}, String.raw`Unknown escape “\q”. The escapes are \\, \", \n, \t, and \u{…}; use a '...' string for literal backslashes`, [10, 16, 8, 2, 10]]));
	});
});

suite('without Temporal', () => {
	/*
	Before Node.js 26, `Temporal` is missing unless a polyfill is loaded. The package reads it at import, so each case deletes it first, in its own process.
	*/
	function runWithoutTemporal(code: string) {
		const script = `delete globalThis.Temporal;\nconst {parse, parseTree, format, stringify, edit} = await import(${JSON.stringify(sourceUrl)});\n${code}`;
		const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {encoding: 'utf8', maxBuffer: 100_000_000});
		assert.equal(result.stderr, '');
		return result.stdout.trim();
	}

	test('everything but the values of instants and durations works, including editing a document that has them', () => {
		const output = runWithoutTemporal(String.raw`
console.log(stringify(parse('a: 1\nb: [true, \'x\']')));
console.log(stringify({a: new Date(-1)}));
console.log(parseTree('a: 1').body.type);
console.log(edit('a: 1h\nb: 2026-01-01T00:00:00Z', ['c'], 3n));
try {
	parse('a: {b: 1}\na: 2');
} catch (error) {
	console.log(error.reason);
}
`);
		assert.equal(output, 'a: 1\nb: [\n\ttrue\n\t\'x\'\n]\n\na: 1969-12-31T23:59:59.999Z\n\nObject\na: 1h\nb: 2026-01-01T00:00:00Z\nc: 3\nDuplicate key a');
	});

	test('an instant or a duration throws an error that names the fix', () => {
		const output = runWithoutTemporal(`
for (const run of [() => parse('a: 2026-01-01T00:00:00Z'), () => parse('a: 1h'), () => parseTree('a: 1h').body.members[0].value.value]) {
	try {
		run();
	} catch (error) {
		console.log(error.message);
	}
}
`);
		const message = 'Instants and durations need `Temporal`. Use Node.js 26 or later, or load a polyfill such as `temporal-polyfill/global` before this package';
		assert.deepEqual(output.split('\n'), Array.from({length: 3}, () => message));
	});

	test('format() and parseTree() work on every conformance document, and give the same errors', () => {
		const root = path.join(import.meta.dirname, 'conformance');
		const files = fs.readdirSync(root, {recursive: true, encoding: 'utf8'}).filter(file => file.endsWith('.soml')).toSorted();

		const output = runWithoutTemporal(`
const fs = await import('node:fs');
const path = await import('node:path');
const results = [];
for (const file of ${JSON.stringify(files)}) {
	const text = fs.readFileSync(path.join(${JSON.stringify(root)}, file), 'utf8');
	try {
		parseTree(text);
		results.push(format(text));
	} catch (error) {
		results.push({reason: error.reason, offset: error.offset});
	}
}
console.log(JSON.stringify(results));
`);

		const expected = files.map(file => {
			const text = fs.readFileSync(path.join(root, file), 'utf8');

			try {
				return format(text);
			} catch (error) {
				return {reason: (error as ParseError).reason, offset: (error as ParseError).offset};
			}
		});

		assert.deepEqual(JSON.parse(output), expected);
	});
});

suite('huge tokens', () => {
	// Each token is longer than a regular expression with a repeated group can handle, so these fail with a stack overflow unless the scan is hand-written.
	const length = 5_000_000;

	test('a huge valid float', () => {
		assert.equal((parse(`a: 0.${'1'.repeat(length)}`) as Member).a, 0.1111111111111111);
	});

	test('a huge hexadecimal int with leading zeros', () => {
		assert.equal((parse(`a: 0x${'0'.repeat(length)}FF`) as Member).a, 255n);
	});

	test('huge out-of-range ints', () => {
		assert.throws(() => parse(`a: ${'1'.repeat(length)}`), {name: 'ParseError', reason: /64-bit range/v});
		assert.throws(() => parse(`a: 0x${'F'.repeat(length)}`), {name: 'ParseError', reason: /64-bit range/v});
		assert.throws(() => parse(`a: 0b${'1_'.repeat(length / 2)}1`), {name: 'ParseError', reason: /64-bit range/v});
	});

	test('huge invalid numbers and instants', () => {
		assert.throws(() => parse(`a: 1${'_'.repeat(length)}`), {name: 'ParseError'});
		assert.throws(() => parse(`a: 1${'x'.repeat(length)}`), {name: 'ParseError'});
		assert.throws(() => parse(`a: 1.${'2'.repeat(length)}.3`), {name: 'ParseError'});
		assert.throws(() => parse(`a: 2026-01-01T00:00:00.${'1'.repeat(length)}Z`), {name: 'ParseError'});
	});

	test('a huge unquoted word', () => {
		assert.throws(() => parse(`a: ${'x'.repeat(length)}`), {name: 'ParseError'});
	});

	test('a huge bare key, as a duplicate and through stringify', () => {
		const key = 'k'.repeat(length);
		assert.throws(() => parse(`${key}: 1\n${key}: 2`), {name: 'ParseError', reason: /^Duplicate key k+…$/v});
		assert.equal(stringify(parse(`${key}: 1`)).length, length + 4);
	});

	test('a huge run of spaces and tabs in a block string', () => {
		const run = ' \t'.repeat(length);
		assert.deepEqual(parse(`a: '''\n${run}\nx\n'''`), {a: 'x'});
		assert.deepEqual(parse(`a: '''\n${run}x\n${run}'''`), {a: 'x'});
		assert.equal(format(`a: '''\n${run}\nx\n'''`), `a:\n\t'''\n${run}\n\tx\n\t'''\n`);
	});

	test('a huge run of spaces and tabs between items', () => {
		assert.equal(format(`[\n1,\n${' \t'.repeat(length)}2,\n]`), '[\n\t1\n\t2\n]\n');
	});

	test('huge keys and gaps in the error paths', () => {
		assert.throws(() => parse(`$${'a'.repeat(length)}`), {name: 'ParseError'});
		assert.throws(() => parse(`${'é'.repeat(length)}:1`), {name: 'ParseError'});
		assert.throws(() => parse(`a: 1${'_0'.repeat(length)}M`), {name: 'ParseError'});
		assert.throws(() => parse(`a /**/${' '.repeat(length * 4)}:1`), {name: 'ParseError', reason: 'A comment is not allowed between a key and its “:”'});
	});

	test('a huge comment where a value was meant to start with "#"', () => {
		const comment = `#${'x'.repeat(length * 2)}`;
		const reason = /“#” starts a comment, so a value that starts with “#” must be quoted, as in '#x+…'$/v;
		assert.throws(() => parse(`a: ${comment}`), {name: 'ParseError', reason});
		assert.throws(() => parse(`a: ${comment}\nb: 1`), {name: 'ParseError'});
		assert.throws(() => parse(`{a: ${comment}\n}`), {name: 'ParseError', reason});
		assert.throws(() => format(`a: ${comment}`), {name: 'ParseError', reason});
	});

	test('a huge number followed by a space and a unit', () => {
		const reason = /^A unit cannot follow a number after a space/v;
		assert.throws(() => parse(`a: 1.${'0'.repeat(length * 2)} ms`), {name: 'ParseError', reason});
		assert.throws(() => parse(`a: 1.${'0_'.repeat(length)}5 ms`), {name: 'ParseError', reason});
		assert.throws(() => parse(`a: [1.${'0'.repeat(length * 2)}5 MiB]`), {name: 'ParseError', reason});
	});

	test('error messages quote at most 40 characters of a token', () => {
		const error = (() => {
			try {
				parse(`a: ${'x'.repeat(length)}`);
			} catch (error) {
				return error;
			}

			return undefined;
		})();

		assert.ok((error as Error).message.length < 1000);
	});
});

suite('values from another realm', () => {
	test('a Uint8Array from a vm context', () => {
		assert.deepEqual(parse(vm.runInNewContext('new Uint8Array([97, 58, 32, 49])') as Uint8Array), {a: 1n});
	});

	test('an object that only claims to be a Uint8Array is rejected', () => {
		// @ts-expect-error -- An object that is not a Uint8Array.
		assert.throws(() => parse({[Symbol.toStringTag]: 'Uint8Array'}), {name: 'TypeError', message: 'Expected a string or a Uint8Array, got an object'});
	});
});

suite('UTF-8 details', () => {
	test('a sequence cut short by the end of the input', () => {
		assert.throws(() => parse(new Uint8Array([0x61, 0x3A, 0x20, 0x31, 0x20, 0x23, 0xE2, 0x82])), {reason: 'Incomplete UTF-8 sequence at the end of the input', line: 1, column: 7});
	});

	test('a cut sequence that is not at the end is invalid, not incomplete', () => {
		assert.throws(() => parse(new Uint8Array([0x61, 0x3A, 0x20, 0x27, 0xE2, 0x82, 0x27])), {reason: 'Invalid UTF-8 byte 0xE2'});
	});

	test('a sequence at the end that no further bytes could complete is invalid, not incomplete', () => {
		const prefix = [0x61, 0x3A, 0x20, 0x27];

		// An overlong form, an encoded surrogate, a sequence above U+10FFFF, and a byte that never starts one.
		for (const bytes of [[0xE0, 0x80], [0xED, 0xA0], [0xF0, 0x80], [0xF4, 0x90], [0xC0], [0xF5]]) {
			assert.throws(() => parse(new Uint8Array([...prefix, ...bytes])), {reason: `Invalid UTF-8 byte 0x${bytes[0]!.toString(16).toUpperCase()}`, line: 1, column: 5});
		}
	});

	test('every valid prefix of a sequence at the end is incomplete', () => {
		const prefix = [0x61, 0x3A, 0x20, 0x27];

		for (const bytes of [[0xC3], [0xE2], [0xE2, 0x82], [0xF0], [0xF0, 0x9F], [0xF0, 0x9F, 0x98], [0xF4, 0x8F, 0xBF]]) {
			assert.throws(() => parse(new Uint8Array([...prefix, ...bytes])), {reason: 'Incomplete UTF-8 sequence at the end of the input', line: 1, column: 5});
		}
	});
});
