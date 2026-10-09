import {test, suite} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {
	parse,
	stringify,
	stringifyValue,
	compareKeys,
	formatFloat,
	formatKey,
	formatString,
	isBareKey,
	type StringifyOptions,
} from '../source/index.ts';
import {
	createRandom,
	randomFloat,
	randomKey,
	randomString,
} from './helpers.ts';

suite('layout', () => {
	test('a top-level object has no braces and no indentation', () => {
		assert.equal(stringify({a: 1n, b: 'x'}), 'a: 1\nb: \'x\'\n');
	});

	test('a top-level array', () => {
		assert.equal(stringify([1n, 'x']), '[\n\t1\n\t\'x\'\n]\n');
	});

	test('an empty top-level object keeps its braces', () => {
		assert.equal(stringify({}), '{}\n');
		assert.equal(stringify({a: undefined}), '{}\n');
	});

	test('an empty top-level array', () => {
		assert.equal(stringify([]), '[]\n');
	});

	test('nesting is one tab per level, with no commas', () => {
		assert.equal(stringify({a: {b: [1n, {c: []}]}}), 'a: {\n\tb: [\n\t\t1\n\t\t{\n\t\t\tc: []\n\t\t}\n\t]\n}\n');
	});

	test('empty nested containers are written on one line', () => {
		assert.equal(stringify({a: {}, b: []}), 'a: {}\nb: []\n');
		assert.equal(stringify([[], {}]), '[\n\t[]\n\t{}\n]\n');
	});

	test('the output ends with exactly one line feed', () => {
		for (const value of [{a: 1n}, [], {}, [[]], {a: {b: {}}}]) {
			const output = stringify(value);
			assert.ok(output.endsWith('\n'));
			assert.ok(!output.endsWith('\n\n'));
		}
	});
});

suite('key order', () => {
	test('members keep the order of the input by default, also in nested objects', () => {
		assert.equal(stringify({b: 1n, a: 2n, c: 3n}), 'b: 1\na: 2\nc: 3\n');
		assert.equal(stringify({z: {b: 1n, a: [{d: 2n, c: 3n}]}, y: 4n}), 'z: {\n\tb: 1\n\ta: [\n\t\t{\n\t\t\td: 2\n\t\t\tc: 3\n\t\t}\n\t]\n}\ny: 4\n');
		const parsed = parse('name: \'api\'\ndescription: \'x\'\npostgres: {port: 5432, host: \'db\'}\n');
		assert.equal(stringify(parsed), 'name: \'api\'\ndescription: \'x\'\npostgres: {\n\tport: 5432\n\thost: \'db\'\n}\n');
	});

	test('integer-like keys come first by default, in numeric order, because JavaScript enumerates them so', () => {
		assert.equal(stringify({
			b: 1n, 10: 2n, 9: 3n, 1: 4n,
		}), '1: 4\n9: 3\n10: 2\nb: 1\n');
	});

	test('`canonical: true` sorts members by key', () => {
		assert.equal(stringify({b: 1n, a: 2n, c: 3n}, {canonical: true}), 'a: 2\nb: 1\nc: 3\n');
	});

	test('`canonical: true` sorts integer-like keys as strings, not in JS property order', () => {
		assert.equal(stringify({
			b: 1n, 10: 2n, 9: 3n, 1: 4n,
		}, {canonical: true}), '1: 4\n10: 2\n9: 3\nb: 1\n');
	});

	test('sorting compares code points, not UTF-16 code units', () => {
		// U+FF61 is one code unit, and U+1F600 is a surrogate pair starting with 0xD83D. Code unit order would put the emoji first.
		assert.equal(stringify({'😀': 1n, '\u{FF61}': 2n}, {canonical: true}), '\'\u{FF61}\': 2\n\'😀\': 1\n');
		assert.equal(stringify({
			'\u{10000}': 1n, '\u{FFFF}': 2n, '\u{E000}': 3n, '\u{D7FF}': 4n, z: 5n,
		}, {canonical: true}), 'z: 5\n\'\u{D7FF}\': 4\n\'\u{E000}\': 3\n\'\u{FFFF}\': 2\n\'\u{10000}\': 1\n');
	});

	test('keys from U+E000 to U+FFFF, with no surrogate pair, are sorted by code point', () => {
		assert.equal(stringify({
			'\u{FFFD}': 1n, '\u{F8FF}': 2n, '\u{E000}': 3n, '\u{D7FF}': 4n, a: 5n,
		}, {canonical: true}), 'a: 5\n\'\u{D7FF}\': 4\n\'\u{E000}\': 3\n\'\u{F8FF}\': 2\n\'\u{FFFD}\': 1\n');
	});

	test('two astral keys are compared by code point', () => {
		assert.equal(stringify({'\u{1F601}': 1n, '\u{1F600}': 2n, '\u{20000}': 3n}, {canonical: true}), '\'\u{1F600}\': 2\n\'\u{1F601}\': 1\n\'\u{20000}\': 3\n');
	});

	test('a key that is a prefix of another comes first', () => {
		assert.equal(stringify({ab: 1n, a: 2n, 'a-b': 3n}, {canonical: true}), 'a: 2\na-b: 3\nab: 1\n');
	});

	test('nested objects are sorted too', () => {
		assert.equal(stringify({z: {b: 1n, a: [{d: 2n, c: 3n}]}, y: 4n}, {canonical: true}), 'y: 4\nz: {\n\ta: [\n\t\t{\n\t\t\tc: 3\n\t\t\td: 2\n\t\t}\n\t]\n\tb: 1\n}\n');
	});

	test('arrays keep their order', () => {
		assert.equal(stringify([3n, 1n, 2n]), '[\n\t3\n\t1\n\t2\n]\n');
		assert.equal(stringify([3n, 1n, 2n], {canonical: true}), '[\n\t3\n\t1\n\t2\n]\n');
	});

	test('with `canonical: true`, insertion order does not change the output', () => {
		assert.equal(stringify({a: 1n, b: 2n}, {canonical: true}), stringify({b: 2n, a: 1n}, {canonical: true}));
	});

	test('the canonical option must be a boolean', () => {
		assert.throws(() => stringify({}, {canonical: 'yes' as unknown as boolean}), {name: 'TypeError', message: 'The `canonical` option must be a boolean, got string'});
		assert.throws(() => stringify({}, {canonical: null as unknown as boolean}), {name: 'TypeError', message: 'The `canonical` option must be a boolean, got null'});
		assert.throws(() => stringifyValue(1n, {canonical: 1 as unknown as boolean}), {name: 'TypeError', message: 'The `canonical` option must be a boolean, got number'});
		assert.equal(stringify({b: 1n, a: 2n}, {canonical: undefined}), 'b: 1\na: 2\n');
		assert.equal(stringify({b: 1n, a: 2n}, {canonical: false}), 'b: 1\na: 2\n');
	});

	test('an option inherited from the options object\'s prototype is not read', () => {
		// A property on the options object's own prototype is not an option, as a property on `Object.prototype` is not either, so it changes nothing. `options` is otherwise an empty object.
		const makeOptions = (prototype: Record<string, unknown>): StringifyOptions => Object.create(prototype) as StringifyOptions;
		assert.equal(stringify({b: 1n, a: 2n}, makeOptions({canonical: true})), 'b: 1\na: 2\n');
		assert.equal(stringify({a: 1n}, makeOptions({canonical: 'yes'})), 'a: 1\n');
		assert.equal(stringify({a: 8080}, makeOptions({integers: 'number'})), 'a: 8080.0\n');
	});
});

