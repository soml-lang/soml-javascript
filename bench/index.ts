/*
Parses and serializes realistic documents in SOML and with the most used JSON and TOML packages, and prints how long each takes.

	npm run bench

The fixtures are a copy of the benchmark fixtures in the `soml` repository, which every implementation shares, and its readme describes each of them. Each fixture holds the same data in SOML, JSON, and TOML, in the same layout, so the times compare the same work. The times are per document, not per byte, because the formats write the same data in different sizes. A serializer writes the value that its own parser read.
*/
import fs from 'node:fs';
import {Buffer} from 'node:buffer';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import * as smolToml from 'smol-toml';
import iarnaToml from '@iarna/toml';
import toml from 'toml';
import JSON5 from 'json5';
import * as jsonc from 'jsonc-parser';
import {
	parse,
	parseTree,
	format,
	stringify,
} from '../source/index.ts';

type Library = {
	name: string;
	extension: 'soml' | 'json' | 'toml';
	parse: (text: string) => unknown;
	stringify?: (value: unknown) => string;
};

const libraries: Library[] = [
	{
		name: 'soml-lang',
		extension: 'soml',
		parse: text => parse(text),
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

function readFixture(name: string): string {
	return fs.readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
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
		return value.map(item => toPlain(item));
	}

	return typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, toPlain(item)])) : value;
}

/*
How long one call of `run` takes, in milliseconds. It is the median of many samples, and each sample calls `run` enough times to take at least 10 ms, so that a fast call on a small document is measured too.
*/
function measure(run: () => unknown): number {
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
			break;
		}

		batch *= 2;
	}

	const samples: number[] = [];

	for (let sample = 0; sample < 21; sample++) {
		const start = performance.now();

		for (let index = 0; index < batch; index++) {
			run();
		}

		samples.push((performance.now() - start) / batch);
	}

	return samples.toSorted((left, right) => left - right)[Math.floor(samples.length / 2)]!;
}

function formatTime(milliseconds: number): string {
	return milliseconds < 1 ? `${(milliseconds * 1000).toFixed(1)} µs` : `${milliseconds.toFixed(2)} ms`;
}

function formatSize(text: string): string {
	return `${(Buffer.byteLength(text) / 1024).toFixed(1)} KB`;
}

function printTable(title: string, rows: string[][]): void {
	console.log(`\n${title}`);

	const widths = rows[0]!.map((_cell, column) => Math.max(...rows.map(row => row[column]!.length)));

	for (const row of rows) {
		console.log(`  ${row[0]!.padEnd(widths[0]!)}${row.slice(1).map((cell, column) => cell.padStart(widths[column + 1]! + 3)).join('')}`);
	}
}

const fixtures = fixtureNames.map(name => {
	const texts = {
		soml: readFixture(`${name}.soml`),
		json: readFixture(`${name}.json`),
		toml: readFixture(`${name}.toml`),
	};

	return {name, texts, data: toPlain(JSON.parse(texts.json))};
});

for (const fixture of fixtures) {
	const rows = [['', 'size', 'parse', 'stringify']];

	for (const library of libraries) {
		const text = fixture.texts[library.extension];
		const value = library.parse(text);
		// A parser that reads different data, or a serializer that writes it, would not do the same work.
		assert.deepEqual(toPlain(value), fixture.data, `${library.name} reads different data from the ${fixture.name} fixture`);

		if (library.stringify !== undefined) {
			const written = library.stringify(value);
			assert.deepEqual(toPlain(library.parse(written)), fixture.data, `${library.name} writes different data for the ${fixture.name} fixture`);
		}

		rows.push([
			library.name,
			formatSize(text),
			formatTime(measure(() => library.parse(text))),
			library.stringify === undefined ? '' : formatTime(measure(() => library.stringify!(value))),
		]);
	}

	printTable(`${fixture.name}, the same data in each format`, rows);
}

// The SOML files are already formatted, which is the common case for `format()`, as in `prettier --check` and format on save.
const tasks: Record<string, (text: string, value: ReturnType<typeof parse>) => unknown> = {
	parse: text => parse(text),
	'parse, integers: number': text => parse(text, {integers: 'number'}),
	parseTree: text => parseTree(text),
	format: text => format(text),
	'stringify, canonical: true': (_text, value) => stringify(value, {canonical: true}),
};

const values = fixtures.map(fixture => parse(fixture.texts.soml));

printTable('soml-lang', [
	['', ...fixtures.map(fixture => fixture.name)],
	...Object.entries(tasks).map(([name, run]) => [name, ...fixtures.map((fixture, index) => formatTime(measure(() => run(fixture.texts.soml, values[index]!))))]),
]);
