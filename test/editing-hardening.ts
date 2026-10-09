import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	applyEdits,
	edit,
	editEdits,
	evaluate,
	format,
	formatCollectionEdits,
	formatEdits,
	formatKey,
	getEditorContext,
	getNodeAtPath,
	parse,
	parseForEditor,
	parseTree,
	type PathSegment,
} from '../source/index.ts';

const placements = [
	{
		label: 'bare object', prefix: '', suffix: '', path: [],
	},
	{
		label: 'braced object', prefix: '{', suffix: '}', path: [],
	},
	{
		label: 'object member', prefix: 'outer: {', suffix: '}', path: ['outer'],
	},
	{
		label: 'array element', prefix: '[{', suffix: '}]', path: [0],
	},
	{
		label: 'nested array element', prefix: 'outer: [{', suffix: '}]', path: ['outer', 0],
	},
	{
		label: 'multiline object', prefix: 'outer: {\n', suffix: '\n}', path: ['outer'],
	},
] satisfies Array<{label: string; prefix: string; suffix: string; path: PathSegment[]}>;

// These names exercise inherited properties, escaped syntax, Unicode offsets, and invisible terminal characters independently.
const keys = [
	'__proto__',
	'constructor',
	'prototype',
	'toString',
	'valueOf',
	'hasOwnProperty',
	'__defineGetter__',
	'__lookupSetter__',
	'a.b',
	'a[b]',
	'a:b',
	'a,b',
	'a#b',
	'a/*b*/',
	'a\'b',
	'a"b',
	String.raw`a\b`,
	'a\nb',
	'a\tb',
	'a\u{1B}b',
	'a\u{9B}b',
	'a\u{202E}b',
	'😀',
	'e\u{301}',
];

for (const key of keys) {
	for (const placement of placements) {
		test(`editing preserves key ${JSON.stringify(key)} in ${placement.label}`, () => {
			const text = `${placement.prefix}${formatKey(key)}: 1\nanchor: '😀' # preserved${placement.suffix.startsWith('\n') ? '' : '\n'}${placement.suffix}`;
			const path = [...placement.path, key];
			const original = getNodeAtPath(parseTree(text), path);
			assert.ok(original);
			const changed = edit(text, path, {['__proto__']: [2n, 'line\n😀']});
			assert.equal(changed, applyEdits(text, editEdits(text, path, {['__proto__']: [2n, 'line\n😀']})));
			assert.equal(changed, edit(text, original, {['__proto__']: [2n, 'line\n😀']}));
			assert.ok(changed.includes('anchor: \'😀\' # preserved'));
			const updated = getNodeAtPath(parseTree(changed), [...path, '__proto__', 1]);
			assert.strictEqual(updated?.type, 'String');
			assert.equal(updated.value, 'line\n😀');
			const changedNode = getNodeAtPath(parseTree(changed), path);
			assert.ok(changedNode);
			const changedValue = evaluate(changedNode);
			assert.deepEqual(changedValue, {['__proto__']: [2n, 'line\n😀']});
			assert.equal(Object.getPrototypeOf(changedValue), Object.prototype);
			assert.equal(edit(changed, path, 1n), text);
			const removed = edit(changed, path, undefined);
			assert.equal(getNodeAtPath(parseTree(removed), path), undefined);
			assert.equal(edit(removed, path, undefined), removed);
			assert.equal(getNodeAtPath(parseTree(removed), [...placement.path, 'anchor'])?.type, 'String');
			assert.deepEqual(parse(format(changed)), parse(changed));
		});
	}
}

const replacements: Array<{label: string; first: unknown; second: unknown}> = [
	{label: 'bigint and float', first: 9_007_199_254_740_993n, second: 0.125},
	{label: 'negative integers', first: -9_223_372_036_854_775_808n, second: 9_223_372_036_854_775_807n},
	{label: 'non-finite floats', first: Infinity, second: -Infinity},
	{label: 'negative infinity and zero', first: -Infinity, second: 0n},
	{label: 'empty string and null', first: '', second: null},
	{label: 'opposing booleans', first: true, second: false},
	{label: 'quoted strings', first: 'a\'b', second: 'a"b'},
	{label: 'multiline strings', first: 'a\nb\n', second: '\n😀\n'},
	{label: 'prototype members', first: {['__proto__']: 1n}, second: {constructor: 2n}},
	{label: 'nested collections', first: [{a: [1n]}], second: {b: [{c: false}]}},
	{label: 'empty collections', first: [], second: {}},
	{label: 'subnormal and maximum floats', first: Number.MIN_VALUE, second: Number.MAX_VALUE},
];