suite('compareKeys', () => {
	test('orders by code point, so U+FFFD comes before an astral character', () => {
		assert.deepEqual(['b', '😀', 'a', '\u{FFFD}', '\u{E000}', 'ab', ''].toSorted(compareKeys), ['', 'a', 'ab', 'b', '\u{E000}', '\u{FFFD}', '😀']);
		assert.equal(compareKeys('a', 'a'), 0);
	});

	test('agrees with comparing the code points one by one', () => {
		const random = createRandom(1);
		const codePoints = (key: string) => [...key].map(character => character.codePointAt(0)!);

		for (let round = 0; round < 2000; round++) {
			const left = randomString(random, 6);
			const right = randomString(random, 6);
			const [leftCodes, rightCodes] = [codePoints(left), codePoints(right)];
			const index = leftCodes.findIndex((code, position) => code !== rightCodes[position]);
			const expected = index === -1 ? leftCodes.length - rightCodes.length : leftCodes[index]! - (rightCodes[index] ?? -1);
			assert.equal(Math.sign(compareKeys(left, right)), Math.sign(expected), JSON.stringify([left, right]));
		}
	});
});

suite('isBareKey', () => {
	test('one or more letters, digits, `_`, or `-`', () => {
		for (const key of ['a', 'content-type', '_private', '404', '-x', '2024-01-01']) {
			assert.ok(isBareKey(key), key);
		}

		for (const key of ['', 'a.b', 'a b', 'é', '$ref']) {
			assert.ok(!isBareKey(key), key);
		}
	});

	test('stringify writes exactly these keys bare', () => {
		const random = createRandom(2);

		for (let round = 0; round < 2000; round++) {
			const key = randomKey(random);
			assert.equal(stringify({[key]: 1n}).startsWith(`${key}: `), isBareKey(key), JSON.stringify(key));
		}
	});
});

