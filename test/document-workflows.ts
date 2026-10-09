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
	getNodeAtPath,
	parse,
	parseForEditor,
	parseTree,
	ParseError,
	type EditorParseResult,
	type EditorArray,
	type EditorObject,
	type FormatEdit,
	type PathSegment,
} from '../source/index.ts';
import {normalize} from './helpers.ts';

/**
Find a selected top-level collection in a recovered snapshot, including when unrelated source is invalid.
*/
function collection(snapshot: EditorParseResult, key: string): EditorArray | EditorObject {
	const root = snapshot.root.children.at(0);
	assert.equal(root?.type, 'EditorObject');
	const member = root.members.find(member => member.type === 'EditorMember' && member.key.type === 'EditorKey' && member.key.key === key);
	assert.equal(member?.type, 'EditorMember');
	assert.ok(member.value.type === 'EditorArray' || member.value.type === 'EditorObject');
	return member.value;
}

/**
Verify that local layout edits touch only the selected range and leave its surrounding bytes unchanged.
*/
function applyLocal(text: string, range: readonly [number, number], edits: readonly FormatEdit[]): string {
	for (const change of edits) {
		assert.ok(change.range[0] >= range[0]);
		assert.ok(change.range[1] <= range[1]);
	}

	const changed = applyEdits(text, edits);
	assert.equal(changed.slice(0, range[0]), text.slice(0, range[0]));
	assert.ok(changed.endsWith(text.slice(range[1])));
	return changed;
}

const selections = [
	{name: 'radix and separated float', text: '[0xFF,1_0.50]', expected: [255n, 10.5]},
	{name: 'Unicode object', text: '{first:\'😀\',second:0b10}', expected: {first: '😀', second: 2n}},
	{name: 'nested lists and duration', text: '[{},[1,2],-90m]', expected: [{}, [1n, 2n], Temporal.Duration.from({minutes: -90})]},
	{name: 'nested object with empties', text: '{empty:[],limits:{soft:1,hard:2}}', expected: {empty: [], limits: {soft: 1n, hard: 2n}}},
	{name: 'leading block comment', text: '[1,/* for two */2]', expected: [1n, 2n]},
	{name: 'trailing line comment', text: '[1,# first\n2]', expected: [1n, 2n]},
	{name: 'escaped block string', text: '["""\nhi\\t😀\n""",1]', expected: ['hi\t😀', 1n]},
	{name: 'offset instant and infinity', text: '[2026-09-19T14:00:00+02:00,-infinity]', expected: [Temporal.Instant.from('2026-09-19T12:00:00Z'), -Infinity]},
];

const surroundings = [
	{name: 'valid bare document', text: 'before: \'😀\'\nleft: §\nright: [\n3\n4\n]\nafter: true', invalid: false},
	{name: 'valid braced document', text: '{before: \'😀\',left: §,right: [\n3\n4\n],after:true}', invalid: false},
	{name: 'missing earlier value', text: 'broken:\nleft: §\nright: [\n3\n4\n]\nafter:true', invalid: true},
	{name: 'invalid earlier scalar', text: 'broken: nope\nleft: §\nright: [\n3\n4\n]\nafter:true', invalid: true},
	{name: 'duplicate earlier keys', text: 'duplicate:1\nduplicate:2\nleft: §\nright: [\n3\n4\n]\nafter:true', invalid: true},
	{name: 'unfinished later string', text: 'left: §\nright: [\n3\n4\n]\nbroken: "dangling', invalid: true},
];

// 48 sequential local-formatting workflows. The second selection comes from a fresh snapshot after the first changes offsets.
for (const selection of selections) {
	for (const surrounding of surroundings) {
		test(`sequential selection formatting preserves ${selection.name} with ${surrounding.name}`, () => {
			const source = surrounding.text.replace('§', () => selection.text);
			const firstSnapshot = parseForEditor(source);
			const originalRight = collection(firstSnapshot, 'right');
			const originalRightRange = [...originalRight.range];
			const left = collection(firstSnapshot, 'left');
			const firstEdits = formatCollectionEdits(firstSnapshot, left, {layout: 'multiline'});
			assert.ok(firstEdits.length > 0);
			const first = applyLocal(source, left.range, firstEdits);
			const secondSnapshot = parseForEditor(first);
			const right = collection(secondSnapshot, 'right');
			assert.notEqual(right.range[0], originalRight.range[0]);
			const secondEdits = formatCollectionEdits(secondSnapshot, right, {layout: 'compact'});
			assert.ok(secondEdits);
			assert.ok(secondEdits.length > 0);
			const second = applyLocal(first, right.range, secondEdits);
			const finalSnapshot = parseForEditor(second);
			const finalLeft = collection(finalSnapshot, 'left');
			const finalRight = collection(finalSnapshot, 'right');
			assert.deepEqual(normalize(parse(second.slice(...finalLeft.range))), normalize(selection.expected));
			assert.equal(second.slice(...finalRight.range), '[3, 4]');
			assert.deepEqual(formatCollectionEdits(finalSnapshot, finalLeft, {layout: 'multiline'}), []);
			assert.equal(finalSnapshot.diagnostics.length > 0, surrounding.invalid);
			assert.deepEqual(originalRight.range, originalRightRange);
			assert.equal(firstSnapshot.text, source);
		});
	}
}

