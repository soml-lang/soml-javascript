import {test, suite} from 'node:test';
import assert from 'node:assert/strict';
import {
	parse,
	stringify,
	stringifyValue,
	formatFloat,
	formatKey,
	formatString,
	formatBlockString,
	compareKeys,
} from '../source/index.ts';

suite('serializer runtime input boundaries', () => {
	const wrongNumbers = [undefined, null, true, false, 1n, '', '1', '1\ninjected: true', {}, [], Symbol('number')];
	for (const [index, value] of wrongNumbers.entries()) {
		test(`formatFloat rejects non-number input ${index}`, () => {
			// @ts-expect-error -- Exercise the public JavaScript runtime boundary.
			assert.throws(() => formatFloat(value), TypeError);
		});
	}

	test('formatFloat does not coerce an object into document text', () => {
		let calls = 0;
		const value = {
			toString() {
				calls++;
				return '1\ninjected: true';
			},
		};
		// @ts-expect-error -- Exercise the public JavaScript runtime boundary.
		assert.throws(() => formatFloat(value), TypeError);
		assert.equal(calls, 0);
	});

	test('formatKey rejects an object spoofing a bare string', () => {
		const value = {length: 0, charCodeAt: () => NaN};
		// @ts-expect-error -- Exercise the public JavaScript runtime boundary.
		assert.throws(() => formatKey(value), TypeError);
	});
});

suite('array holes cannot import prototype values', () => {
	for (const position of [0, 1, 2]) {
		for (const entryPoint of ['document', 'value'] as const) {
			test(`${entryPoint} rejects a hole at index ${position} with an inherited value`, () => {
				const value = [1n, 2n, 3n];
				Reflect.deleteProperty(value, position);
				const prototype = Object.create(Array.prototype, {[position]: {value: 99n}}) as Record<string, unknown>;
				Object.setPrototypeOf(value, prototype);
				assert.throws(() => entryPoint === 'document' ? stringify(value) : stringifyValue(value), {name: 'TypeError', message: `Cannot serialize undefined in an array, at index ${position}`});
			});
		}
	}

	test('an inherited array accessor is never evaluated for a hole', () => {
		let calls = 0;
		const prototype = Object.create(Array.prototype, {
			0: {
				get() {
					calls++;
					return 99n;
				},
			},
		}) as Record<string, unknown>;
		const value = [1n];
		Reflect.deleteProperty(value, 0);
		Object.setPrototypeOf(value, prototype);
		assert.throws(() => stringify(value), TypeError);
		assert.equal(calls, 0);
	});
});

suite('escaping across bounded output chunks', () => {
	const characters = [
		['null', '\u{0}', String.raw`\u{0}`],
		['bell', '\u{7}', String.raw`\u{7}`],
		['tab', '\t', String.raw`\t`],
		['line feed', '\n', String.raw`\n`],
		['escape', '\u{1B}', String.raw`\u{1b}`],
		['unit separator', '\u{1F}', String.raw`\u{1f}`],
		['delete', '\u{7F}', String.raw`\u{7f}`],
		['double quote', '"', String.raw`\"`],
		['backslash', '\\', String.raw`\\`],
	] as const;
	for (const [name, character, escaped] of characters) {
		for (const offset of [32_767, 32_768, 32_769, 65_535, 65_536]) {
			test(`${name} at offset ${offset} remains one complete escape`, () => {
				const prefix = 'x'.repeat(offset);
				const value = `${prefix}${character}😀suffix`;
				const text = formatString(value, {style: 'escaped'});
				assert.equal(text, `"${prefix}${escaped}😀suffix"`);
				assert.deepEqual(parse(`value: ${text}`), {value});
			});
		}
	}
});