suite('formatFloat, formatKey, and formatString', () => {
	const apostrophe = String.fromCharCode(0x27);

	test('the same spelling as stringifyValue and stringify', () => {
		const random = createRandom(3);

		for (let round = 0; round < 2000; round++) {
			const float = randomFloat(random);
			assert.equal(formatFloat(float), stringifyValue(float), String(float));
		}

		for (let round = 0; round < 2000; round++) {
			const key = randomKey(random);
			assert.equal(stringify({[key]: 1n}).startsWith(`${formatKey(key)}: `), true, JSON.stringify(key));
		}

		for (let round = 0; round < 2000; round++) {
			const string = randomString(random);
			assert.equal(formatString(string), stringifyValue(string), JSON.stringify(string));
		}
	});

	test('formatFloat writes floats only', () => {
		assert.equal(formatFloat(30), '30.0');
		assert.equal(formatFloat(-0), '0.0');
		assert.equal(formatFloat(0.1 + 0.2), '0.30000000000000004');
		assert.equal(formatFloat(Infinity), 'infinity');
		assert.equal(formatFloat(-Infinity), '-infinity');
		assert.throws(() => formatFloat(NaN), {name: 'TypeError', message: /NaN/v});
	});

	test('formatKey writes keys', () => {
		assert.equal(formatKey('name'), 'name');
		assert.equal(formatKey('content-type'), 'content-type');
		assert.equal(formatKey('content type'), '\'content type\'');
		assert.equal(formatKey(`it${apostrophe}s`), `"it${apostrophe}s"`);
	});

	test('formatString writes strings', () => {
		assert.equal(formatString('api-gateway'), '\'api-gateway\'');
		assert.equal(formatString(`it${apostrophe}s`), `"it${apostrophe}s"`);
		assert.equal(formatString('a\nb'), String.raw`"a\nb"`);
		assert.equal(formatString('😀'), '\'😀\'');
		assert.throws(() => formatString('a\u{D800}'), {name: 'TypeError', message: /lone surrogate/v});
		assert.throws(() => formatString('a\rb'), {name: 'TypeError', message: /carriage return/v});
	});
});

suite('keys', () => {
	test('bare when every character is a letter, digit, `_`, or `-`', () => {
		assert.equal(stringify({
			'content-type': 1n, _x: 2n, 404: 3n, '-': 4n,
		}), '404: 3\ncontent-type: 1\n_x: 2\n-: 4\n');
	});

	test('quoted otherwise', () => {
		assert.equal(stringify({'a b': 1n}), '\'a b\': 1\n');
		assert.equal(stringify({'a.b': 1n}), '\'a.b\': 1\n');
		assert.equal(stringify({'': 1n}), '\'\': 1\n');
		assert.equal(stringify({café: 1n}), '\'café\': 1\n');
		assert.equal(stringify({'it\'s': 1n}), '"it\'s": 1\n');
		assert.equal(stringify({'a\tb': 1n}), '"a\\tb": 1\n');
	});

	test('keywords and number-like keys are bare', () => {
		assert.equal(stringify({
			true: 1n, null: 2n, infinity: 3n, 1e3: 4n,
		}), '1000: 4\ntrue: 1\nnull: 2\ninfinity: 3\n');
	});

	test('`__proto__` round-trips as an own key', () => {
		const value = parse('__proto__: {a: 1}');
		assert.equal(stringify(value), '__proto__: {\n\ta: 1\n}\n');
	});

	test('symbol keys are ignored, like JSON.stringify', () => {
		assert.equal(stringify({a: 1n, [Symbol('x')]: 2n}), 'a: 1\n');
	});

	test('non-enumerable keys are ignored', () => {
		const value = {a: 1n};
		Object.defineProperty(value, 'hidden', {value: 2n, enumerable: false});
		assert.equal(stringify(value), 'a: 1\n');
	});

	test('a key with a lone surrogate throws', () => {
		assert.throws(() => stringify({'\u{D800}': 1n}), {name: 'TypeError', message: /key containing a lone surrogate/v});
	});

	test('a key with a line feed is written as an escaped string', () => {
		assert.equal(stringify({'a\nb': 1n}), '"a\\nb": 1\n');
		assert.equal(stringify({nested: {'\n': 1n}}), 'nested: {\n\t"\\n": 1\n}\n');
	});

	test('a key with a carriage return throws', () => {
		assert.throws(() => stringify({'a\rb': 1n}), {name: 'TypeError', message: /key containing a carriage return/v});
	});
});