type Model = {payload: unknown; list: unknown[]; group: {empty?: unknown; keep?: unknown; [key: string]: unknown}};
type Step = {path: PathSegment[]; value?: unknown; update: (model: Model) => void; canonical?: boolean};

/*
The expected state uses ordinary array/object operations rather than reproducing the editor's text or removal logic. Every program mixes insertions, replacements, and deletions before reparsing fresh node targets.
*/
const programs: Array<{name: string; steps: Step[]}> = [
	{
		name: 'array append replace and remove',
		steps: [
			{
				path: ['list', 2],
				value: '😀',
				update(model) {
					model.list.push('😀');
				},
			},
			{
				path: ['list', 0],
				value: {active: true},
				update(model) {
					model.list[0] = {active: true};
				},
			},
			{
				path: ['list', 1],
				update(model) {
					model.list.splice(1, 1);
				},
			},
			{
				path: ['list', 2],
				update() {
					// Removing an absent entry leaves the model unchanged.
				},
			},
		],
	},
	{
		name: 'prototype-like parent creation and removal',
		steps: [
			{
				path: ['group', '__proto__', 'constructor'],
				value: 7n,
				update(model) {
					Object.defineProperty(model.group, '__proto__', {
						value: {constructor: 7n}, writable: true, enumerable: true, configurable: true,
					});
				},
			},
			{
				path: ['group', '__proto__', 'toString'],
				value: 'safe',
				update(model) {
					Object.defineProperty(Reflect.get(model.group, '__proto__') as Record<string, unknown>, 'toString', {
						value: 'safe', writable: true, enumerable: true, configurable: true,
					});
				},
			},
			{
				path: ['group', '__proto__', 'constructor'],
				update(model) {
					Reflect.deleteProperty(Reflect.get(model.group, '__proto__') as Record<string, unknown>, 'constructor');
				},
			},
			{
				path: ['group', '__proto__'],
				update(model) {
					Reflect.deleteProperty(model.group, '__proto__');
				},
			},
		],
	},
	{
		name: 'nested collection replacement and emptying',
		steps: [
			{
				path: ['group', 'empty'],
				value: [{value: 3n}, 4n],
				update(model) {
					model.group.empty = [{value: 3n}, 4n];
				},
			},
			{
				path: ['group', 'empty', 0, 'value'],
				value: false,
				update(model) {
					(model.group.empty as Array<{
						value: unknown;
					}>)[0]!.value = false;
				},
			},
			{
				path: ['group', 'empty', 1],
				update(model) {
					(model.group.empty as unknown[]).splice(1, 1);
				},
			},
			{
				path: ['group', 'empty', 0],
				update(model) {
					(model.group.empty as unknown[]).shift();
				},
			},
		],
	},
	{
		name: 'quoted parent paths and escaped keys',
		steps: [
			{
				path: ['group', 'a.b', 'line\nkey'],
				value: 'first',
				update(model) {
					model.group['a.b'] = {'line\nkey': 'first'};
				},
			},
			{
				path: ['group', 'a.b', 'line\nkey'],
				value: 'second😀',
				update(model) {
					(model.group['a.b'] as Record<string, unknown>)['line\nkey'] = 'second😀';
				},
			},
			{
				path: ['group', 'a.b', ''],
				value: 0n,
				update(model) {
					(model.group['a.b'] as Record<string, unknown>)[''] = 0n;
				},
			},
			{
				path: ['group', 'a.b', 'line\nkey'],
				update(model) {
					Reflect.deleteProperty(model.group['a.b'] as Record<string, unknown>, 'line\nkey');
				},
			},
		],
	},
	{
		name: 'canonical replacement subtree ordering',
		steps: [
			{
				path: ['group', 'empty'],
				value: {z: 1n, a: [true]},
				canonical: true,
				update(model) {
					model.group.empty = {a: [true], z: 1n};
				},
			},
			{
				path: ['group', 'empty', 'a', 1],
				value: {z: false, a: 2n},
				canonical: true,
				update(model) {
					((model.group.empty as {
						a: unknown[];
					}).a).push({a: 2n, z: false});
				},
			},
			{
				path: ['group', 'empty', 'z'],
				update(model) {
					Reflect.deleteProperty(model.group.empty as Record<string, unknown>, 'z');
				},
			},
			{
				path: ['group', 'empty', 'a', 0],
				value: null,
				update(model) {
					(model.group.empty as {
						a: unknown[];
					}).a[0] = null;
				},
			},
		],
	},
	{
		name: 'member insertion deletion and reinsertion',
		steps: [
			{
				path: ['group', 'keep'],
				update(model) {
					Reflect.deleteProperty(model.group, 'keep');
				},
			},
			{
				path: ['group', 'keep'],
				value: ['restored', 1n],
				update(model) {
					model.group.keep = ['restored', 1n];
				},
			},
			{
				path: ['group', 'keep', 0],
				value: 'changed😀',
				update(model) {
					(model.group.keep as unknown[])[0] = 'changed😀';
				},
			},
			{
				path: ['group', 'missing'],
				update() {
					// Removing an absent entry leaves the model unchanged.
				},
			},
		],
	},
];

