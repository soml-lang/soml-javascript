import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	applyEdits,
	formatCollectionEdits,
	parseTree,
	parseForEditor,
	getEditorContext,
	getNodeAtPath,
	ParseError,
} from '../source/index.ts';

function apply(text: string, start: number, end: number, options = {}): string {
	const edits = formatCollectionEdits(text, [start, end], options);
	for (const [index, edit] of edits.entries()) {
		assert.ok(edit.range[0] >= start);
		assert.ok(edit.range[1] <= end);
		assert.ok(edit.range[0] <= edit.range[1]);
		assert.notEqual(text.slice(...edit.range), edit.text);
		if (index > 0) {
			assert.ok(edits[index - 1]!.range[1] < edit.range[0]);
		}
	}

	for (const edit of edits.toReversed()) {
		text = text.slice(0, edit.range[0]) + edit.text + text.slice(edit.range[1]);
	}

	return text;
}

test('formats a collection despite invalid surrounding source', () => {
	const text = 'bad: ?\nports: [80, 443]\nbroken:';
	assert.equal(apply(text, 14, 23, {layout: 'multiline'}), 'bad: ?\nports: [\n\t80\n\t443\n]\nbroken:');
});

test('preserves layout by default without adding a final newline', () => {
	assert.equal(apply('[1,  2,]', 0, 8), '[1, 2]');
	assert.deepEqual(formatCollectionEdits('[1, 2]', [0, 6]), []);
	assert.deepEqual(formatCollectionEdits('[\n\t1\n]', [0, 6]), []);
});

test('multiline only expands the selected collection and uses its supplied level', () => {
	const text = '{a: [1, 2], b: {c: 3}}';
	assert.equal(apply(text, 0, text.length, {layout: 'multiline', indentationLevel: 2}), '{\n\t\t\ta: [1, 2]\n\t\t\tb: {c: 3}\n\t\t}');
});

test('keeps empty collections compact', () => {
	for (const text of ['[]', '{}']) {
		assert.deepEqual(formatCollectionEdits(text, [0, 2], {layout: 'multiline'}), []);
	}
});

test('preserves comments and exact scalar spelling', () => {
	const text = '[0xFF, /* next */ 2.0]';
	assert.equal(apply(text, 0, text.length, {layout: 'multiline'}), '[\n\t0xFF\n\t/* next */ 2.0\n]');
	const onlyComment = '{/* note */}';
	assert.equal(apply(onlyComment, 0, onlyComment.length, {layout: 'multiline'}), '{ /* note */\n}');
});

test('reindents block strings without changing their value', () => {
	const text = '{a:\n\t\'\'\'\n\thello\n\t\'\'\'}';
	const formatted = apply(text, 0, text.length, {indentationLevel: 2});
	const node = getNodeAtPath(parseTree(formatted), ['a']);
	assert.strictEqual(node?.type, 'String');
	assert.equal(node.value, 'hello');
	assert.equal(formatted, '{\n\t\t\ta:\n\t\t\t\t\'\'\'\n\t\t\t\thello\n\t\t\t\t\'\'\'\n\t\t}');
});

test('uses UTF-16 offsets after astral characters', () => {
	const text = 'emoji: \'😀\'\nlist: [1,2] # keep';
	const start = text.indexOf('[');
	assert.equal(apply(text, start, text.indexOf(']') + 1), 'emoji: \'😀\'\nlist: [1, 2] # keep');
});

test('rejects incomplete or invalid collections', () => {
	for (const text of ['[1,', '{a:}', '[1 2]']) {
		assert.throws(() => formatCollectionEdits(text, [0, text.length]), ParseError);
	}
});

test('requires an exact braced collection range', () => {
	for (const text of ['a: 1', ' []', '[] ', '[] # after', '# before\n[]']) {
		assert.throws(() => formatCollectionEdits(text, [0, text.length]), TypeError);
	}
});

test('validates ranges and options', () => {
	for (const range of [[-1, 2], [0, 3], [1, 1], [2, 1]] as const) {
		assert.throws(() => formatCollectionEdits('[]', range), RangeError);
	}

	for (const indentationLevel of [-1, 1001, 1.5, NaN, Infinity]) {
		assert.throws(() => formatCollectionEdits('[]', [0, 2], {indentationLevel}), RangeError);
	}

	// @ts-expect-error Invalid layout.
	assert.throws(() => formatCollectionEdits('[]', [0, 2], {layout: 'invalid'}), TypeError);
	assert.throws(() => formatCollectionEdits('[]', [0.5, 2]), TypeError);
	// @ts-expect-error Invalid range.
	assert.throws(() => formatCollectionEdits('[]', [0, 2, 3]), TypeError);
	// @ts-expect-error Invalid options.
	assert.throws(() => formatCollectionEdits('[]', [0, 2], 'multiline'), TypeError);
});