suite('strings', () => {
	test('literal by default', () => {
		assert.equal(stringify({a: 'x'}), 'a: \'x\'\n');
		assert.equal(stringify({a: ''}), 'a: \'\'\n');
	});

	test('backslashes and double quotes stay literal', () => {
		assert.equal(stringify({a: String.raw`C:\Users\x`}), 'a: \'C:\\Users\\x\'\n');
		assert.equal(stringify({a: 'say "hi"'}), 'a: \'say "hi"\'\n');
	});

	test('a single quote switches to an escaped string', () => {
		assert.equal(stringify({a: 'it\'s'}), 'a: "it\'s"\n');
		assert.equal(stringify({a: 'it\'s "x" \\'}), 'a: "it\'s \\"x\\" \\\\"\n');
	});

	test('control characters switch to an escaped string', () => {
		assert.equal(stringify({a: 'a\nb'}), 'a: "a\\nb"\n');
		assert.equal(stringify({a: 'a\tb'}), 'a: "a\\tb"\n');
		assert.equal(stringify({a: '\u{0}'}), 'a: "\\u{0}"\n');
		assert.equal(stringify({a: '\u{1F}'}), 'a: "\\u{1f}"\n');
		assert.equal(stringify({a: '\u{7F}'}), 'a: "\\u{7f}"\n');
		assert.equal(stringify({a: '\u{8}\u{B}\u{C}'}), 'a: "\\u{8}\\u{b}\\u{c}"\n');
	});

	test('every C0 control character is escaped in the shortest lowercase form', () => {
		for (let code = 0; code < 0x20; code++) {
			if (code === 0x0D) {
				continue;
			}

			const expected = {0x0A: String.raw`\n`, 0x09: String.raw`\t`}[code] ?? String.raw`\u{${code.toString(16)}}`;
			assert.equal(stringify({a: String.fromCodePoint(code)}), `a: "${expected}"\n`);
		}
	});

	test('everything else is written literally', () => {
		const text = '\u{80}\u{85}\u{9F}\u{A0}\u{2028}\u{2029}\u{FEFF}\u{FFFE}\u{FFFF}\u{10FFFF}é😀日本';
		assert.equal(stringify({a: text}), `a: '${text}'\n`);
	});

	test('a lone surrogate throws', () => {
		for (const text of ['\u{D800}', '\u{DFFF}', 'a\u{D83D}', '\u{DE00}b']) {
			assert.throws(() => stringify({a: text}), {name: 'TypeError', message: /string containing a lone surrogate/v});
		}
	});

	test('a carriage return throws', () => {
		assert.throws(() => stringify({a: 'a\r\nb'}), {name: 'TypeError', message: /carriage return/v});
		assert.throws(() => stringify(['\r']), TypeError);
	});

	test('block strings are never written', () => {
		assert.equal(stringify(parse('a: \'\'\'\n\tx\n\ty\n\t\'\'\'')), 'a: "x\\ny"\n');
	});
});

suite('integers', () => {
	test('a bigint is an int', () => {
		assert.equal(stringify({a: 0n, b: -1n, c: 255n}), 'a: 0\nb: -1\nc: 255\n');
	});

	test('the int64 bounds', () => {
		assert.equal(stringify({a: (2n ** 63n) - 1n, b: -(2n ** 63n)}), 'a: 9223372036854775807\nb: -9223372036854775808\n');
	});

	test('outside int64 throws a RangeError', () => {
		assert.throws(() => stringify({a: 2n ** 63n}), {name: 'RangeError', message: /outside the 64-bit range/v});
		assert.throws(() => stringify({a: -(2n ** 63n) - 1n}), RangeError);
	});

	test('`integers: \'number\'` writes a safe integer number as an int', () => {
		assert.equal(stringify({
			a: 1, b: -0, c: 1.5, d: 2 ** 53, e: Number.MAX_SAFE_INTEGER, f: 1n,
		}, {integers: 'number'}), 'a: 1\nb: 0\nc: 1.5\nd: 9007199254740992.0\ne: 9007199254740991\nf: 1\n');
	});

	test('`integers: \'number\'` still writes infinity as a float', () => {
		assert.equal(stringify({a: Infinity}, {integers: 'number'}), 'a: infinity\n');
	});

	test('an unknown `integers` value throws', () => {
		// @ts-expect-error -- Deliberately an unknown option value.
		assert.throws(() => stringify({}, {integers: 'float'}), TypeError);
	});
});

