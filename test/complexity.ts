/*
Parsing, formatting, editing, and serializing must take linear time in the size of the input, whatever its shape. Each case times a document and one eight times its size, and compares the ratio rather than an absolute time, so a slow machine does not fail the test. Linear time gives a ratio near 8, and quadratic time near 64, so the threshold leaves room for noise from garbage collection and from test files running in parallel.
*/
import {test, suite} from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {
	parse,
	parseTree,
	parseForEditor,
	format,
	formatEdits,
	edit,
	stringify,
	type PathSegment,
} from '../source/index.ts';

const SIZE_FACTOR = 8;
const MAXIMUM_RATIO = 24;

/*
The fastest of several runs, which is the measurement least disturbed by garbage collection and by other test files running in parallel.
*/
function time(run: () => unknown): number {
	let fastest = Infinity;

	for (let index = 0; index < 7; index++) {
		const start = performance.now();
		run();
		fastest = Math.min(fastest, performance.now() - start);
	}

	return fastest;
}

function assertLinear<Input>(createInput: (count: number) => Input, run: (input: Input) => unknown = input => parse(input as string | Uint8Array)): void {
	const small = createInput(10_000);
	const large = createInput(10_000 * SIZE_FACTOR);

	// Warm up both sizes, so neither measurement includes compilation.
	for (let index = 0; index < 3; index++) {
		run(small);
		run(large);
	}

	const ratio = time(() => run(large)) / time(() => run(small));
	assert.ok(ratio < MAXIMUM_RATIO, `${SIZE_FACTOR} times the input took ${ratio.toFixed(1)} times as long`);
}

function parseExpectingError(input: string | Uint8Array): void {
	assert.throws(() => parse(input), {name: 'ParseError'});
}

suite('parse is linear on one-line documents', () => {
	test('literal strings', () => {
		assertLinear(count => `[${'\'a\', '.repeat(count)}]`);
	});

	test('escaped strings', () => {
		assertLinear(count => `[${String.raw`"a\n", `.repeat(count)}]`);
	});

	test('quoted keys', () => {
		assertLinear(count => `{${Array.from({length: count}, (_, index) => `'k${index}': 1`).join(', ')}}`);
	});

	test('bare keys', () => {
		assertLinear(count => `{${Array.from({length: count}, (_, index) => `k${index}: 1`).join(', ')}}`);
	});

	test('block comments', () => {
		assertLinear(count => `[${'/* c */ 1, '.repeat(count)}]`);
	});

	test('numbers of every kind', () => {
		assertLinear(count => `[${'1, -2, 1.5, 1e5, 0xFF, 0o7, 0b1, 1_000, infinity, '.repeat(count / 4)}]`);
	});

	// Fewer items than the other cases, because many `Temporal` objects that all stay alive make the garbage collector superlinear at the larger size, mostly on a busy machine.
	test('instants', () => {
		assertLinear(count => `[${'2026-09-19T14:00:00.5+01:00, '.repeat(count / 8)}]`);
	});

	test('durations', () => {
		assertLinear(count => `[${'1h2m3s4ms5us6ns, -90m, 1.25h, '.repeat(count / 12)}]`);
	});

	test('keywords', () => {
		assertLinear(count => `[${'true, false, null, '.repeat(count / 2)}]`);
	});

	test('nested arrays side by side', () => {
		// A quarter of the usual count, because many small arrays that all stay alive make the garbage collector superlinear at the larger size.
		assertLinear(count => `[${'[[1]], '.repeat(count / 4)}]`);
	});
});

