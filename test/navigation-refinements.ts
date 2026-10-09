import assert from 'node:assert/strict';
import test from 'node:test';
import {
	parseForEditor,
	getEditorContext,
	getCompletionContext,
	parseTree,
	getNodeAt,
	getNodeAtPath,
} from '../source/index.ts';

test('deep unfinished collections retain every owning collection at EOF', () => {
	const text = `[${'{item: ['.repeat(49)}`;
	const document = parseForEditor(text);
	assert.equal(document.diagnosticsTruncated, false);
	for (const side of ['left', 'right'] as const) {
		const context = getEditorContext(document, text.length, {side})!;
		const collections = context.ancestors.filter(node => node.type === 'EditorArray' || node.type === 'EditorObject');
		assert.equal(collections.length, 99);
		assert.equal(context.ancestors.at(-1)?.type, 'EditorArray');
		assert.equal(context.slot?.kind, 'array-element');
		assert.equal(context.slot.index, 0);
	}
});

test('zero-width missing values remain slots throughout nested incomplete members', () => {
	const text = '[{outer: {inner:';
	const document = parseForEditor(text);
	for (const side of ['left', 'right'] as const) {
		const context = getEditorContext(document, text.length, {side})!;
		assert.equal(context.ancestors.at(-1)?.type, 'EditorMember');
		assert.equal(context.ancestors.some(node => node.type === 'EditorMissing'), false);
		assert.equal(context.slot?.kind, 'member-value');
		assert.equal(context.slot.owner, context.ancestors.at(-1));
	}
});

test('keyword shortcuts validate the complete token and retain keyword-shaped keys', () => {
	const document = parseForEditor('true: true\nfalse: false\nnull: null');
	assert.deepEqual(document.diagnostics, []);
	const object = document.root.children.at(0)!;
	assert.equal(object.type, 'EditorObject');
	assert.deepEqual(object.members.map(member => {
		assert.equal(member.type, 'EditorMember');
		assert.equal(member.key.type, 'EditorKey');
		assert.equal(member.value.type, 'EditorScalar');
		return [member.key.key, member.value.scalarKind];
	}), [['true', 'bool'], ['false', 'bool'], ['null', 'null']]);
	for (const spelling of ['truex', 'falsex', 'nullx', 'true0', 'false_', 'null-', 'TRUE']) {
		const result = parseForEditor(`[${spelling}]`);
		const array = result.root.children.at(0)!;
		assert.equal(array.type, 'EditorArray');
		assert.equal(array.elements[0]?.type, 'EditorError', spelling);
		assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'invalid-value'), spelling);
	}
});

test('a long whitespace gap exposes a local completion without crossing a comment', () => {
	const text = `[true,${' \t'.repeat(20_000)}/* preserved */${'\t '.repeat(20_000)}]`;
	const document = parseForEditor(text);
	const context = getCompletionContext(document, text.length - 1)!;
	assert.equal(context.slot.kind, 'array-element');
	assert.equal(context.slot.index, 1);
	assert.deepEqual(context.range, [text.length - 1, text.length - 1]);
	assert.equal(context.prefix, '');
	const comment = document.tokens.find(token => token.kind === 'blockComment')!;
	assert.equal(getCompletionContext(document, comment.range[0] + 3), undefined);
	assert.equal(getNodeAt(parseTree(text), comment.range[0] + 3)?.type, 'Block');
});

test('closed comments preserve completion boundaries while unfinished comments suppress EOF', () => {
	for (const source of ['a: /**/', 'a: /***/', 'a: /* /* */']) {
		const document = parseForEditor(source);
		assert.equal(getCompletionContext(document, source.length)?.slot.kind, 'member-value');
		assert.equal(getCompletionContext(document, source.length - 1), undefined);
	}

	for (const source of ['a: /*/', 'a: /*', 'a: /* /*', 'a: # note']) {
		assert.equal(getCompletionContext(parseForEditor(source), source.length), undefined);
	}
});

test('side option reads only its own getter once and ignores an inherited throwing getter', () => {
	const document = parseForEditor('key:true');
	let reads = 0;
	const options = {
		get side() {
			reads++;
			return 'left' as const;
		},
	};
	assert.equal(getEditorContext(document, 3, options)?.token?.kind, 'key');
	assert.equal(reads, 1);
	const inherited = Object.create({
		get side() {
			throw new Error('Inherited options must not be read');
		},
	}) as typeof options;
	assert.equal(getEditorContext(document, 3, inherited)?.token?.kind, 'punctuation');
});

test('quoted block keys remain invalid keys and preserve later recovered members', () => {
	for (const quote of ['\'', '"']) {
		const source = `{${quote.repeat(3)}\nblock\n${quote.repeat(3)}: true\nvalid: false}`;
		const document = parseForEditor(source);
		const object = document.root.children.at(0)!;
		assert.equal(object.type, 'EditorObject');
		assert.equal(object.members.length, 2);
		const [first, second] = object.members;
		assert.equal(first?.type, 'EditorMember');
		assert.equal(first.key.type, 'EditorError');
		assert.equal(first.value.type, 'EditorScalar');
		assert.equal(second?.type, 'EditorMember');
		assert.equal(second.key.type, 'EditorKey');
		assert.equal(second.key.key, 'valid');
		assert.equal(document.diagnostics.filter(diagnostic => diagnostic.code === 'invalid-key').length, 1);
	}
});

test('strict navigation gives punctuation priority between member children', () => {
	const text = '{"😀": /* gap */ [1ns, false]}';
	const tree = parseTree(text);
	const key = getNodeAt(tree, 2);
	assert.equal(key?.type, 'Key');
	const colon = getNodeAt(tree, text.indexOf(':'));
	assert.equal(colon?.type, 'Punctuator');
	assert.equal(getNodeAt(tree, text.indexOf(' gap '))?.type, 'Block');
	assert.equal(getNodeAt(tree, text.indexOf('['))?.type, 'Punctuator');
	assert.equal(getNodeAt(tree, text.indexOf(','))?.type, 'Punctuator');
	assert.equal(getNodeAt(tree, text.indexOf('false'))?.type, 'Boolean');
	assert.equal(getNodeAtPath(tree, ['😀', 0])?.type, 'Duration');
});