suite('floats', () => {
	const cases = [
		[0, '0.0'],
		[-0, '0.0'],
		[1, '1.0'],
		[-1, '-1.0'],
		[30, '30.0'],
		[1.5, '1.5'],
		[0.1, '0.1'],
		[0.1 + 0.2, '0.30000000000000004'],
		[1e20, '100000000000000000000.0'],
		[1e21, '1e21'],
		[1.5e21, '1.5e21'],
		[-1e21, '-1e21'],
		[1e-6, '0.000001'],
		[1e-7, '1e-7'],
		[1.5e-7, '1.5e-7'],
		[123_456_789_012_345_680_000, '123456789012345680000.0'],
		[Number.MAX_VALUE, '1.7976931348623157e308'],
		[Number.MIN_VALUE, '5e-324'],
		[Number.EPSILON, '2.220446049250313e-16'],
		[Number.MAX_SAFE_INTEGER, '9007199254740991.0'],
		[2 ** 53, '9007199254740992.0'],
		[Math.PI, '3.141592653589793'],
		[Infinity, 'infinity'],
		[-Infinity, '-infinity'],
	];

	for (const [value, expected] of cases) {
		test(`${Object.is(value, -0) ? '-0' : value} is written as ${expected}`, () => {
			assert.equal(stringify({a: value}), `a: ${expected}\n`);
		});
	}

	test('NaN throws', () => {
		assert.throws(() => stringify({a: NaN}), {name: 'TypeError', message: /NaN/v});
		assert.throws(() => stringify([NaN]), TypeError);
	});

	test('the output never reads back as an int', () => {
		for (const value of [0, 1, 1e15, 1e20, 1e21, 1e300, -5]) {
			assert.equal(typeof (parse(stringify({a: value})) as {a: unknown}).a, 'number');
		}
	});
});

suite('instants', () => {
	test('a Temporal.Instant is written in UTC', () => {
		assert.equal(stringify({a: Temporal.Instant.from('2026-09-19T14:00:00+07:00')}), 'a: 2026-09-19T07:00:00Z\n');
	});

	test('the fraction drops trailing zeros and is left out when zero', () => {
		assert.equal(stringify({a: Temporal.Instant.from('2026-09-19T14:00:00.100Z')}), 'a: 2026-09-19T14:00:00.1Z\n');
		assert.equal(stringify({a: Temporal.Instant.from('2026-09-19T14:00:00.000Z')}), 'a: 2026-09-19T14:00:00Z\n');
		assert.equal(stringify({a: Temporal.Instant.from('2026-09-19T14:00:00.000000001Z')}), 'a: 2026-09-19T14:00:00.000000001Z\n');
	});

	test('a Date is written as an instant', () => {
		assert.equal(stringify({a: new Date('2026-09-19T14:00:00.250Z')}), 'a: 2026-09-19T14:00:00.25Z\n');
		assert.equal(stringify({a: new Date(0)}), 'a: 1970-01-01T00:00:00Z\n');
		assert.equal(stringify({a: new Date(-1)}), 'a: 1969-12-31T23:59:59.999Z\n');
	});

	test('an invalid Date throws', () => {
		assert.throws(() => stringify({a: new Date(NaN)}), {name: 'TypeError', message: /invalid Date/v});
	});

	test('an instant outside the years 0001 to 9999 throws', () => {
		assert.throws(() => stringify({a: Temporal.Instant.from('0000-12-31T23:59:59Z')}), {name: 'RangeError'});
		assert.throws(() => stringify({a: Temporal.Instant.from('+010000-01-01T00:00:00Z')}), RangeError);
		assert.throws(() => stringify({a: new Date(-62_135_596_800_001)}), RangeError);
		assert.equal(stringify({a: new Date(-62_135_596_800_000)}), 'a: 0001-01-01T00:00:00Z\n');
	});

	test('an instant before 1970 keeps its fraction', () => {
		assert.equal(stringify({a: new Temporal.Instant(-1n), b: new Temporal.Instant(-1_500_000_000n)}), 'a: 1969-12-31T23:59:59.999999999Z\nb: 1969-12-31T23:59:58.5Z\n');
	});

	test('the range bounds', () => {
		assert.equal(stringify({a: Temporal.Instant.from('0001-01-01T00:00:00Z'), b: Temporal.Instant.from('9999-12-31T23:59:59.999999999Z')}), 'a: 0001-01-01T00:00:00Z\nb: 9999-12-31T23:59:59.999999999Z\n');
	});

	test('a Temporal value that is not an instant throws', () => {
		assert.throws(() => stringify({a: Temporal.PlainDate.from('2026-09-19')}), {name: 'TypeError', message: /an instance of PlainDate/v});
		assert.throws(() => stringify({a: Temporal.Now.zonedDateTimeISO('UTC')}), TypeError);
	});
});

