import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parse, ParseError} from '../source/index.ts';

test('invalid byte diagnostics ignore an overridden subarray method', () => {
	const prefix = new TextEncoder().encode('a: \'é😀');
	const bytes = new Uint8Array([...prefix, 0xFF]);
	Object.defineProperty(bytes, 'subarray', {
		value() {
			throw new Error('subarray must not be called');
		},
	});
	assert.throws(() => parse(bytes), {
		name: 'ParseError', reason: 'Invalid UTF-8 byte 0xFF', offset: 7, column: 7,
	});
});

test('invalid byte diagnostics ignore a forged own length property', () => {
	const bytes = new Uint8Array([0x61, 0x3A, 0x20, 0x31, 0xFF]);
	Object.defineProperty(bytes, 'length', {value: 0});
	assert.throws(() => parse(bytes), {name: 'ParseError', reason: 'Invalid UTF-8 byte 0xFF', offset: 4});
});

test('invalid byte diagnostics do not invoke typed array species constructors', () => {
	class Bytes extends Uint8Array {
		static get [Symbol.species]() {
			throw new Error('species must not be read');
		}
	}

	assert.throws(() => parse(new Bytes([0x61, 0x3A, 0x20, 0x31, 0xE2, 0x82])), {name: 'ParseError', reason: 'Incomplete UTF-8 sequence at the end of the input', offset: 4});
});

test('UTF-8 decoder recovery keeps incomplete bytes separate from later inputs', () => {
	for (const tail of [[0xE2], [0xF0, 0x90], [0xED, 0xA0], [0xFF]]) {
		assert.throws(() => parse(new Uint8Array([0x61, 0x3A, 0x20, 0x31, ...tail])), ParseError);
		assert.deepEqual(parse(new TextEncoder().encode('a: \'€😀\'')), {a: '€😀'});
	}
});

test('fast decimal parsing remains exact at adjacent sixteen-digit safe integer bounds', () => {
	for (const integer of [1_000_000_000_000_000n, 9_007_199_254_740_990n, 9_007_199_254_740_991n]) {
		for (const value of [integer, -integer]) {
			assert.deepEqual(parse(`a: ${value}`), {a: value});
			assert.deepEqual(parse(`a: ${value}`, {integers: 'number'}), {a: Number(value)});
		}
	}

	for (const value of [9_007_199_254_740_992n, 9_007_199_254_740_993n]) {
		assert.deepEqual(parse(`a: ${value}`), {a: value});
		assert.throws(() => parse(`a: ${value}`, {integers: 'number'}), {reason: /cannot be represented exactly/v});
	}
});

test('sixteen-character float fast paths retain rounding and zero semantics', () => {
	for (const text of ['12345678901234.5', '-12345678901234.5', '0.00000000000001', '-0.00000000000001', '-0.0000000000000']) {
		const value = Number(text);
		assert.deepEqual(parse(`a: ${text}`), {a: value === 0 ? 0 : value});
	}
});

test('radix significant-digit limits preserve leading-zero padding and exact int64 bounds', () => {
	for (const radix of [2, 8, 16]) {
		const prefix = radix === 2 ? '0b' : (radix === 8 ? '0o' : '0x');
		for (const value of [0n, 1n, (2n ** 63n) - 1n]) {
			const digits = value.toString(radix).toUpperCase();
			assert.deepEqual(parse(`a: ${prefix}${'0_'.repeat(70)}${digits}`), {a: value});
		}

		assert.throws(() => parse(`a: ${prefix}${(2n ** 63n).toString(radix).toUpperCase()}`), {reason: /outside the 64-bit range/v});
		assert.throws(() => parse(`a: ${prefix}1${'0'.repeat(80)}`), {reason: /outside the 64-bit range/v});
	}
});

test('duration fractions discard trailing zero groups before removing separators', () => {
	for (const [text, value] of [['1.0_0s', 'PT1S'], ['0.0_0_1_0_0s', 'PT0.001S'], ['-0.0_1_0_0s', '-PT0.01S'], ['0.0_0_0_0_0_0_0_0_1_0_0s', 'PT0.000000001S']]) {
		assert.equal((parse(`a: ${text}`) as {a: Temporal.Duration}).a.toString(), value);
	}

	assert.throws(() => parse('a: -0.0_0s'), {reason: /before zero/v});
	assert.throws(() => parse('a: 0.0_0_0_0_0_0_0_0_0_1_0s'), {reason: /whole number of nanoseconds/v});
});

test('a long duration fraction with separators and trailing zeros stays exact', () => {
	assert.equal((parse(`a: 0.1_${'0_'.repeat(50_000)}0s`) as {a: Temporal.Duration}).a.toString(), 'PT0.1S');
});

test('trivia dispatch preserves separators outside block comments', () => {
	assert.deepEqual(parse('[1# first\n2/* inside\ncomment */,3]'), [1n, 2n, 3n]);
	assert.throws(() => parse('[1/* inside\ncomment */2]'), {reason: /inside a block comment does not separate/v});
	assert.throws(() => parse('[1// comment]'), {reason: /comment starts with/v});
});

test('instant parsing retains submillisecond fractions and offset crossings', () => {
	for (const [text, value] of [['1970-01-01T00:00:01+00:00', 1_000_000_000n], ['1970-01-01T01:00:00.000000001+01:00', 1n], ['1969-12-31T23:59:59.999999999Z', -1n]]) {
		assert.equal((parse(`a: ${text}`) as {a: Temporal.Instant}).a.epochNanoseconds, value);
	}
});

test('number diagnostic prefixes keep signs and invalid radix digits distinct', () => {
	for (const [text, reason] of [['-0xFF', /cannot have a sign/v], ['0o8', /Invalid octal digit “8”/v], ['0b2', /Invalid binary digit “2”/v], ['0xG', /Invalid hexadecimal digit “G”/v]]) {
		assert.throws(() => parse(`a: ${text}`), {reason});
	}
});

test('keyword diagnostics keep words with following text as quoted strings', () => {
	for (const [text, reason] of [['Yes', /Booleans/v], ['NONE', /Null is written/v], ['INF', /Infinity is written/v], ['Yes please', /string value must be quoted/v], ['None available', /string value must be quoted/v]]) {
		assert.throws(() => parse(`a: ${text}`), {reason});
	}
});
