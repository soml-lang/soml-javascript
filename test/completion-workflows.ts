import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	applyEdits,
	editEdits,
	evaluate,
	format,
	getCompletionContext,
	getNodeAtPath,
	parse,
	parseForEditor,
	parseTree,
	type PathSegment,
} from '../source/index.ts';
import {normalize} from './helpers.ts';

/*
Each site exercises different ownership and separator rules. Expected documents are constructed independently of the parsers, with an astral neighbor to expose UTF-16 offset mistakes.
*/
const sites: Array<{name: string; template: string; path: PathSegment[]; expected: (value: unknown) => unknown}> = [
	{
		name: 'bare member', template: 'before: \'😀\'\ntarget: §\nafter: 0xFF', path: ['target'], expected: value => ({before: '😀', target: value, after: 255n}),
	},
	{
		name: 'braced member', template: '{before: \'😀\', target: §, after: 0xFF}', path: ['target'], expected: value => ({before: '😀', target: value, after: 255n}),
	},
	{
		name: 'root array', template: '[0xFF, §, \'😀\']', path: [1], expected: value => [255n, value, '😀'],
	},
	{
		name: 'nested object',
		template: 'outer: {before: \'😀\', target: §, after: 0xFF}\nafter: false',
		path: ['outer', 'target'],
		expected: value => ({outer: {before: '😀', target: value, after: 255n}, after: false}),
	},
	{
		name: 'nested array', template: 'items: [\'😀\', §, 0xFF]\nafter: false', path: ['items', 1], expected: value => ({items: ['😀', value, 255n], after: false}),
	},
	{
		name: 'object in array',
		template: 'items: [{target: §, before: \'😀\'}, 0xFF]\nafter: false',
		path: ['items', 0, 'target'],
		expected: value => ({items: [{target: value, before: '😀'}, 255n], after: false}),
	},
];

const repairs = [
	{
		name: 'partial true', raw: 'tru', replacement: 'true', value: true,
	},
	{
		name: 'partial false', raw: 'fals', replacement: 'false', value: false,
	},
	{
		name: 'partial null', raw: 'nul', replacement: 'null', value: null,
	},
	{
		name: 'NaN', raw: 'NaN', replacement: 'null', value: null,
	},
	{
		name: 'invalid hex digits', raw: '0xGG', replacement: '0xFF', value: 255n,
	},
	{
		name: 'invalid binary digits', raw: '0b102', replacement: '0b101', value: 5n,
	},
	{
		name: 'invalid octal digits', raw: '0o89', replacement: '0o77', value: 63n,
	},
	{
		name: 'missing exponent', raw: '1e', replacement: '1e3', value: 1000,
	},
	{
		name: 'positive exponent sign', raw: '1e+3', replacement: '1e3', value: 1000,
	},
	{
		name: 'missing fraction', raw: '1.', replacement: '1.5', value: 1.5,
	},
	{
		name: 'leading zero', raw: '01', replacement: '1', value: 1n,
	},
	{
		name: 'negative integer zero', raw: '-0', replacement: '0', value: 0n,
	},
	{
		name: 'int64 overflow', raw: '9223372036854775808', replacement: '9223372036854775807', value: 9_223_372_036_854_775_807n,
	},
	{
		name: 'fractional nanosecond', raw: '0.1ns', replacement: '1ns', value: Temporal.Duration.from({nanoseconds: 1}),
	},
	{
		name: 'invalid calendar date', raw: '2026-02-30T00:00:00Z', replacement: '2026-02-28T00:00:00Z', value: Temporal.Instant.from('2026-02-28T00:00:00Z'),
	},
	{
		name: 'misspelled infinity', raw: 'infinit', replacement: 'infinity', value: Infinity,
	},
];