suite('durations', () => {
	test('a Temporal.Duration is written in canonical form', () => {
		assert.equal(stringify({a: Temporal.Duration.from({minutes: 90})}), 'a: 1h30m\n');
		assert.equal(stringify({a: Temporal.Duration.from({milliseconds: 1500})}), 'a: 1.5s\n');
		assert.equal(stringify({a: Temporal.Duration.from({hours: 1, nanoseconds: 1})}), 'a: 1h0.000000001s\n');
		assert.equal(stringify({a: Temporal.Duration.from({microseconds: 250})}), 'a: 0.00025s\n');
		assert.equal(stringify({a: Temporal.Duration.from({minutes: 1, milliseconds: 100})}), 'a: 1m0.1s\n');
		assert.equal(stringify({a: Temporal.Duration.from({minutes: -5})}), 'a: -5m\n');
		assert.equal(stringify({a: new Temporal.Duration()}), 'a: 0s\n');
	});

	test('the int64 bounds', () => {
		assert.equal(stringify({a: Temporal.Duration.from({seconds: 9_223_372_036, nanoseconds: 854_775_807})}), 'a: 2562047h47m16.854775807s\n');
		assert.equal(stringify({a: Temporal.Duration.from({seconds: -9_223_372_036, nanoseconds: -854_775_808})}), 'a: -2562047h47m16.854775808s\n');
		assert.throws(() => stringify({a: Temporal.Duration.from({seconds: 9_223_372_036, nanoseconds: 854_775_808})}), {name: 'RangeError'});
		assert.throws(() => stringify({a: Temporal.Duration.from({hours: 2_562_048})}), RangeError);
	});

	test('years, months, weeks, and days throw, because they are not a fixed length', () => {
		for (const unit of ['years', 'months', 'weeks', 'days']) {
			assert.throws(() => stringify({a: Temporal.Duration.from({[unit]: 1})}), {name: 'TypeError', message: /not a fixed length/v}, unit);
			assert.throws(() => stringify({a: Temporal.Duration.from({[unit]: -1})}), {name: 'TypeError', message: /not a fixed length/v}, unit);
		}
	});

	test('an object faking a Temporal.Duration throws', () => {
		assert.throws(() => stringify({a: Object.create(Temporal.Duration.prototype) as unknown}), {name: 'TypeError', message: 'Cannot serialize an object that claims to be a Temporal.Duration but is not one'});
	});
});

suite('other values', () => {
	test('booleans and null', () => {
		assert.equal(stringify({a: true, b: false, c: null}), 'a: true\nb: false\nc: null\n');
	});

	test('an undefined member is left out', () => {
		assert.equal(stringify({a: undefined, b: 1n, c: {d: undefined}}), 'b: 1\nc: {}\n');
	});

	test('undefined in an array throws', () => {
		assert.throws(() => stringify([1n, undefined]), {name: 'TypeError', message: 'Cannot serialize undefined in an array, at index 1'});
	});

	test('a hole in an array throws', () => {
		assert.throws(() => stringify([1n, , 2n]), {name: 'TypeError', message: /at index 1/v}); // eslint-disable-line no-sparse-arrays
	});

	test('an array is read up to the length it had at the start, as in JSON.stringify()', () => {
		const array: unknown[] = [];
		const grow = {
			get a() {
				array.push(grow);
				return 1n;
			},
		};

		array.push(grow);
		assert.equal(stringify(array), '[\n\t{\n\t\ta: 1\n\t}\n]\n');
	});

	test('unsupported values throw a TypeError that names them', () => {
		const cases: Array<[unknown, RegExp]> = [
			[() => {}, /a function/v], // eslint-disable-line @typescript-eslint/no-empty-function -- A function is the unsupported value under test.
			[Symbol('x'), /a symbol/v],
			[new Map(), /instance of Map/v],
			[new Set(), /instance of Set/v],
			[new (class Point {})(), /instance of Point/v], // eslint-disable-line @typescript-eslint/no-extraneous-class -- An instance of an empty class is the value under test.
			[/x/v, /instance of RegExp/v],
			[new Uint8Array(1), /instance of Uint8Array/v],
			[new String('x'), /instance of String/v], // eslint-disable-line no-new-wrappers, unicorn/new-for-builtins
			[Object.create(Object.create({}) as Record<string, unknown>), /an instance of Object/v],
		];

		for (const [value, message] of cases) {
			assert.throws(() => stringify({a: value}), {name: 'TypeError', message}, String(message));
		}
	});

	test('the error names the key', () => {
		assert.throws(() => stringify({outer: {inner: Symbol('x')}}), {message: 'Cannot serialize a symbol at key “inner”'});
	});

	test('a key that a terminal acts on is escaped in the error, not written raw', () => {
		// The key holds an 8-bit CSI control, which a terminal executes as an escape. It must not reach the message raw.
		const key = 'k\u{9B}31m';
		assert.throws(() => stringify({[key]: Symbol('x')}), {message: `Cannot serialize a symbol at key “k${String.raw`\u{9b}`}31m”`});
	});

	test('an object with a null prototype is a plain object', () => {
		const value = Object.create(null) as {a?: bigint};
		value.a = 1n;
		assert.equal(stringify(value), 'a: 1\n');
		assert.equal(stringify({nested: value}), 'nested: {\n\ta: 1\n}\n');
	});

	test('an object from another realm is a plain object', () => {
		const value = vm.runInNewContext('({a: 1n, b: [1n]})') as Record<string, unknown>;
		assert.equal(stringify(value), 'a: 1\nb: [\n\t1\n]\n');
	});

	test('toJSON is not called, so it is an unsupported function member', () => {
		assert.throws(() => stringify({a: {toJSON: () => 'x'}}), {message: 'Cannot serialize a function at key “toJSON”'}); // eslint-disable-line @typescript-eslint/naming-convention -- `toJSON` is the name under test.
	});

	test('a getter is read', () => {
		assert.equal(stringify({
			get a() {
				return 1n;
			},
		}), 'a: 1\n');
	});

	test('a getter is read once, so a top-level object that looks empty is written as it was read', () => {
		let reads = 0;
		const value = {
			get a() {
				reads++;
				return reads === 1 ? undefined : 1n;
			},
		};

		assert.equal(stringify(value), '{}\n');
		assert.equal(reads, 1);
	});

	test('a getter is read once in a nested object and an array', () => {
		let reads = 0;
		const getter = {
			get a() {
				reads++;
				return 1n;
			},
		};

		assert.equal(stringify({x: getter, y: [getter]}), 'x: {\n\ta: 1\n}\ny: [\n\t{\n\t\ta: 1\n\t}\n]\n');
		assert.equal(reads, 2);
		assert.equal(stringifyValue(getter), '{\n\ta: 1\n}');
		assert.equal(reads, 3);
	});

	test('a frozen object', () => {
		assert.equal(stringify(Object.freeze({a: Object.freeze([1n])})), 'a: [\n\t1\n]\n');
	});
});

