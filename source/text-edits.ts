import {type FormatEdit} from './format.ts';

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
	for (const edit of changes) {
		const isEdit = typeof edit === 'object'
			&& edit !== null
			&& Array.isArray(edit.range)
			&& edit.range.length === 2
			&& Number.isSafeInteger(edit.range[0])
			&& Number.isSafeInteger(edit.range[1])
			&& typeof edit.text === 'string';
		if (!isEdit) {
			throw new TypeError('Each edit must have two integer offsets and replacement text');
		}

		const [start, end] = edit.range;
		if (start < 0 || end < start || end > text.length) {
			throw new RangeError('Edit ranges must be ordered and within the text');
		}
	}

	const sorted = changes.toSorted((first, second) => {
		const difference = first.range[0] - second.range[0];
		return difference === 0 ? first.range[1] - second.range[1] : difference;
	});
	const parts: string[] = [];
	let position = 0;
	for (const edit of sorted) {
		if (edit.range[0] < position) {
			throw new RangeError('Edit ranges must not overlap');
		}

		parts.push(text.slice(position, edit.range[0]), edit.text);
		position = edit.range[1];
	}

	parts.push(text.slice(position));
	return parts.join('');
}
