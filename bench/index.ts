/*
Parses and serializes realistic documents in SOML and with the most used JSON and TOML packages, and measures how long each takes with the experimental `node:bench` module.

	npm run bench

The fixtures are a copy of the benchmark fixtures in the `soml` repository, which every implementation shares, and its readme describes each of them. Each fixture holds the same data in SOML, JSON, and TOML, in the same layout, so the times compare the same work. The times are per document, not per byte, because the formats write the same data in different sizes. A serializer writes the value that its own parser read.
*/
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
// @ts-expect-error `@types/node` has no types for `node:bench` yet.
import {bench as untypedBench} from 'node:bench';
import * as smolToml from 'smol-toml';
import iarnaToml from '@iarna/toml';
import toml from 'toml';
import JSON5 from 'json5';
import * as jsonc from 'jsonc-parser';
import {
	parse,
	parseTree,
	parseForEditor,
	format,
	formatEdits,
	stringify,
	getNodeAt,
	formatString,
} from '../source/index.ts';

type BenchContext = {
	readonly start: () => void;
	readonly end: (operations: number) => void;
};

type Bench = (name: string, options: {samples: number}, function_: (context: BenchContext) => void) => void;

type Library = {
	readonly name: string;
	readonly extension: 'soml' | 'json' | 'toml';
	readonly parse: (text: string) => unknown;
	readonly stringify?: (value: unknown) => string;
};

const bench = untypedBench as Bench;

const libraries: Library[] = [
	{
		name: 'soml-lang',
		extension: 'soml',
		parse,
		stringify: value => stringify(value as Record<string, unknown>),
	},
	{
		name: 'JSON',
		extension: 'json',
		parse: text => JSON.parse(text) as unknown,
		stringify: value => JSON.stringify(value, undefined, '\t'),
	},
	{
		name: 'json5',
		extension: 'json',
		parse: text => JSON5.parse<unknown>(text),
		stringify: value => JSON5.stringify(value, undefined, '\t'),
	},
	{
		name: 'jsonc-parser',
		extension: 'json',
		parse: text => jsonc.parse(text) as unknown,
	},
	{
		name: 'smol-toml',
		extension: 'toml',
		parse: text => smolToml.parse(text),
		stringify: value => smolToml.stringify(value),
	},
	{
		name: '@iarna/toml',
		extension: 'toml',
		parse: text => iarnaToml.parse(text),
		stringify: value => iarnaToml.stringify(value as iarnaToml.JsonMap),
	},
	{
		name: 'toml',
		extension: 'toml',
		parse: text => toml.parse(text) as unknown,
	},
];

// From the smallest to the largest.
const fixtureNames = ['service', 'platform', 'earthquakes'];
const fixtureDecoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}); // eslint-disable-line @typescript-eslint/naming-convention

function readFixture(name: string): string {
	return fixtureDecoder.decode(fs.readFileSync(new URL(`fixtures/${name}`, import.meta.url)));
}

/*
A parsed value in one form for every parser, so that the values from different parsers can be compared: an int is a number, an instant or a duration is its ISO 8601 string, and a member whose value is null is left out, because TOML has no null.
*/
function toPlain(value: unknown): unknown {
	if (typeof value === 'bigint') {
		return Number(value);
	}

	// A TOML date-time. Its milliseconds are enough, because no fixture has a finer instant.
	if (value instanceof Date) {
		return Temporal.Instant.fromEpochMilliseconds(value.getTime()).toString();
	}

	if (value instanceof Temporal.Instant || value instanceof Temporal.Duration) {
		return value.toString();
	}

	if (Array.isArray(value)) {
		// eslint-disable-next-line unicorn/no-array-callback-reference -- This private callback consumes only its first argument.
		return value.map(toPlain);
	}

	return typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value).values().filter(([, item]) => item !== null).map(([key, item]) => [key, toPlain(item)])) : value;
}

/*
How many calls of `run` make a sample take at least 10 ms, so that a fast call on a small document is measured too.
*/
function findBatchSize(run: () => unknown): number {
	// Warm up, so the JIT has compiled the hot paths.
	for (const start = performance.now(); performance.now() - start < 200;) {
		run();
	}

	let batch = 1;

	for (;;) {
		const start = performance.now();

		for (let index = 0; index < batch; index++) {
			run();
		}

		if (performance.now() - start >= 10) {
			return batch;
		}

		batch *= 2;
	}
}

// Keeps the last result in a module-level variable, so that V8 cannot remove a call whose result is unused.
let result: unknown;