suite('top-level value', () => {
	test('must be an object or an array', () => {
		for (const value of ['x', 1, 1n, true, null, undefined, Temporal.Now.instant(), new Date(), new Map()]) {
			// @ts-expect-error -- Deliberately not always an object.
			assert.throws(() => stringify(value), {name: 'TypeError', message: /top-level value must be an object or an array/v});
		}
	});

	test('the error names what it got', () => {
		// @ts-expect-error -- Deliberately not an object.
		assert.throws(() => stringify('x'), {message: 'The top-level value must be an object or an array, because a document is a collection. Got a string'});
		// @ts-expect-error -- Deliberately not an object.
		assert.throws(() => stringify(null), {message: /Got null$/v});
		// @ts-expect-error -- Deliberately not an object.
		assert.throws(() => stringify(undefined), {message: /Got undefined$/v});
		assert.throws(() => stringify(new Map()), {message: /Got an instance of Map$/v});
	});
});

suite('structure', () => {
	test('a circular reference throws', () => {
		const object: {a: bigint; self?: unknown} = {a: 1n};
		object.self = object;
		assert.throws(() => stringify(object), {name: 'TypeError', message: 'Cannot serialize a circular structure'});

		const array: unknown[] = [];
		array.push(array);
		assert.throws(() => stringify(array), {message: 'Cannot serialize a circular structure'});

		const deep: {a: {b: {c?: unknown}}} = {a: {b: {}}};
		deep.a.b.c = deep.a;
		assert.throws(() => stringify(deep), {message: 'Cannot serialize a circular structure'});
	});

	test('a shared reference that is not circular is written twice', () => {
		const shared = {x: 1n};
		assert.equal(stringify({a: shared, b: shared, c: [shared, shared]}), 'a: {\n\tx: 1\n}\nb: {\n\tx: 1\n}\nc: [\n\t{\n\t\tx: 1\n\t}\n\t{\n\t\tx: 1\n\t}\n]\n');
	});

	test('a failed serialization does not poison the next one', () => {
		const object: {a: {b?: unknown}} = {a: {}};
		object.a.b = object;
		assert.throws(() => stringify(object), TypeError);
		const fine = {a: {}};
		assert.equal(stringify({x: fine, y: fine}), 'x: {\n\ta: {}\n}\ny: {\n\ta: {}\n}\n');
	});

	test('100 levels of nesting are written', () => {
		let value: unknown[] = [];

		for (let index = 1; index < 100; index++) {
			value = [value];
		}

		assert.ok(stringify(value).startsWith('[\n'));
	});

	test('more than 100 levels throws a RangeError', () => {
		let value: unknown[] = [];

		for (let index = 0; index < 100; index++) {
			value = [value];
		}

		assert.throws(() => stringify(value), {name: 'RangeError', message: /nested more than 100 levels/v});
	});

	test('the top-level object counts as a level', () => {
		let value = {};

		for (let index = 1; index < 100; index++) {
			value = {a: value};
		}

		assert.ok(stringify(value).startsWith('a: {\n'));
		assert.throws(() => stringify({a: value}), RangeError);
	});

	test('the nesting limit matches the parser', () => {
		let value: unknown[] = [];

		for (let index = 1; index < 100; index++) {
			value = [value];
		}

		assert.equal(stringify(parse(stringify(value))), stringify(value));
	});
});