// 48 multi-step data-edit transactions, retaining differently spelled scalar payloads and comments.
for (const selection of selections) {
	for (const program of programs) {
		test(`${program.name} preserves an unrelated ${selection.name} payload`, () => {
			const payload = selection.text;
			let source = `# retained😀\npayload: ${payload}\nlist: [1,2]\ngroup: {empty: {}, keep: '😀'}\n`;
			const model: Model = {payload: normalize(selection.expected), list: [1n, 2n], group: {empty: {}, keep: '😀'}};
			for (const step of program.steps) {
				const tree = parseTree(source);
				const node = getNodeAtPath(tree, step.path);
				const options = {canonical: step.canonical};
				const changes = editEdits(source, step.path, step.value, options);
				assert.ok(changes.length <= 1);
				if (node) {
					assert.deepEqual(editEdits(source, node, step.value, options), changes);
				}

				const changed = applyEdits(source, changes);
				assert.equal(edit(source, step.path, step.value, options), changed);
				step.update(model);
				assert.deepEqual(normalize(parse(changed)), model);
				assert.deepEqual(normalize(evaluate(parseTree(changed))), model);
				assert.deepEqual(parseForEditor(changed).diagnostics, []);
				assert.ok(changed.startsWith(`# retained😀\npayload: ${payload}\n`));
				source = changed;
			}

			const formatted = applyEdits(source, formatEdits(source));
			assert.equal(format(formatted), formatted);
			assert.deepEqual(normalize(parse(formatted)), model);
		});
	}
}

const errorSites = [
	{name: 'short first line', prefix: '', lead: 'bad: '},
	{name: '98-unit line prefix', prefix: '', lead: `bad:${' '.repeat(94)}`},
	{name: '99-unit line prefix', prefix: '', lead: `bad:${' '.repeat(95)}`},
	{name: '100-unit line prefix', prefix: '', lead: `bad:${' '.repeat(96)}`},
	{name: 'astral key on a later line', prefix: 'name: \'😀\'\n', lead: '\'😀\': '},
	{name: 'three-digit line gutter', prefix: '# context\n'.repeat(99), lead: '\tbad: '},
];

const failures = [
	{name: 'unknown value punctuation', raw: '@', reason: /Expected a value/v},
	{name: 'negative integer zero', raw: '-0', reason: /zero has one spelling/v},
	{name: 'invalid hexadecimal digits', raw: '0xGG', reason: /hexadecimal/v},
	{name: 'unfinished exponent', raw: '1e', reason: /exponent/v},
	{name: 'fractional nanoseconds', raw: '0.1ns', reason: /nanosecond/v},
	{name: 'invalid month day', raw: '2026-02-30T00:00:00Z', reason: /day/v},
];

// 36 diagnostic workflows, with independent source coordinates and strict/recovered API consistency.
for (const failure of failures) {
	for (const site of errorSites) {
		test(`${failure.name} diagnostics agree across APIs at a ${site.name}`, () => {
			const source = `${site.prefix}${site.lead}${failure.raw}`;
			let original: ParseError | undefined;
			assert.throws(() => parse(source), error => {
				assert.ok(error instanceof ParseError);
				original = error;
				assert.match(error.reason, failure.reason);
				assert.equal(error.offset, site.prefix.length + site.lead.length);
				assert.equal(error.line, site.prefix.split('\n').length);
				assert.equal(error.column, [...site.lead].length + 1);
				assert.ok(error.codeFrame.endsWith('^'));
				return true;
			});
			assert.ok(original);
			const actions = [() => parseTree(source), () => format(source), () => formatEdits(source), () => edit(source, ['missing'], undefined), () => editEdits(source, ['missing'], undefined)];
			for (const action of actions) {
				assert.throws(action, {
					reason: original.reason, offset: original.offset, line: original.line, column: original.column, codeFrame: original.codeFrame,
				});
			}

			const diagnostic = parseForEditor(source).diagnostics[0];
			assert.equal(diagnostic?.code, 'invalid-document');
			assert.equal(diagnostic.message, original.reason);
			assert.deepEqual(diagnostic.range, [original.offset, original.offset + 1]);
		});
	}
}