// 96 distinct malformed-token repairs across collection ownership and separator boundaries.
for (const repair of repairs) {
	for (const site of sites) {
		test(`completion repairs ${repair.name} in a ${site.name} without touching neighbors`, () => {
			const source = site.template.replace('§', () => repair.raw);
			const start = site.template.indexOf('§');
			const cursor = start + Math.max(1, Math.floor(repair.raw.length / 2));
			const snapshot = parseForEditor(source);
			assert.ok(snapshot.diagnostics.length > 0);
			const context = getCompletionContext(snapshot, cursor);
			assert.ok(context);
			assert.deepEqual(context.range, [start, start + repair.raw.length]);
			assert.equal(context.prefix, repair.raw.slice(0, cursor - start));
			const changed = applyEdits(source, [{range: context.range, text: repair.replacement}]);
			assert.equal(changed.slice(0, start), source.slice(0, start));
			assert.equal(changed.slice(start + repair.replacement.length), source.slice(start + repair.raw.length));
			assert.deepEqual(normalize(parse(changed)), normalize(site.expected(repair.value)));
			assert.deepEqual(normalize(evaluate(parseTree(changed))), normalize(site.expected(repair.value)));
			assert.deepEqual(parseForEditor(changed).diagnostics, []);
			assert.deepEqual(normalize(parse(format(changed))), normalize(site.expected(repair.value)));
			assert.equal(snapshot.text, source);
		});
	}
}

const initialValues = [
	{name: 'alternate-radix integer', raw: '0xFF', value: 255n},
	{name: 'separated float', raw: '1_0.50', value: 10.5},
	{name: 'boolean', raw: 'true', value: true},
	{name: 'null', raw: 'null', value: null},
	{name: 'literal punctuation string', raw: '\'/*[]{}*/😀\'', value: '/*[]{}*/😀'},
	{name: 'escaped multiline value', raw: String.raw`"a\n😀\t"`, value: 'a\n😀\t'},
	{name: 'block string', raw: '\'\'\'\ncontent😀\n\'\'\'', value: 'content😀'},
	{name: 'offset instant', raw: '2026-09-19T14:00:00+02:00', value: Temporal.Instant.from('2026-09-19T12:00:00Z')},
	{name: 'negative duration', raw: '-90m', value: Temporal.Duration.from({minutes: -90})},
	{name: 'negative infinity', raw: '-infinity', value: -Infinity},
	{name: 'empty array', raw: '[]', value: []},
	{name: 'empty object', raw: '{}', value: {}},
];

// 72 type transitions followed by completion in a newly parsed, shifted subtree.
for (const initial of initialValues) {
	for (const site of sites) {
		test(`completion uses a fresh nested snapshot after replacing ${initial.name} in a ${site.name}`, () => {
			const source = site.template.replace('§', () => initial.raw);
			assert.deepEqual(normalize(parse(source)), normalize(site.expected(initial.value)));
			const originalTree = parseTree(source);
			const originalNode = getNodeAtPath(originalTree, site.path);
			assert.ok(originalNode);
			const originalRange = [...originalNode.range];
			const replacement = [{enabled: false, labels: ['😀'], value: 0n}];
			const changed = applyEdits(source, editEdits(source, originalNode, replacement));
			assert.deepEqual(normalize(parse(changed)), normalize(site.expected(replacement)));
			const tree = parseTree(changed);
			const target = getNodeAtPath(tree, [...site.path, 0, 'enabled']);
			assert.equal(target?.type, 'Boolean');
			const snapshot = parseForEditor(changed);
			const context = getCompletionContext(snapshot, target.range[0] + 2);
			assert.ok(context);
			assert.equal(context.slot.kind, 'member-value');
			assert.equal(context.prefix, 'fa');
			assert.deepEqual(context.range, target.range);
			const completed = applyEdits(changed, [{range: context.range, text: 'true'}]);
			assert.deepEqual(normalize(parse(completed)), normalize(site.expected([{enabled: true, labels: ['😀'], value: 0n}])));
			assert.deepEqual(parseForEditor(completed).diagnostics, []);
			assert.deepEqual(originalNode.range, originalRange);
			assert.equal(getNodeAtPath(originalTree, site.path), originalNode);
			assert.deepEqual(normalize(evaluate(originalTree)), normalize(site.expected(initial.value)));
		});
	}
}