for (const replacement of replacements) {
	for (const placement of placements) {
		test(`disjoint edits commute for ${replacement.label} in ${placement.label}`, () => {
			const text = `${placement.prefix}first: 1 # first\nsecond: 2 # second\nanchor: 0xFF${placement.suffix.startsWith('\n') ? '' : '\n'}${placement.suffix}`;
			const firstPath = [...placement.path, 'first'];
			const secondPath = [...placement.path, 'second'];
			const forward = edit(edit(text, firstPath, replacement.first), secondPath, replacement.second);
			const backward = edit(edit(text, secondPath, replacement.second), firstPath, replacement.first);
			assert.equal(forward, backward);
			assert.ok(forward.includes('# first'));
			assert.ok(forward.includes('# second'));
			assert.ok(forward.includes('anchor: 0xFF'));
			const firstEdits = editEdits(text, firstPath, replacement.first);
			const secondEdits = editEdits(text, secondPath, replacement.second);
			assert.equal(applyEdits(text, [...firstEdits, ...secondEdits].toReversed()), forward);
			const tree = parseTree(forward);
			const firstNode = getNodeAtPath(tree, firstPath);
			const secondNode = getNodeAtPath(tree, secondPath);
			assert.ok(firstNode);
			assert.ok(secondNode);
			assert.deepEqual(evaluate(firstNode), replacement.first);
			assert.deepEqual(evaluate(secondNode), replacement.second);
			assert.equal(applyEdits(forward, formatEdits(forward)), format(forward));
			assert.equal(format(format(forward)), format(forward));
		});
	}
}

for (const option of ['layout', 'indentationLevel'] as const) {
	test(`collection formatting reads the ${option} getter once`, () => {
		let reads = 0;
		const options = Object.defineProperty({}, option, {
			get() {
				reads++;
				return option === 'layout' ? 'multiline' : 1;
			},
		});
		const text = '[1,2]';
		assert.equal(applyEdits(text, formatCollectionEdits(text, [0, text.length], options)), option === 'layout' ? '[\n\t1\n\t2\n]' : '[1, 2]');
		assert.equal(reads, 1);
	});
}

test('editor affinity ignores inherited getters', () => {
	const prototype = Object.defineProperty({}, 'side', {
		get() {
			throw new Error('Inherited options must stay unread');
		},
	});
	const snapshot = parseForEditor('[1]');
	assert.equal(getEditorContext(snapshot, 1, Object.create(prototype) as {side?: 'left' | 'right'})?.token?.kind, 'scalar');
});

for (const options of [null, false, 0, 'right', Symbol('options')]) {
	test(`editor context rejects options of type ${options === null ? 'null' : typeof options}`, () => {
		// @ts-expect-error Invalid runtime options.
		assert.throws(() => getEditorContext(parseForEditor('[1]'), 1, options), TypeError);
	});
}

test('editor affinity reads an own getter once and respects left affinity', () => {
	let reads = 0;
	const context = getEditorContext(parseForEditor('[1]'), 2, {
		get side() {
			reads++;
			return 'left' as const;
		},
	});
	assert.equal(context?.token?.kind, 'scalar');
	assert.equal(reads, 1);
});

test('editor affinity defaults an own undefined property without reading its prototype', () => {
	const prototype = Object.defineProperty({}, 'side', {
		get() {
			throw new Error('Inherited affinity must stay unread');
		},
	});
	const options = Object.create(prototype, {side: {value: undefined}}) as {side?: 'left' | 'right'};
	assert.equal(getEditorContext(parseForEditor('[1]'), 1, options)?.token?.kind, 'scalar');
});
