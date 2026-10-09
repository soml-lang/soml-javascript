import {suite, test} from 'node:test';
import assert from 'node:assert/strict';
import {
	parse,
	parseTree,
	getNodeAtPath,
	ParseError,
} from '../source/index.ts';
import {isPath} from '../source/tree.ts';

suite('path array ownership', () => {
	test('an inherited index cannot fill a sparse path', () => {
		const path: string[] = [];
		path.length = 1;
		Object.setPrototypeOf(path, Object.assign(Object.create(Array.prototype) as Record<string, unknown>, {0: 'safe'}));
		assert.equal(isPath(path), false);
		assert.throws(() => getNodeAtPath(parseTree('safe: true'), path), TypeError);
	});

	test('a sparse path never reads an inherited index getter', () => {
		const path: string[] = [];
		path.length = 1;
		const prototype = Object.create(Array.prototype) as Record<string, unknown>;
		Object.defineProperty(prototype, '0', {
			get() {
				throw new Error('The inherited getter must not be read');
			},
		});
		Object.setPrototypeOf(path, prototype);
		assert.equal(isPath(path), false);
	});
});

suite('UTF-8 byte classification', () => {
	const prefix = new TextEncoder().encode('first: 1\nsecond: \'é😀');

	// Every high-bit byte is either a legal sequence lead, a continuation, or an illegal lead. Testing the full byte range catches holes between the UTF-8 boundary conditions.
	for (let byte = 0x80; byte <= 0xFF; byte++) {
		const hexadecimal = byte.toString(16).toUpperCase();
		test(`a final byte 0x${hexadecimal} has the correct UTF-8 classification`, () => {
			const bytes = new Uint8Array(prefix.length + 1);
			bytes.set(prefix);
			bytes[prefix.length] = byte;
			assert.throws(() => parse(bytes), {
				name: 'ParseError',
				reason: byte >= 0xC2 && byte <= 0xF4 ? 'Incomplete UTF-8 sequence at the end of the input' : `Invalid UTF-8 byte 0x${hexadecimal}`,
				offset: 21,
				line: 2,
				column: 12,
			});
		});
	}

	test('invalid UTF-8 after a large Unicode prefix retains the exact position', () => {
		const text = `a: 1 # ${'é😀'.repeat(100_000)}`;
		const encoded = new TextEncoder().encode(text);
		const bytes = new Uint8Array(encoded.length + 1);
		bytes.set(encoded);
		bytes[encoded.length] = 0xFF;
		assert.throws(() => parse(bytes), (error: unknown) => error instanceof ParseError && error.offset === text.length && error.column === 200_008);
	});
});

suite('UTF-8 scalar boundaries', () => {
	const scalars = [0x80, 0x7_FF, 0x8_00, 0xF_FF, 0x10_00, 0xD7_FF, 0xE0_00, 0xFF_FF, 0x1_00_00, 0x3_FF_FF, 0x4_00_00, 0xF_FF_FF, 0x10_00_00, 0x10_FF_FF];

	for (const scalar of scalars) {
		const character = String.fromCodePoint(scalar);
		const encoded = new TextEncoder().encode(character);
		const hexadecimal = scalar.toString(16).toUpperCase();

		test(`U+${hexadecimal} remains valid before an invalid sequence`, () => {
			const prefix = new TextEncoder().encode(`a: '${character}' # `);
			const bytes = new Uint8Array(prefix.length + 1);
			bytes.set(prefix);
			bytes[prefix.length] = 0xFF;
			assert.throws(() => parse(bytes), {
				name: 'ParseError',
				reason: 'Invalid UTF-8 byte 0xFF',
				offset: 8 + character.length,
				column: 10,
			});
		});

		for (let index = 1; index < encoded.length; index++) {
			test(`U+${hexadecimal} truncated after ${index} bytes is incomplete`, () => {
				assert.throws(() => parse(encoded.subarray(0, index)), {
					name: 'ParseError',
					reason: 'Incomplete UTF-8 sequence at the end of the input',
					offset: 0,
					column: 1,
				});
			});

			for (const replacement of [0x7F, 0xC0, 0xFF]) {
				test(`U+${hexadecimal} rejects continuation ${index} replaced by 0x${replacement.toString(16)}`, () => {
					const bytes = new Uint8Array(encoded);
					bytes[index] = replacement;
					assert.throws(() => parse(bytes), {
						name: 'ParseError',
						reason: `Invalid UTF-8 byte 0x${bytes[0]!.toString(16).toUpperCase()}`,
						offset: 0,
						column: 1,
					});
				});
			}
		}
	}

	const invalidSequences = [
		[0xE0, 0x9F, 0xBF], // An overlong three-byte form just below U+0800.
		[0xED, 0xA0, 0x80], // U+D800, the first surrogate.
		[0xED, 0xBF, 0xBF], // U+DFFF, the last surrogate.
		[0xF0, 0x8F, 0xBF, 0xBF], // An overlong four-byte form just below U+10000.
		[0xF4, 0x90, 0x80, 0x80], // U+110000, just beyond the largest scalar.
	];

	for (const sequence of invalidSequences) {
		test(`the forbidden sequence ${sequence.map(byte => byte.toString(16)).join(' ')} is invalid at every tail length`, () => {
			for (let length = 2; length <= sequence.length; length++) {
				assert.throws(() => parse(new Uint8Array(sequence.slice(0, length))), {
					name: 'ParseError',
					reason: `Invalid UTF-8 byte 0x${sequence[0]!.toString(16).toUpperCase()}`,
					offset: 0,
					column: 1,
				});
			}
		});
	}
});

test('UTF-8 lead and second-byte bounds agree exhaustively with the native decoder', () => {
	const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}); // eslint-disable-line @typescript-eslint/naming-convention

	for (let lead = 0xC2; lead <= 0xF4; lead++) {
		const length = lead >= 0xF0 ? 4 : (lead >= 0xE0 ? 3 : 2);

		for (let second = 0; second <= 0xFF; second++) {
			const sequence = new Uint8Array(length).fill(0x80);
			sequence[0] = lead;
			sequence[1] = second;
			let decoded: string | undefined;

			try {
				decoded = decoder.decode(sequence);
			} catch {
				// A native UTF-8 error is the oracle for the parser's diagnostic scan.
			}

			const bytes = new Uint8Array(length + 1);
			bytes.set(sequence);
			bytes[length] = 0xFF;
			assert.throws(() => parse(bytes), {
				name: 'ParseError',
				reason: `Invalid UTF-8 byte 0x${decoded === undefined ? lead.toString(16).toUpperCase() : 'FF'}`,
				offset: decoded?.length ?? 0,
			}, `lead 0x${lead.toString(16)}, second 0x${second.toString(16)}`);
		}
	}
});
