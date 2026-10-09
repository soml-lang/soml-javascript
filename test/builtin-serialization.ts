import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	parse,
	stringify,
	stringifyValue,
} from '../source/index.ts';

test('shared siblings remain independent of the ancestor stack at the nesting limit', () => {
	const shared = {value: 1n};
	let value: Record<string, unknown> | unknown[] = Array.from({length: 16}, () => shared);
	for (let index = 0; index < 98; index++) {
		value = {child: value};
	}

	assert.deepEqual(parse(stringify(value)), value);
	assert.deepEqual(parse(stringifyValue(value, {canonical: true})), value);
});

test('a back-reference remains circular after completed sibling collections', () => {
	const shared = {value: 1n};
	const value: {siblings: unknown[]; child?: unknown} = {siblings: [shared, shared, [], {}]};
	value.child = {back: value};
	assert.throws(() => stringify(value), {name: 'TypeError', message: 'Cannot serialize a circular structure'});
	assert.throws(() => stringifyValue([value]), {name: 'TypeError', message: 'Cannot serialize a circular structure'});
});