function benchmark(name: string, run: () => unknown): void {
	let batch: number | undefined;

	bench(name, {samples: 21}, b => {
		batch ??= findBatchSize(run);
		result = undefined;

		b.start();

		for (let index = 0; index < batch; index++) {
			result = run();
		}

		b.end(batch);

		assert.notEqual(result, undefined);
	});
}

const fixtures = fixtureNames.map(name => {
	const texts = {
		soml: readFixture(`${name}.soml`),
		json: readFixture(`${name}.json`),
		toml: readFixture(`${name}.toml`),
	};

	return {name, texts, data: toPlain(JSON.parse(texts.json))};
});

function benchmarkLibrary(fixture: (typeof fixtures)[number], library: Library): void {
	const text = fixture.texts[library.extension];
	const value = library.parse(text);
	// A parser that reads different data, or a serializer that writes it, would not do the same work.
	assert.deepEqual(toPlain(value), fixture.data, `${library.name} reads different data from the ${fixture.name} fixture`);

	benchmark(`${fixture.name}, ${library.name}, parse`, () => library.parse(text));

	const write = library.stringify;
	if (write === undefined) {
		return;
	}

	const written = write(value);
	assert.deepEqual(toPlain(library.parse(written)), fixture.data, `${library.name} writes different data for the ${fixture.name} fixture`);

	benchmark(`${fixture.name}, ${library.name}, stringify`, () => write(value));
}

for (const fixture of fixtures) {
	for (const library of libraries) {
		benchmarkLibrary(fixture, library);
	}
}

// The SOML files are already formatted, which is the common case for `format()`, as in `prettier --check` and format on save. Plain `parse()` is measured above.
const tasks: Record<string, (text: string, value: ReturnType<typeof parse>) => unknown> = {
	'parse, integers: number': text => parse(text, {integers: 'number'}),
	parseTree: text => parseTree(text),
	parseForEditor: text => parseForEditor(text),
	format: text => format(text),
	formatEdits: text => formatEdits(text),
	'stringify, canonical: true': (_text, value) => stringify(value, {canonical: true}),
};
const taskEntries = Object.entries(tasks);

for (const fixture of fixtures) {
	const value = parse(fixture.texts.soml);

	for (const [name, run] of taskEntries) {
		benchmark(`${fixture.name}, soml-lang, ${name}`, () => run(fixture.texts.soml, value));
	}
}

// Keep the scanner fallback, recovered atom scanning, and cursor-query workloads visible alongside the realistic fixture benchmarks.
const longFraction = `value: 0.125${'0'.repeat(50_000)}`;
assert.deepEqual(parse(longFraction), {value: 0.125});
benchmark('long decimal fraction, soml-lang, parse', () => parse(longFraction));

const longAtoms = Array.from({length: 100}, (_, index) => `${'long_key_'.repeat(200)}${index}: 0.125${'0'.repeat(500)}`).join('\n');
const recovered = parseForEditor(longAtoms);
assert.deepEqual(recovered.diagnostics, []);
const recoveredObject = recovered.root.children.at(0);
assert.equal(recoveredObject?.type, 'EditorObject');
assert.equal(recoveredObject.members.length, 100);
benchmark('long keys and atoms, soml-lang, parseForEditor', () => parseForEditor(longAtoms));

const cursorText = Array.from({length: 1000}, (_, index) => `key${index}: ${index}.5`).join('\n');
const cursorTree = parseTree(cursorText);
assert.equal(cursorTree.body.type, 'Object');
const cursorOffsets = cursorTree.body.members.map(member => member.value.range[0]);
for (const member of cursorTree.body.members) {
	assert.equal(getNodeAt(cursorTree, member.value.range[0]), member.value);
}

benchmark('1000 scalar cursor queries, soml-lang, getNodeAt', () => {
	let node: ReturnType<typeof getNodeAt>;
	for (const offset of cursorOffsets) {
		node = getNodeAt(cursorTree, offset);
	}

	return node;
});

const escapedText = 'line\n\u{0}\u{7}\u{7F}'.repeat(10_000);
assert.deepEqual(parse(`value: ${formatString(escapedText)}`), {value: escapedText});
benchmark('escape-heavy string, soml-lang, formatString', () => formatString(escapedText));

const sparseDurations = Array.from({length: 1000}, (_, index) => Temporal.Duration.from({seconds: index}));
assert.equal(parse(stringify(sparseDurations)).length, sparseDurations.length);
benchmark('single-unit durations, soml-lang, stringify', () => stringify(sparseDurations));
