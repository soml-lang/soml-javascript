import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyEdits} from '../source/index.ts';

test('applyEdits preserves original offsets, input order for insertions, and its input', () => {
	const edits = Object.freeze([
		{range: [3, 4] as const, text: 'D'},
		{range: [1, 2] as const, text: 'B'},
		{range: [1, 1] as const, text: 'first'},
		{range: [1, 1] as const, text: 'second'},
	]);
	assert.equal(applyEdits('abcd', edits), 'afirstsecondBcD');
	assert.equal(edits[0]!.range[0], 3);
	assert.equal(applyEdits('😀ab', [{range: [2, 3], text: 'A'}]), '😀Ab');
	assert.equal(applyEdits('', [{range: [0, 0], text: 'a'}, {range: [0, 0], text: 'b'}]), 'ab');
	assert.equal(applyEdits('abc', []), 'abc');
});

test('applyEdits permits adjacent replacements and insertions at either boundary', () => {
	assert.equal(applyEdits('abcd', [
		{range: [0, 2], text: 'A'},
		{range: [2, 4], text: 'B'},
		{range: [2, 2], text: ':'},
		{range: [4, 4], text: '!'},
	]), 'A:B!');
});

test('applyEdits rejects overlap rather than returning partially edited text', () => {
	for (const range of [[1, 1], [1, 3], [0, 2], [0, 1]] as const) {
		assert.throws(() => applyEdits('abc', [{range: [0, 2], text: ''}, {range, text: 'x'}]), RangeError);
	}
});

test('applyEdits validates every range and replacement', () => {
	for (const range of [[-1, 0], [2, 1], [0, 4]] as const) {
		assert.throws(() => applyEdits('abc', [{range, text: ''}]), RangeError);
	}

	for (const invalid of [undefined, {}, {range: [0], text: ''}, {range: [0, NaN], text: ''}, {range: [0.5, 1], text: ''}, {range: [0, 1], text: 1}, {range: Array.from({length: 2}), text: ''}]) {
		// @ts-expect-error Invalid edit input.
		assert.throws(() => applyEdits('abc', [invalid]), TypeError);
	}

	// @ts-expect-error Invalid edits collection.
	assert.throws(() => applyEdits('abc', {}), TypeError);
});