suite('parse is linear on multi-line documents', () => {
	test('top-level entries with comments', () => {
		assertLinear(count => Array.from({length: count}, (_, index) => `k${index}: 'v' # comment`).join('\n'));
	});

	test('block strings', () => {
		assertLinear(count => `a: [\n${'\t\'\'\'\n\tline\n\t\'\'\',\n'.repeat(count / 2)}]`);
	});

	test('one long block string', () => {
		assertLinear(count => `a: """\n${'\tx\\ty\n'.repeat(count)}\t"""`);
	});

	test('one long line comment', () => {
		assertLinear(count => `# ${'x'.repeat(count * 10)}\na: 1`);
	});

	test('one long block comment', () => {
		assertLinear(count => `/* ${'x '.repeat(count * 5)} */\na: 1`);
	});
});

suite('long single tokens are linear', () => {
	test('a long literal string', () => {
		assertLinear(count => `a: '${'x'.repeat(count * 10)}'`);
	});

	test('a long escaped string with escapes', () => {
		assertLinear(count => `a: "${String.raw`x\u{1f600}`.repeat(count)}"`);
	});

	test('a long bare key', () => {
		assertLinear(count => `${'k'.repeat(count * 10)}: 1`);
	});

	test('a long hexadecimal int with leading zeros', () => {
		assertLinear(count => `a: 0x${'0'.repeat(count * 10)}1`);
	});

	test('a long float', () => {
		assertLinear(count => `a: 0.${'3'.repeat(count * 10)}`);
	});

	test('a long duration fraction with trailing zeros', () => {
		assertLinear(count => `a: 1.5${'0'.repeat(count * 10)}s`);
	});

	test('a long duration fraction with zeros before its last digit', () => {
		// Not ten times the count like the other long tokens, so that a quadratic regression fails in seconds rather than in minutes.
		assertLinear(count => `a: 1.${'0'.repeat(count)}5s`, parseExpectingError);
	});
});

suite('the error path is linear', () => {
	test('an error at the end of a long one-line document', () => {
		assertLinear(count => `[${'1, '.repeat(count)}nope]`, parseExpectingError);
	});

	test('an error at the end of a long multi-line document', () => {
		assertLinear(count => `${Array.from({length: count}, (_, index) => `k${index}: 1`).join('\n')}\nnope`, parseExpectingError);
	});

	test('an unterminated literal string', () => {
		assertLinear(count => `a: '${'x'.repeat(count * 10)}`, parseExpectingError);
	});

	test('an unterminated block comment', () => {
		assertLinear(count => `a: 1 /* ${'x'.repeat(count * 10)}`, parseExpectingError);
	});

	test('a key with spaces and no colon on a long line', () => {
		assertLinear(count => `a ${'b '.repeat(count * 5)}`, parseExpectingError);
	});

	test('an invalid number with a long tail', () => {
		assertLinear(count => `a: 1${'x'.repeat(count * 10)}`, parseExpectingError);
	});

	test('a lone surrogate at the end', () => {
		assertLinear(count => `a: '${'x'.repeat(count * 10)}${String.fromCharCode(0xD8_00)}'`, parseExpectingError);
	});

	test('invalid UTF-8 at the end of a long multi-byte input', () => {
		assertLinear(count => new Uint8Array([...new TextEncoder().encode(`a: '${'é'.repeat(count * 5)}`), 0xFF, 0x27]), parseExpectingError);
	});

	test('a key that starts with a character a bare key cannot hold', () => {
		assertLinear(count => `${'$'.repeat(count * 10)}: 1`, parseExpectingError);
		assertLinear(count => `${'$'.repeat(count * 10)} 1`, parseExpectingError);
	});

	test('a long key with many dots', () => {
		assertLinear(count => `${'a.'.repeat(count * 5)}b: 1`, parseExpectingError);
		assertLinear(count => `${'a'.repeat(count * 10)}.b: 1`, parseExpectingError);
		assertLinear(count => `{x: 1, ${'a.'.repeat(count * 5)}b: 1}`, parseExpectingError);
	});

	test('a bare value document', () => {
		assertLinear(count => `'${'x'.repeat(count * 10)}'`, parseExpectingError);
	});
});

