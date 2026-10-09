import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	applyEdits,
	edit,
	format,
	formatCollectionEdits,
	parse,
	parseForEditor,
	parseTree,
} from '../source/index.ts';

test('applyEdits snapshots accessor-backed edits before applying them', () => {
	let rangeReads = 0;
	let textReads = 0;
	const change = {
		get range(): readonly [number, number] {
			rangeReads++;
			return rangeReads === 1 ? [1, 2] : [-100, 100];
		},
		get text(): string {
			textReads++;
			return textReads === 1 ? 'X' : 'unchecked';
		},
	};
	assert.equal(applyEdits('abc', [change]), 'aXc');
	assert.equal(rangeReads, 1);
	assert.equal(textReads, 1);
});

test('formatting a nested snapshot verifies identity without changing outside layout', () => {
	const text = 'parent: {\n\t# Keep this comment\n\tchild: [1,2]\n}\nbroken:';
	const snapshot = parseForEditor(text);
	const parent = snapshot.root.children.at(0);
	assert.strictEqual(parent?.type, 'EditorObject');
	const parentMember = parent.members[0]!;
	assert.strictEqual(parentMember.type, 'EditorMember');
	const outer = parentMember.value;
	assert.strictEqual(outer.type, 'EditorObject');
	const childMember = outer.members[0]!;
	assert.strictEqual(childMember.type, 'EditorMember');
	const collection = childMember.value;
	assert.strictEqual(collection.type, 'EditorArray');

	const edits = formatCollectionEdits(snapshot, collection, {layout: 'multiline'});
	assert.equal(applyEdits(text, edits), 'parent: {\n\t# Keep this comment\n\tchild: [\n\t\t1\n\t\t2\n\t]\n}\nbroken:');
	assert.throws(() => formatCollectionEdits(snapshot, {...collection}), /must belong/v);
});

test('applyEdits reads tuple offsets without invoking an overridden iterator', () => {
	const range: [number, number] = [1, 2];
	range[Symbol.iterator] = () => {
		throw new Error('Range iteration must not run');
	};

	assert.equal(applyEdits('abc', [{range, text: 'X'}]), 'aXc');
});

test('already indented block strings retain content and blank line spelling', () => {
	const text = 'text:\n\t\'\'\'\n\tcontent\n \t \n\tmore\n\t\'\'\'\n';
	assert.equal(format(text), text);
	assert.deepEqual(parse(format(text)), parse(text));
});

test('formatting distinguishes a huge blank line from indentation on the following member', () => {
	const spaces = ' '.repeat(1_000_000);
	assert.equal(format(`first: 1\n${spaces}\nlast: 2`), 'first: 1\n\nlast: 2\n');
	assert.equal(format(`first: 1\n${spaces}last: 2`), 'first: 1\nlast: 2\n');
});

test('deleting the first multiline member removes only the newly adjacent blank line', () => {
	const text = '{\n\tfirst: 1\n\n\tsecond: 2\n}\n';
	const result = edit(text, ['first'], undefined);
	assert.equal(result, '{\n\tsecond: 2\n}\n');
	assert.deepEqual(parse(result), {second: 2n});
	assert.equal(parseTree(result).body.type, 'Object');
});