suite('canonical key comparison at Unicode boundaries', () => {
	const pairs = [
		['', 'a'],
		['a', 'aa'],
		['aa', 'ab'],
		['z', 'é'],
		['\u{7F}', '\u{80}'],
		['\u{D7FF}', '\u{E000}'],
		['\u{E000}', '\u{FFFF}'],
		['\u{FFFF}', '\u{10000}'],
		['\u{10000}', '\u{103FF}'],
		['\u{103FF}', '\u{10400}'],
		['\u{1FFFF}', '\u{20000}'],
		['\u{FFFFF}', '\u{100000}'],
		['\u{100000}', '\u{10FFFF}'],
		['prefix\u{FFFF}', 'prefix\u{10000}'],
		['prefix\u{10000}', 'prefix\u{10000}a'],
		['😀a', '😀b'],
		['😀', '😁'],
		['☃', '😀'],
		['a😀', 'b'],
		['a\u{10FFFF}', 'a\u{10FFFF}a'],
	] as const;
	for (const [left, right] of pairs) {
		test(`canonical order of ${JSON.stringify(left)} and ${JSON.stringify(right)}`, () => {
			assert.ok(compareKeys(left, right) < 0);
			assert.ok(compareKeys(right, left) > 0);
			assert.equal(compareKeys(left, left), 0);
			assert.equal(compareKeys(right, right), 0);
			assert.equal(stringify({[right]: 2n, [left]: 1n}, {canonical: true}), `${formatKey(left)}: 1\n${formatKey(right)}: 2\n`);
		});
	}
});

suite('literal block delimiter collisions', () => {
	const cases = [
		['short leading quote', '\'content', 3],
		['two leading quotes', '\'\'content', 3],
		['three leading quotes', '\'\'\'content', 4],
		['four leading quotes', '\'\'\'\'content', 5],
		['three quotes alone', '\'\'\'', 4],
		['four quotes alone', '\'\'\'\'', 5],
		['space before quotes', ' \'\'\'content', 4],
		['tab before quotes', '\t\'\'\'content', 4],
		['mixed indentation before quotes', ' \t \'\'\'content', 4],
		['quotes on second line', 'first\n\'\'\'second', 4],
		['quotes on final line', 'first\n\'\'\'\'', 5],
		['longest run first', '\'\'\'\'\'first\n\'\'\'second', 6],
		['longest run last', '\'\'\'first\n\'\'\'\'\'second', 6],
		['internal quotes cannot close', 'before\'\'\'\'\'after', 3],
		['non-ASCII whitespace is content', '\u{A0}\'\'\'content', 3],
	] as const;
	for (const [name, value, length] of cases) {
		test(name, () => {
			const delimiter = '\''.repeat(length);
			const text = formatBlockString(value);
			assert.equal(text, `${delimiter}\n${value}\n${delimiter}`);
			assert.deepEqual(parse(`value: ${text}`), {value});
		});
	}
});

suite('number integers preserve their representable boundaries', () => {
	const cases = [
		[Number.MIN_SAFE_INTEGER, '-9007199254740991'],
		[Number.MIN_SAFE_INTEGER + 1, '-9007199254740990'],
		[-1, '-1'],
		[-0, '0'],
		[0, '0'],
		[1, '1'],
		[Number.MAX_SAFE_INTEGER - 1, '9007199254740990'],
		[Number.MAX_SAFE_INTEGER, '9007199254740991'],
		[Number.MIN_SAFE_INTEGER - 1, '-9007199254740992.0'],
		[Number.MAX_SAFE_INTEGER + 1, '9007199254740992.0'],
	] as const;
	for (const [value, expected] of cases) {
		test(`${Object.is(value, -0) ? '-0' : value} is written as ${expected}`, () => {
			assert.equal(stringifyValue(value, {integers: 'number'}), expected);
			assert.equal(stringify({value}, {integers: 'number'}), `value: ${expected}\n`);
			assert.deepEqual(parse(`value: ${expected}`, {integers: 'number'}), {value: value === 0 ? 0 : value});
		});
	}
});