test('snapshot formatting infers continuation and inline nesting in both tree kinds', () => {
	for (const [text, expected] of [
		['values: # keep\n\t[1,2]', 'values: # keep\n\t[\n\t\t1\n\t\t2\n\t]'],
		['outer: {values: [1,2]}', 'outer: {values: [\n\t\t1\n\t\t2\n\t]}'],
		['outer:\n\t{values:\n\t\t\t[1,2]}', 'outer:\n\t{values:\n\t\t\t[\n\t\t\t\t1\n\t\t\t\t2\n\t\t\t]}'],
	] as const) {
		const snapshot = parseForEditor(text);
		const collection = getEditorContext(snapshot, text.indexOf('['))?.ancestors.findLast(node => node.type === 'EditorArray');
		assert.ok(collection);
		assert.equal(applyEdits(text, formatCollectionEdits(snapshot, collection, {layout: 'multiline'})), expected);
		const root = parseTree(text);
		const path = text.startsWith('outer:') ? ['outer', 'values'] : ['values'];
		const strict = getNodeAtPath(root, path);
		assert.strictEqual(strict?.type, 'Array');
		assert.equal(applyEdits(text, formatCollectionEdits({text, root}, strict, {layout: 'multiline'})), expected);
	}
});

test('snapshot formatting ignores unrelated errors, allows an indentation override, and rejects foreign nodes', () => {
	const text = 'values: [1,2]\nbroken:';
	const snapshot = parseForEditor(text);
	const collection = getEditorContext(snapshot, text.indexOf('['))?.ancestors.findLast(node => node.type === 'EditorArray');
	assert.ok(collection);
	assert.equal(applyEdits(text, formatCollectionEdits(snapshot, collection, {layout: 'multiline', indentationLevel: 2})), 'values: [\n\t\t\t1\n\t\t\t2\n\t\t]\nbroken:');
	assert.throws(() => formatCollectionEdits(parseForEditor(text), collection), TypeError);
	assert.throws(() => formatCollectionEdits(parseForEditor(text), collection, {indentationLevel: 0}), TypeError);
});

test('compact formatting recursively preserves scalar spelling and surrounding text', () => {
	const text = 'before:  0\nvalues: [\n{a: 0xFF\nb: [\'x\', 1.00]}\n]\nafter:  1';
	const root = parseTree(text);
	const node = getNodeAtPath(root, ['values']);
	assert.strictEqual(node?.type, 'Array');
	const edits = formatCollectionEdits({text, root}, node, {layout: 'compact'});
	assert.ok(edits);
	assert.equal(applyEdits(text, edits), 'before:  0\nvalues: [{a: 0xFF, b: [\'x\', 1.00]}]\nafter:  1');
	assert.deepEqual(formatCollectionEdits('[1, 2]', [0, 6], {layout: 'compact'}), []);
});

test('compact refusal differs from no-op and invalid input', () => {
	for (const text of ['[/* keep */]', '[{a: 1 # keep\n}]', '[{a: \'\'\'\nhello\n\'\'\'}]']) {
		assert.equal(formatCollectionEdits(text, [0, text.length], {layout: 'compact'}), undefined);
	}

	assert.throws(() => formatCollectionEdits('[1,', [0, 3], {layout: 'compact'}), ParseError);
	assert.deepEqual(formatCollectionEdits('[]', [0, 2], {layout: 'compact'}), []);
});

test('selected collections use their ancestors without formatting adjacent blocks or comments', () => {
	const text = '[ \'\'\'\n  😀\n  \'\'\', [1,2] /* outside */]';
	const root = parseTree(text);
	const strict = getNodeAtPath(root, [1]);
	assert.strictEqual(strict?.type, 'Array');
	const recovery = parseForEditor(text);
	const recovered = getEditorContext(recovery, text.lastIndexOf('['))?.ancestors.findLast(node => node.type === 'EditorArray');
	assert.ok(recovered);
	for (const [snapshot, collection] of [[{text, root}, strict], [recovery, recovered]] as const) {
		for (const [layout, expected] of [
			['multiline', '[ \'\'\'\n  😀\n  \'\'\', [\n\t\t1\n\t\t2\n\t] /* outside */]'],
			['compact', '[ \'\'\'\n  😀\n  \'\'\', [1, 2] /* outside */]'],
		] as const) {
			const edits = formatCollectionEdits(snapshot, collection, {layout});
			assert.ok(edits);
			assert.equal(applyEdits(text, edits), expected);
		}
	}

	assert.equal(formatCollectionEdits({text, root}, root.body, {layout: 'compact'}), undefined);
});