suite('objects that only claim to be a type', () => {
	test('a class instance faking an instant or a date is rejected rather than written as text that cannot be read back', () => {
		class FakeInstant {
			get [Symbol.toStringTag]() {
				return 'Temporal.Instant';
			}

			toString() {
				return 'x';
			}
		}

		class FakeDate {
			get [Symbol.toStringTag]() {
				return 'Date';
			}
		}

		assert.throws(() => stringify({a: new FakeInstant()}), {name: 'TypeError', message: 'Cannot serialize an object that claims to be a Temporal.Instant but is not one'});
		assert.throws(() => stringify({a: new FakeDate()}), {name: 'TypeError', message: 'Cannot serialize an object that claims to be a Date but is not one'});
	});

	test('a plain object with a tag is a plain object, at the top level and nested alike', () => {
		const value = {x: 1n, [Symbol.toStringTag]: 'Date'};
		assert.equal(stringify(value), 'x: 1\n');
		assert.equal(stringify({a: value}), 'a: {\n\tx: 1\n}\n');
	});
});

suite('values from another realm', () => {
	// A `Temporal` polyfill, needed before Node.js 26, is not in a new context.
	const skipTemporal = vm.runInNewContext('typeof Temporal') === 'undefined' && 'needs native Temporal';

	// eslint-disable-next-line node-test/no-skip-test
	test('a Date and a Temporal.Instant from a vm context', {skip: skipTemporal}, () => {
		assert.equal(stringify({a: vm.runInNewContext('new Date(0)') as Date, b: vm.runInNewContext('Temporal.Instant.from("2026-01-01T00:00:00Z")') as Temporal.Instant}), 'a: 1970-01-01T00:00:00Z\nb: 2026-01-01T00:00:00Z\n');
	});

	// eslint-disable-next-line node-test/no-skip-test
	test('a Temporal.Duration from a vm context', {skip: skipTemporal}, () => {
		assert.equal(stringify({a: vm.runInNewContext('Temporal.Duration.from({hours: 3, milliseconds: 5})') as Temporal.Duration}), 'a: 3h0.005s\n');
	});

	test('an invalid Date from a vm context', () => {
		assert.throws(() => stringify({a: vm.runInNewContext('new Date(Number.NaN)') as Date}), {message: 'Cannot serialize an invalid Date'});
	});
});

suite('stringifyValue', () => {
	test('a scalar, on one line', () => {
		assert.equal(stringifyValue(0.1 + 0.2), '0.30000000000000004');
		assert.equal(stringifyValue(1e21), '1e21');
		assert.equal(stringifyValue(-0), '0.0');
		assert.equal(stringifyValue(Infinity), 'infinity');
		assert.equal(stringifyValue(8080n), '8080');
		assert.equal(stringifyValue('it\'s'), '"it\'s"');
		assert.equal(stringifyValue(null), 'null');
	});

	test('a container, braced and over several lines, with no line feed at the end', () => {
		assert.equal(stringifyValue({b: 1n, a: [true]}), '{\n\tb: 1\n\ta: [\n\t\ttrue\n\t]\n}');
		assert.equal(stringifyValue({b: 1n, a: [true]}, {canonical: true}), '{\n\ta: [\n\t\ttrue\n\t]\n\tb: 1\n}');
		assert.equal(stringifyValue({}), '{}');
		assert.equal(stringifyValue([]), '[]');
	});

	test('the integers option', () => {
		assert.equal(stringifyValue(8080), '8080.0');
		assert.equal(stringifyValue(8080, {integers: 'number'}), '8080');
		assert.throws(() => stringifyValue(1, {integers: 'string' as 'number'}), TypeError);
	});

	test('a value that cannot be written', () => {
		assert.throws(() => stringifyValue(undefined), {name: 'TypeError', message: 'Cannot serialize undefined'});
		assert.throws(() => stringifyValue(NaN), TypeError);
		assert.throws(() => stringifyValue(2n ** 63n), RangeError);
	});

	test('the nesting limit counts the value as the first level', () => {
		const nest = (depth: number): unknown => depth === 0 ? 1n : [nest(depth - 1)];
		assert.equal(stringifyValue(nest(100)).length > 0, true);
		assert.throws(() => stringifyValue(nest(101)), RangeError);
	});

	test('is what stringify() writes for a member, for every value of the conformance suite', () => {
		const root = path.join(import.meta.dirname, 'conformance', 'valid');
		const files = fs.readdirSync(root, {recursive: true, encoding: 'utf8'}).filter(file => file.endsWith('.soml') && !/\.(?:canonical|formatted)\.soml$/v.test(file));

		for (const file of files) {
			const document = parse(fs.readFileSync(path.join(root, file), 'utf8'));

			for (const value of Array.isArray(document) ? document : Object.values(document)) {
				assert.equal(stringify({a: value}), `a: ${stringifyValue(value)}\n`, file);
			}
		}
	});
});
