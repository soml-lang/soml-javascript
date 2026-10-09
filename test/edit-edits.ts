import {test} from 'node:test';
import assert from 'node:assert/strict';
import {editEdits, parseTree, ParseError} from '../source/index.ts';

test('editEdits returns original UTF-16 ranges and preserves surrounding spelling', () => {
	assert.deepEqual(editEdits('emoji: \'😀\'\nport: 8080 # keep', ['port'], 9090n), [{range: [18, 22], text: '9090'}]);
});

test('editEdits omits unchanged replacements and missing deletions', () => {
	assert.deepEqual(editEdits('a: 1', ['a'], 1n), []);
	assert.deepEqual(editEdits('a: 1', ['missing'], undefined), []);
});

test('editEdits accepts nodes and writer options', () => {
	const text = 'a: 1';
	const tree = parseTree(text);
	assert.equal(tree.body.type, 'Object');
	if (tree.body.type === 'Object') {
		assert.deepEqual(editEdits(text, tree.body.members[0]!, 2, {integers: 'number'}), [{range: [3, 4], text: '2'}]);
	}
});

test('editEdits shares strict validation', () => {
	assert.throws(() => editEdits('a:', ['a'], 1n), ParseError);
	assert.throws(() => editEdits('a: 1', [], 1n), TypeError);
	assert.throws(() => editEdits('a: []', ['a', 2], 1n), RangeError);
	assert.throws(() => editEdits('a: 1', ['a'], Symbol('invalid')), TypeError);
});
