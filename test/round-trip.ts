/*
Property tests. Every generator is seeded, and a failure message includes the seed and the input, so it can be reproduced.
*/
import {test, suite} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
	parse,
	stringify,
	formatFloat,
	formatString,
	formatKey,
	formatBlockString,
	ParseError,
	type Value,
} from '../source/index.ts';
import {
	normalize,
	durationNanoseconds,
	createRandom,
	randomDocument,
	randomDuration,
	randomFloat,
	randomInstant,
	randomInteger,
	randomString,
	type Random,
} from './helpers.ts';

// eslint-disable-next-line no-control-regex, regexp/no-control-character -- The raw control characters that a document cannot hold.
const RAW_CONTROL_CHARACTERS = /[\u{0}-\u{8}\u{B}-\u{1F}\u{7F}]/gv;

test('every representable Unicode scalar survives escapes, canonical and block-string serialization', () => {
	const chunks: string[] = [];
	for (let start = 0; start <= 0x10_FF_FF; start += 4096) {
		const codePoints: number[] = [];
		for (let codePoint = start; codePoint < start + 4096; codePoint++) {
			if (codePoint !== 13 && (codePoint < 0xD8_00 || codePoint > 0xDF_FF)) {
				codePoints.push(codePoint);
			}
		}

		const chunk = String.fromCodePoint(...codePoints);
		const escapes = codePoints.map(codePoint => String.raw`\u{${codePoint.toString(16)}}`).join('');
		assert.deepEqual(parse(`value: "${escapes}"`), {value: chunk});
		assert.deepEqual(parse(`"${escapes}": true`), {[chunk]: true});
		chunks.push(chunk);
	}

	const value = chunks.join('');
	const expected = {value};
	const canonical = stringify(expected, {canonical: true});
	assert.deepEqual(parse(canonical), expected);
	assert.deepEqual(parse(new TextEncoder().encode(canonical)), expected);
	assert.deepEqual(parse(`value: ${formatBlockString(value)}`), expected);
});

test('escaping preserves Unicode pairs and literal dollar signs across long-string boundaries', () => {
	const ending = '😀\u{0}\u{7}\t\n"\\\'$&';
	const encodedEnding = String.raw`😀\u{0}\u{7}\t\n\"\\'$&`;
	for (const length of [32_766, 32_767, 32_768, 65_535, 65_536]) {
		const prefix = 'x'.repeat(length);
		const value = prefix + ending;
		const expected = `"${prefix}${encodedEnding}"`;
		for (const style of ['auto', 'escaped'] as const) {
			const text = formatString(value, {style});
			assert.equal(text, expected);
			assert.deepEqual(parse(`value: ${text}`), {value});
		}

		assert.equal(formatKey(value), expected);
		assert.deepEqual(parse(`${formatKey(value)}: true`), {[value]: true});
	}
});

