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

test('applyEdits agrees with an independent position oracle for every triple of ranges', () => {
	const text = 'abc';
	const ranges: Array<readonly [number, number]> = [];
	for (let start = 0; start <= text.length; start++) {
		for (let end = start; end <= text.length; end++) {
			ranges.push([start, end]);
		}
	}

	const triples = ranges.flatMap(first => ranges.flatMap(second => ranges.map(third => [first, second, third] as const)));
	for (const [first, second, third] of triples) {
		const edits = [{range: first, text: 'X'}, {range: second, text: 'Y'}, {range: third, text: 'Z'}];
		const label = JSON.stringify(edits);
		const replacements = edits.filter(edit => edit.range[0] < edit.range[1]);
		const insertions = edits.filter(edit => edit.range[0] === edit.range[1]);
		const hasOverlap = replacements.some((edit, index) => replacements.slice(index + 1).some(other => edit.range[0] < other.range[1] && other.range[0] < edit.range[1]));
		const hasInteriorInsertion = insertions.some(insertion => replacements.some(edit => edit.range[0] < insertion.range[0] && insertion.range[0] < edit.range[1]));
		if (hasOverlap || hasInteriorInsertion) {
			assert.throws(() => applyEdits(text, edits), RangeError, label);
			continue;
		}

		// Read the original positions in order, retaining insertion order and emitting each replacement only at its start.
		let expected = '';
		for (let position = 0; position <= text.length; position++) {
			expected += insertions.filter(edit => edit.range[0] === position).map(edit => edit.text).join('');
			expected += replacements.find(edit => edit.range[0] === position)?.text ?? '';
			if (position < text.length && replacements.every(edit => position < edit.range[0] || position >= edit.range[1])) {
				expected += text[position];
			}
		}

		assert.equal(applyEdits(text, edits), expected, label);
	}
});