test('snapshot formatting rejects unfinished collections', () => {
	const snapshot = parseForEditor('[1,');
	const collection = snapshot.root.children.at(0);
	assert.strictEqual(collection?.type, 'EditorArray');
	assert.throws(() => formatCollectionEdits(snapshot, collection), ParseError);
});

test('the nesting limit applies to the selected collection rather than its surrounding snapshot', () => {
	const text = `${'['.repeat(101)}0xFF${']'.repeat(101)}`;
	const snapshot = parseForEditor(text);
	const collection = getEditorContext(snapshot, 1)?.ancestors.findLast(node => node.type === 'EditorArray');
	assert.ok(collection);
	const edits = formatCollectionEdits(snapshot, collection, {layout: 'multiline'});
	assert.equal(applyEdits(text, edits), `[[\n\t\t${'['.repeat(99)}0xFF${']'.repeat(99)}\n\t]]`);
	const root = snapshot.root.children.at(0);
	assert.strictEqual(root?.type, 'EditorArray');
	assert.throws(() => formatCollectionEdits(snapshot, root), ParseError);
});

test('collection options reject explicit null but default undefined', () => {
	// @ts-expect-error Explicit null is not a supported layout.
	assert.throws(() => formatCollectionEdits('[1,2]', [0, 5], {layout: null}), TypeError);
	// @ts-expect-error Explicit null is not an indentation level.
	assert.throws(() => formatCollectionEdits('[1,2]', [0, 5], {indentationLevel: null}), RangeError);
	assert.deepEqual(formatCollectionEdits('[1,2]', [0, 5], {layout: undefined, indentationLevel: undefined}), formatCollectionEdits('[1,2]', [0, 5]));
});

test('parse errors are relative to the selected collection', () => {
	const text = 'x: 1\ny: [1 2]';
	assert.throws(() => formatCollectionEdits(text, [text.indexOf('['), text.length]), {
		name: 'ParseError',
		line: 1,
		column: 4,
		offset: 3,
	});
});

test('text input needs a range and a snapshot needs a collection node', () => {
	const text = '[1,2]';
	const root = parseTree(text);
	// @ts-expect-error Text input needs a range.
	assert.throws(() => formatCollectionEdits(text, root.body), {name: 'TypeError', message: /a snapshot and one of its collections/v});
	// @ts-expect-error A snapshot needs a collection node.
	assert.throws(() => formatCollectionEdits({text, root}, [0, 5]), {name: 'TypeError', message: /a snapshot and one of its collections/v});
});

test('snapshot formatting rejects nodes that are not collections', () => {
	for (const text of ['[1,2]', '{a:1}']) {
		const root = parseTree(text);
		// @ts-expect-error A document is not a collection node.
		assert.throws(() => formatCollectionEdits({text, root}, root), TypeError);
		const snapshot = parseForEditor(text);
		// @ts-expect-error An editor document is not a collection node.
		assert.throws(() => formatCollectionEdits(snapshot, snapshot.root), TypeError);
	}

	const text = 'key: 1';
	const root = parseTree(text);
	assert.equal(root.body.type, 'Object');
	const member = root.body.members[0]!;
	for (const node of [member, member.key, member.value]) {
		// @ts-expect-error Members, keys, and scalars are not collections.
		assert.throws(() => formatCollectionEdits({text, root}, node), TypeError);
	}

	const snapshot = parseForEditor(text);
	const object = snapshot.root.children.at(0);
	assert.strictEqual(object?.type, 'EditorObject');
	const recoveredMember = object.members[0]!;
	assert.strictEqual(recoveredMember.type, 'EditorMember');
	for (const node of [recoveredMember, recoveredMember.key, recoveredMember.value]) {
		// @ts-expect-error Recovered members, keys, and scalars are not collections.
		assert.throws(() => formatCollectionEdits(snapshot, node), TypeError);
	}
});

test('a line break inside a block comment between a key and its value does not indent the value', () => {
	for (const text of ['a: /* multi\nline */ [\n\t1\n]\n', 'a: /* x */\n\t/* y */ [\n\t\t1\n\t]\n', 'a: # x\n\t[\n\t\t1\n\t]\n']) {
		const root = parseTree(text);
		const strict = getNodeAtPath(root, ['a']);
		assert.strictEqual(strict?.type, 'Array');
		assert.deepEqual(formatCollectionEdits({text, root}, strict), [], text);
		const snapshot = parseForEditor(text);
		const recovered = getEditorContext(snapshot, text.indexOf('['))?.ancestors.findLast(node => node.type === 'EditorArray');
		assert.ok(recovered);
		assert.deepEqual(formatCollectionEdits(snapshot, recovered), [], text);
	}
});
