import {type FormatEdit} from './format.ts';
import {readRange} from './shared.ts';

/**
Apply text edits whose UTF-16 ranges refer to the original text. Accepts edits in any order without mutating them. Equal-position insertions are applied in input order, before a replacement starting there. Adjacent ranges are allowed; overlapping replacements or insertions inside a replacement throw `RangeError`.

This only validates edits, not SOML syntax. Do not concatenate independently computed edit sets unless they are known to be compatible.

@param text - The original text.
@param edits - The edits, such as from `formatEdits()`, `formatCollectionEdits()`, or `editEdits()`.
@returns The changed text.
@throws {TypeError} When `text` is not a string, or `edits` is not an array of edits with two integer offsets and replacement text.
@throws {RangeError} When a range is reversed or outside the text, or when two edits overlap.

@example
```
import {applyEdits, editEdits} from 'soml-lang';

const text = 'port: 8080';
applyEdits(text, editEdits(text, ['port'], 9090n));
//=> 'port: 9090'
```
*/
export function applyEdits(text: string, edits: readonly FormatEdit[]): string {
	if (typeof text !== 'string' || !Array.isArray(edits)) {
		throw new TypeError('Expected text and an array of edits');
	}

	// `Array.isArray()` narrows `edits` to `any[]`.
	const changes = edits as readonly FormatEdit[];
	const {length} = changes;
	if (length === 0) {
		return text;
	}

	if (length === 1) {
		const {range, text: replacement} = snapshotEdit(Object.hasOwn(changes, 0) ? changes[0]! : undefined, text.length);
		const [start, end] = range;
		return text.slice(0, start) + replacement + text.slice(end);
	}

	let isSorted = true;
	let previous: FormatEdit | undefined;
	const sorted: FormatEdit[] = [];
	// Snapshot the original list length so getters cannot add unbounded work.
	// Note: Not using `Array.from()` because it would honor a caller-supplied iterator instead of the indexed edits.
	for (let index = 0; index < length; index++) {
		const snapshot = snapshotEdit(Object.hasOwn(changes, index) ? changes[index]! : undefined, text.length);
		isSorted &&= previous === undefined || compareEdits(previous, snapshot) <= 0;
		previous = snapshot;
		sorted.push(snapshot);
	}

	if (!isSorted) {
		sorted.sort(compareEdits);
	}

	const parts: string[] = [];
	let position = 0;
	for (const edit of sorted) {
		const [start, end] = edit.range;
		if (start < position) {
			throw new RangeError('Edit ranges must not overlap');
		}

		if (start > position) {
			parts.push(text.slice(position, start));
		}

		if (edit.text !== '') {
			parts.push(edit.text);
		}

		position = end;
	}

	parts.push(text.slice(position));
	return parts.join('');
}

/**
Validate and copy an edit, so application uses the same values even when the caller supplied accessors.
*/
function snapshotEdit(edit: FormatEdit | undefined, textLength: number): FormatEdit {
	if (typeof edit !== 'object' || edit === null) {
		throw new TypeError('Each edit must have two integer offsets and replacement text');
	}

	const {range, text} = edit;
	const offsets = readRange(range);
	if (typeof text !== 'string' || offsets === undefined) {
		throw new TypeError('Each edit must have two integer offsets and replacement text');
	}

	const [start, end] = offsets;

	if (start < 0 || end < start || end > textLength) {
		throw new RangeError('Edit ranges must be ordered and within the text');
	}

	return {range: offsets, text};
}

/**
Order edits by their original start, placing insertions before replacements at the same offset. Equal-position insertions retain their input order through stable sorting.
*/
function compareEdits(first: FormatEdit, second: FormatEdit): number {
	const difference = first.range[0] - second.range[0];
	return difference === 0 ? first.range[1] - second.range[1] : difference;
}