// Small enough to stay in the CPU caches, where a large flat array would otherwise show memory effects that look superlinear. A quadratic algorithm still stands out at this size.
suite('stringify is linear', () => {
	test('many members', () => {
		assertLinear(count => Object.fromEntries(Array.from({length: count / 2}, (_, index) => [`k${index}`, BigInt(index)])), value => stringify(value));
	});

	test('many array items', () => {
		assertLinear(count => Array.from({length: count / 2}, (_, index) => `item ${index}`), value => stringify(value));
	});

	test('deep nesting, where each level must not copy the levels below it', () => {
		// 10 levels against 80, each with the same payload, which stays under the nesting limit of 100.
		assertLinear(count => {
			let value = {};

			for (let index = 0; index < count / 1000; index++) {
				value = {a: 'x'.repeat(100_000), b: value};
			}

			return value;
		}, value => stringify(value));
	});

	test('a long string with escapes', () => {
		assertLinear(count => ({a: 'it\'s\n'.repeat(count)}), value => stringify(value));
	});
});

// A tree holds several objects for every token, so the inputs are smaller, for the same reason as for `stringify`.
suite('parseTree, format, and formatEdits are linear', () => {
	// Each shape has a path for `edit()` to change.
	const shapes: Array<[string, (count: number) => string, PathSegment[]]> = [
		['many members, each with a comment', count => Array.from({length: count / 16}, (_, index) => `k${index}: ${index} # note`).join('\n'), ['k0']],
		['a one-line array', count => `[${'1, /* c */ \'a\', '.repeat(count / 16)}]`, [0]],
		['many block strings', count => Array.from({length: count / 40}, (_, index) => `k${index}: '''\n\t\tline\n\n\t\t'''`).join('\n'), ['k0']],
		['many blank lines between comments', count => `a: [\n${'# c\n\n\n'.repeat(count / 16)}]`, ['a', 0]],
	];

	for (const [name, createInput, path] of shapes) {
		test(`parseTree: ${name}`, () => {
			assertLinear(createInput, input => parseTree(input));
		});

		test(`format: ${name}`, () => {
			assertLinear(createInput, input => format(input));
		});

		test(`formatEdits: ${name}`, () => {
			assertLinear(createInput, input => formatEdits(input));
		});

		test(`edit: ${name}`, () => {
			assertLinear(createInput, input => edit(input, path, 1n));
		});
	}

	test('format: a one-line array of many short items', () => {
		assertLinear(count => `[${'1,'.repeat(count * 4)}]`, input => format(input));
		// Every item is one edit.
		assertLinear(count => `[${'1,'.repeat(count * 4)}]`, input => formatEdits(input));
	});

	test('format: many block comments on one line before an item', () => {
		assertLinear(count => `a: 1${' /* c */'.repeat(count / 2)}\nb: 2`, input => format(input));
		assertLinear(count => `[1,${' /* c */'.repeat(count / 2)}\n2]`, input => format(input));
	});

	test('edit: removing a member after many blank lines or comments at the start of its container', () => {
		const members = (count: number, separator: string) => Array.from({length: count / 32}, (_, index) => `c${index}: 1${separator}\n\n`).join('');
		assertLinear(count => `${'\n'.repeat(count / 32)}${members(count, '')}`, input => edit(input, ['c0'], undefined));
		assertLinear(count => `{${' /* c */'.repeat(count / 32)}\n${members(count, ',')}}`, input => edit(input, ['c0'], undefined));
		assertLinear(count => `{\n${'\n'.repeat(count / 32)}${members(count, ',')}}`, input => edit(input, ['c0'], undefined));
	});
});

suite('editor recovery is linear', () => {
	test('many missing values', () => {
		assertLinear(count => Array.from({length: count}, (_, index) => `key${index}:`).join('\n'), parseForEditor);
	});

	test('many invalid scalar characters', () => {
		assertLinear(count => Array.from({length: count}, (_, index) => `key${index}: 'bad\r'`).join('\n'), parseForEditor);
	});
});