suite('round trip', () => {
	test('parse(stringify(value)) equals value, and stringify is a fixed point', () => {
		for (let seed = 1; seed <= 3000; seed++) {
			const value = randomDocument(createRandom(seed));
			const text = stringify(value);
			let parsed;

			try {
				parsed = parse(text);
			} catch (error) {
				assert.fail(`seed ${seed}: output did not parse: ${(error as Error).message}\n${text}`);
			}

			assert.deepEqual(normalize(parsed), normalize(value), `seed ${seed}`);
			assert.equal(stringify(parsed), text, `seed ${seed}`);
			assert.equal(stringify(parsed, {canonical: true}), stringify(value, {canonical: true}), `seed ${seed}`);
		}
	});

	test('every float survives a round trip bit for bit', () => {
		const random = createRandom(42);

		for (let index = 0; index < 20_000; index++) {
			const value = randomFloat(random);
			const text = stringify({a: value});
			assert.ok(Object.is((parse(text) as {a: number}).a, value), `${value} became ${text}`);
		}
	});

	test('binary64 exponent boundaries and adjacent values preserve their value and numeric type', () => {
		const view = new DataView(new ArrayBuffer(8));
		const fractionLimit = 2n ** 52n;
		const patterns = Array.from({length: 0x8_00}, (_, exponent) => [0n, 1n, fractionLimit / 2n, fractionLimit - 2n, fractionLimit - 1n].flatMap(fraction => {
			const positive = (BigInt(exponent) * fractionLimit) + fraction;
			return [positive, positive + (2n ** 63n)];
		})).flat();

		for (const bits of patterns) {
			view.setBigUint64(0, bits);
			const value = view.getFloat64(0);
			const label = bits.toString(16);

			if (Number.isNaN(value)) {
				assert.throws(() => formatFloat(value), TypeError, label);
				continue;
			}

			const normalized = value === 0 ? 0 : value;
			const literal = formatFloat(value);
			assert.deepEqual(parse(`[${literal}]`), [normalized], label);
			assert.deepEqual(parse(stringify([value])), [normalized], label);
			assert.deepEqual(parse(stringify([value], {integers: 'number'})), [Number.isSafeInteger(value) ? BigInt(value) : normalized], label);

			if (!Number.isFinite(value)) {
				continue;
			}

			// JSON uses the same canonical binary64 decimal spelling, except SOML omits positive exponent signs and distinguishes floats from ints.
			const json = JSON.stringify(value).replace('e+', 'e');
			assert.equal(literal, /[.e]/v.test(json) ? json : `${json}.0`, label);
		}
	});

	test('every int64 survives a round trip', () => {
		const random = createRandom(7);

		for (let index = 0; index < 20_000; index++) {
			const value = randomInteger(random);
			assert.equal((parse(stringify({a: value})) as {a: bigint}).a, value);
		}
	});

	test('every instant survives a round trip', () => {
		const random = createRandom(9);

		for (let index = 0; index < 5000; index++) {
			const value = randomInstant(random);
			assert.ok((parse(stringify({a: value})) as {a: Temporal.Instant}).a.equals(value), value.toString());
		}
	});

	test('random instants cover every millennium in the supported range', () => {
		const random = createRandom(9);
		const millennia = new Set<number>();
		for (let index = 0; index < 1000; index++) {
			const {year} = randomInstant(random).toZonedDateTimeISO('UTC');
			assert.ok(year >= 1);
			assert.ok(year <= 9999);
			millennia.add(Math.floor(year / 1000));
		}

		assert.deepEqual([...millennia].toSorted((first, second) => first - second), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	test('every duration survives a round trip', () => {
		const random = createRandom(13);

		for (let index = 0; index < 5000; index++) {
			const value = randomDuration(random);
			assert.equal(durationNanoseconds((parse(stringify({a: value})) as {a: Temporal.Duration}).a), durationNanoseconds(value), value.toString());
		}
	});

	test('every string survives a round trip as a value and as a key', () => {
		const random = createRandom(11);

		for (let index = 0; index < 20_000; index++) {
			const value = randomString(random, 20);
			const parsed = parse(stringify({[value]: value})) as Record<string, unknown>;
			assert.deepEqual(Object.keys(parsed), [value]);
			assert.equal(parsed[value], value);
		}
	});

	test('every single scalar value survives as a value and as a key', () => {
		for (let codePoint = 0; codePoint <= 0x10_FF_FF; codePoint += codePoint < 0x3_00_00 ? 1 : 0x1_01) {
			if (codePoint === 0x0D || (codePoint >= 0xD8_00 && codePoint <= 0xDF_FF)) {
				continue;
			}

			const character = String.fromCodePoint(codePoint);
			const parsed = parse(stringify({[character]: character})) as Record<string, unknown>;
			assert.equal(parsed[character], character, `U+${codePoint.toString(16)}`);
		}
	});

	test('a value written with integers: \'number\' reads back with integers: \'number\'', () => {
		for (let seed = 1; seed <= 500; seed++) {
			const random = createRandom(seed);
			const value = {
				int: random.integer(-1_000_000, 1_000_000),
				float: random.integer(-1000, 1000) + 0.5,
				list: Array.from({length: 3}, () => random.integer(0, 100)),
			};

			assert.deepEqual(parse(stringify(value, {integers: 'number'}), {integers: 'number'}), value);
		}
	});
});

suite('differential against JSON', () => {
	/*
	JSON that is also a document: no control characters JSON would escape as \uXXXX, \b, \f, or \r, and no number written with an exponent sign.
	*/
	function randomJsonValue(random: Random, depth: number): Value<number> {
		switch (random.integer(0, depth > 3 ? 3 : 5)) {
			case 0: {
				return randomString(random).replaceAll(RAW_CONTROL_CHARACTERS, 'x');
			}

			case 1: {
				const number = random.next() < 0.5 ? random.integer(-1e9, 1e9) : randomFloat(random);

				// JSON writes an integral float such as 2 ** 60 without a fraction, which reads as an int that `integers: 'number'` rejects.
				return Number.isFinite(number) && Math.abs(number) > Number.MAX_SAFE_INTEGER ? 0.25 : number;
			}

			case 2: {
				return random.pick([true, false, null]);
			}

			case 3: {
				return random.integer(-100, 100) / 8;
			}

			case 4: {
				return Array.from({length: random.integer(0, 4)}, () => randomJsonValue(random, depth + 1));
			}

			default: {
				return Object.fromEntries(Array.from({length: random.integer(0, 4)}, () => [randomString(random, 5).replaceAll(RAW_CONTROL_CHARACTERS, 'x'), randomJsonValue(random, depth + 1)]));
			}
		}
	}

	test('JSON.stringify output parses to what JSON.parse returns', () => {
		let compared = 0;

		for (let seed = 1; seed <= 3000; seed++) {
			const random = createRandom(seed);
			const value = random.boolean() ? randomJsonValue(random, 4) : [randomJsonValue(random, 1)];
			const json = JSON.stringify(typeof value === 'object' && value !== null ? value : [value], undefined, random.pick([undefined, 1, '\t']));

			// JSON writes 1e21 as 1e+21, and Infinity as null. Neither is a difference worth comparing.
			if (/\de\+/v.test(json)) {
				continue;
			}

			assert.deepEqual(parse(json, {integers: 'number'}), JSON.parse(json), `seed ${seed}: ${json}`);
			compared++;
		}

		assert.ok(compared > 2500);
	});

	test('JSON integers are ints and JSON fractions are floats', () => {
		assert.deepEqual(parse('{"a": 1, "b": 1.5, "c": [-0.5, 10]}'), {a: 1n, b: 1.5, c: [-0.5, 10n]});
	});
});

suite('fuzz', () => {
	const TOKENS = [ // eslint-disable-line @typescript-eslint/naming-convention -- A constant table, named like the module-level ones.
		'{',
		'}',
		'[',
		']',
		',',
		':',
		'\n',
		' ',
		'\t',
		'#c\n',
		'/* c */',
		'/*\n*/',
		'\'x\'',
		'"y"',
		'\'\'\'\n',
		'"""\n',
		'\'\'\'',
		'\'',
		'"',
		'\\',
		String.raw`"\u{41}"`,
		String.raw`"\q"`,
		'1',
		'-1',
		'0',
		'1.5',
		'1e5',
		'0xFF',
		'0o7',
		'0b1',
		'1_0',
		'true',
		'false',
		'null',
		'infinity',
		'-infinity',
		'a',
		'a.b',
		'404',
		'\'k k\'',
		'2026-01-01T00:00:00Z',
		'2026-01-01',
		'T',
		'Z',
		'.',
		'-',
		'+',
		'_',
		'e',
		'\u{A0}',
		'\u{2028}',
		'😀',
		'\u{FEFF}',
		'\r',
		'\u{0}',
	];

	function assertParseError(error: unknown, input: string | Uint8Array, label: string): void {
		if (!(error instanceof ParseError)) {
			assert.fail(`${label}: threw ${(error as Error).name} instead of ParseError: ${(error as Error).message}\n${JSON.stringify(input)}`);
		}

		assert.ok(Number.isSafeInteger(error.line), label);
		assert.ok(error.line >= 1, label);
		assert.ok(Number.isSafeInteger(error.column), label);
		assert.ok(error.column >= 1, label);
		assert.ok(error.offset >= 0, label);
		assert.ok(error.offset <= (typeof input === 'string' ? input.length : Infinity), label);
	}

	function assertParsesOrThrowsParseError(input: string | Uint8Array, label: string) {
		let value;

		try {
			value = parse(input);
		} catch (error) {
			assertParseError(error, input, label);
			return;
		}

		// Whatever parses must serialize, and read back as the same value.
		const text = stringify(value);
		assert.deepEqual(normalize(parse(text)), normalize(value), `${label}: ${JSON.stringify(input)}`);
	}

	test('token soup either parses or throws a ParseError', () => {
		for (let seed = 1; seed <= 20_000; seed++) {
			const random = createRandom(seed);
			const input = Array.from({length: random.integer(1, 25)}, () => random.pick(TOKENS)).join('');
			assertParsesOrThrowsParseError(input, `seed ${seed}`);
		}
	});

	test('structured token soup reaches deeper states', () => {
		for (let seed = 1; seed <= 10_000; seed++) {
			const random = createRandom(seed);
			const prefix = random.pick(['a: ', '[', '{a: ', 'a: {b: [', '[{', 'a: \'\'\'\n', 'a: """\n', '']);
			const input = prefix + Array.from({length: random.integer(1, 15)}, () => random.pick(TOKENS)).join('');
			assertParsesOrThrowsParseError(input, `seed ${seed}`);
		}
	});

	/*
	Deletes, inserts, or replaces one character at a random position.
	*/
	function mutate(characters: string[], random: Random): void {
		const position = random.integer(0, characters.length);

		switch (random.integer(0, 2)) {
			case 0: {
				characters.splice(position, 1);
				return;
			}

			case 1: {
				characters.splice(position, 0, random.pick(TOKENS));
				return;
			}

			default: {
				characters[position] = random.pick(TOKENS);
			}
		}
	}

	test('mutations of the conformance documents either parse or throw a ParseError', () => {
		const root = path.join(import.meta.dirname, 'conformance', 'valid');
		const documents = fs.readdirSync(root, {encoding: 'utf8', recursive: true})
			.filter(file => file.endsWith('.soml'))
			.map(file => fs.readFileSync(path.join(root, file), 'utf8'));

		const random = createRandom(1234);

		for (let index = 0; index < 20_000; index++) {
			const source = random.pick(documents);
			const characters = [...source];
			const mutations = random.integer(1, 3);

			for (let mutation = 0; mutation < mutations; mutation++) {
				mutate(characters, random);
			}

			assertParsesOrThrowsParseError(characters.join(''), `mutation ${index}`);
		}
	});

	test('random bytes either parse or throw a ParseError', () => {
		const random = createRandom(99);

		for (let index = 0; index < 10_000; index++) {
			const bytes = Uint8Array.from({length: random.integer(0, 40)}, () => random.next() < 0.7 ? random.pick([0x7B, 0x7D, 0x5B, 0x5D, 0x2C, 0x3A, 0x0A, 0x20, 0x61, 0x31, 0x27, 0x22, 0x2D, 0x2F, 0x23]) : random.integer(0, 255));
			assertParsesOrThrowsParseError(bytes, `bytes ${index}`);
		}
	});
});
