import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	parse,
	parseTree,
	evaluate,
	parseForEditor,
} from '../source/index.ts';
import {findNumberEnd} from '../source/shared.ts';

test('number boundaries retain every ASCII token character and stop before Unicode code units', () => {
	const token = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_.:+-';
	for (const ending of [' ', '\t', '\n', ',', ']', '}', '#', '/', '😀', '\u{10000}', '\u{E000}', '\u{212A}', '\u{17F}']) {
		const source = `prefix: ${token}${ending}after`;
		assert.equal(findNumberEnd(source, 8), 8 + token.length);
	}

	// Alternate matches with EOF, where a failed global regex search resets its position.
	assert.equal(findNumberEnd(`a: ${token}`, 3), 3 + token.length);
	assert.equal(findNumberEnd('b: 1s, c: 2ms', 10), 13);
	assert.equal(findNumberEnd('b: 1s, c: 2ms', 3), 5);
});

test('numeric values report an adjacent astral character at its first surrogate', () => {
	for (const value of ['0xFF', '1_000', '1.25e-3', '1ms']) {
		const source = `value: ${value}😀`;
		const expected = {offset: 7 + value.length, reason: 'Unexpected “😀” after a value'};
		assert.throws(() => parse(source), expected);
		assert.throws(() => parseTree(source), expected);
		assert.deepEqual(parseForEditor(source).diagnostics[0]?.range, [expected.offset, expected.offset + 2]);
	}
});

test('native boundaries handle multi-million-character tokens without regex stack growth', () => {
	const digits = `0.${'0'.repeat(10_000_000)}`;
	assert.equal(findNumberEnd(digits, 0), digits.length);
	assert.equal(findNumberEnd(`${digits}😀`, 0), digits.length);
	assert.throws(() => parse(`value: 1${'h'.repeat(10_000_000)}`), {reason: /is not a unit/v});
});

test('number-token scans preserve duration units, part boundaries, and ASCII-only diagnostics', () => {
	const source = '[1h2m3s4ms5us6ns, -90m, 1.25h, 0s]';
	const expected = ['PT1H2M3.004005006S', '-PT1H30M', 'PT1H15M', 'PT0S'];
	for (const values of [parse(source), evaluate(parseTree(source))]) {
		assert.ok(Array.isArray(values));
		assert.deepEqual(values.map(value => (value as Temporal.Duration).toString()), expected);
	}

	assert.deepEqual(parseForEditor(source).diagnostics, []);
	for (const unit of ['ſ', 'K']) {
		assert.throws(() => parse(`value: 1s${unit}`), {reason: `Unexpected “${unit}” after a value`});
	}

	assert.throws(() => parse('value: 1MS'), {reason: /units are lowercase: ms/v});
	assert.throws(() => parse('value: 1hms'), {reason: /“hms” is not a unit/v});
});
