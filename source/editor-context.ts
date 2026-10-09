import type {
	EditorArray,
	EditorDocument,
	EditorMember,
	EditorNode,
	EditorObject,
	EditorParseResult,
	EditorRange,
	EditorToken,
} from './editor.ts';

/**
A syntactic position, not a semantic data path. Array indexes count recovered syntax elements, including errors.
*/
export type EditorSlot =
	| {readonly kind: 'document'; readonly owner: EditorDocument}
	| {readonly kind: 'key'; readonly owner: EditorObject; readonly member?: EditorMember}
	| {readonly kind: 'member-value'; readonly owner: EditorMember}
	| {readonly kind: 'array-element'; readonly owner: EditorArray; readonly index: number};

/**
Syntax at a cursor position. Nodes and tokens are references into the supplied snapshot; ancestors are ordered from the document to the innermost node. A slot describes ownership, not permission to insert text.
*/
export type EditorContext = {
	readonly ancestors: readonly EditorNode[];
	readonly token?: EditorToken;
	readonly slot?: EditorSlot;
};

/**
How a token boundary is resolved. Left affinity includes ends and excludes starts; right affinity includes starts and excludes ends. Neither jumps across whitespace. Unfinished containers remain ancestors at EOF with either affinity.
*/
export type EditorContextOptions = {readonly side?: 'left' | 'right'};

/**
An eligible completion site. `range` covers the whole unquoted token being replaced, or is zero-width for insertion; `prefix` contains only source before the cursor. Key sites expose their member's `colonRange` so callers can replace only the key when a colon already exists.
*/
export type EditorCompletionContext = EditorContext & {
	readonly slot: EditorSlot;
	readonly range: EditorRange;
	readonly prefix: string;
};

function lowerBound(items: ReadonlyArray<{readonly range: EditorRange}>, offset: number): number {
	let low = 0;
	let high = items.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (items[middle]!.range[0] < offset) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}

	return low;
}

function at(items: ReadonlyArray<{readonly range: EditorRange}>, offset: number, side: 'left' | 'right'): number {
	const next = lowerBound(items, offset);
	const index = side === 'right' && items[next]?.range[0] === offset ? next : next - 1;
	const item = items[index];
	return item && item.range[0] < item.range[1] && (side === 'left' ? offset <= item.range[1] : offset < item.range[1]) ? index : -1;
}

function children(node: EditorNode): readonly EditorNode[] {
	switch (node.type) {
		case 'EditorDocument': {return node.children;}
		case 'EditorObject': {return node.members;}
		case 'EditorArray': {return node.elements;}
		case 'EditorMember': {return [node.key, node.value];}
		default: {return [];}
	}
}

function isUnfinished(node: EditorNode): boolean {
	return node.type === 'EditorMember' ? node.value.type === 'EditorMissing' || isUnfinished(node.value) : (node.type === 'EditorArray' || node.type === 'EditorObject') && !node.closingRange;
}

function slotAt(ancestors: readonly EditorNode[], offset: number, side: 'left' | 'right'): EditorSlot | undefined {
	for (let index = ancestors.length - 1; index >= 0; index--) {
		const node = ancestors[index]!;
		if (node.type === 'EditorMember') {
			if (node.colonRange && offset >= node.colonRange[1]) {
				return {kind: 'member-value', owner: node};
			}

			const object = ancestors[index - 1];
			return object?.type === 'EditorObject' && offset <= node.key.range[1] ? {kind: 'key', owner: object, member: node} : undefined;
		}

		if (node.type === 'EditorObject' || node.type === 'EditorArray') {
			if ((node.type === 'EditorArray' || node.braced) && (offset <= node.range[0] || (node.closingRange && offset > node.closingRange[0]))) {
				continue;
			}

			if (node.type === 'EditorObject') {
				// Missing values may be zero-width at EOF and therefore absent from ancestors.
				const previous = node.members[lowerBound(node.members, offset) - 1];
				return previous?.type === 'EditorMember' && previous.colonRange && previous.value.type === 'EditorMissing' && offset >= previous.colonRange[1] && offset <= previous.range[1] ? {kind: 'member-value', owner: previous} : {kind: 'key', owner: node};
			}

			const found = at(node.elements, offset, side);
			return {kind: 'array-element', owner: node, index: found < 0 ? lowerBound(node.elements, offset) : found};
		}
	}

	const root = ancestors[0];
	return root?.type === 'EditorDocument' && (root.children.length === 0 || offset <= root.children.at(0)!.range[0]) ? {kind: 'document', owner: root} : undefined;
}

/**
Describe syntax at a UTF-16 cursor offset without reparsing. The default affinity is `right`. Left affinity includes token ends and excludes starts; right affinity includes starts and excludes ends. Neither jumps across whitespace. The document is always an ancestor, including at EOF, and unfinished containers remain ancestors at EOF with either affinity. Zero-width missing nodes are represented through slots rather than selected as ancestors.

Nodes and tokens refer to the supplied `parseForEditor()` snapshot. A slot identifies syntactic ownership, including inside comments or before an existing value; it does not promise that insertion is valid. No values are evaluated and no semantic paths are inferred. Returns `undefined` beyond EOF.

@param document - An unchanged snapshot from `parseForEditor()`.
@param offset - A non-negative safe integer UTF-16 offset.
@param options - Token boundary affinity.
@throws {TypeError} For an invalid offset or affinity.

@example
```
import {parseForEditor, getEditorContext} from 'soml-lang';

const document = parseForEditor('port: ');
getEditorContext(document, 6)?.slot?.kind;
//=> 'member-value'
```
*/
export function getEditorContext(document: EditorParseResult, offset: number, options: EditorContextOptions = {}): EditorContext | undefined {
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw new TypeError('Expected a non-negative safe integer offset');
	}

	const side = options.side ?? 'right';
	if (side !== 'left' && side !== 'right') {
		throw new TypeError('Expected side to be left or right');
	}

	if (offset > document.text.length) {
		return undefined;
	}

	const ancestors: EditorNode[] = [document.root];
	let node: EditorNode = document.root;
	while (true) {
		const descendants = children(node);
		let child = descendants[at(descendants, offset, side)];
		if (!child && offset === document.text.length) {
			const last = descendants.at(-1);
			if (last?.range[1] === offset && isUnfinished(last)) {
				child = last;
			}
		}

		if (!child) {
			break;
		}

		ancestors.push(child);
		node = child;
	}

	const token = document.tokens[at(document.tokens, offset, side)];
	const slot = slotAt(ancestors, offset, side);
	return {ancestors, ...(token && {token}), ...(slot && {slot})};
}

/**
Inspect only local trivia between syntax elements; comment contents never count as separators.
*/
function gap(document: EditorParseResult, start: number, end: number, canUseCommas: boolean): {valid: boolean; separated: boolean} {
	let position = start;
	let isSeparated = false;
	let isComma = false;
	let index = lowerBound(document.tokens, start);
	while (position < end) {
		const token = document.tokens[index];
		const stop = Math.min(end, token?.range[0] ?? end);
		for (; position < stop; position++) {
			const character = document.text[position];
			if (character === '\n') {
				isSeparated = true;
			} else if (character !== ' ' && character !== '\t') {
				return {valid: false, separated: isSeparated};
			}
		}

		if (position === end) {
			break;
		}

		if (!token || token.range[1] > end) {
			return {valid: false, separated: isSeparated};
		}

		if (canUseCommas && !isSeparated && !isComma && token.kind === 'punctuation' && document.text[token.range[0]] === ',') {
			isComma = true;
		} else if ((token.kind !== 'lineComment' && token.kind !== 'blockComment') || (token.kind === 'blockComment' && document.text.slice(token.range[1] - 2, token.range[1]) !== '*/')) {
			return {valid: false, separated: isSeparated};
		}

		position = token.range[1];
		index++;
	}

	return {valid: true, separated: isSeparated || isComma};
}

function endOfEntry(node: EditorNode): number {
	return node.type === 'EditorMember' && node.value.type === 'EditorMissing' ? node.colonRange?.[1] ?? node.key.range[1] : node.range[1];
}

function canInsertBeforeEntry(document: EditorParseResult, owner: EditorObject | EditorArray, start: number): boolean {
	const entries = owner.type === 'EditorObject' ? owner.members : owner.elements;
	const previous = entries[lowerBound(entries, start) - 1];
	if (previous?.type === 'EditorError') {
		return false;
	}

	const isBraced = owner.type === 'EditorArray' || owner.braced;
	const result = gap(document, previous ? endOfEntry(previous) : owner.range[0] + (isBraced ? 1 : 0), start, isBraced);
	return result.valid && (!previous || result.separated);
}

function canInsertAfterEntry(document: EditorParseResult, owner: EditorObject | EditorArray, end: number): boolean {
	const entries = owner.type === 'EditorObject' ? owner.members : owner.elements;
	const next = entries[lowerBound(entries, end)];
	const isBraced = owner.type === 'EditorArray' || owner.braced;
	const boundary = owner.closingRange?.[0] ?? owner.range[1];
	if (end > boundary) {
		return false;
	}

	// A comma can itself be a recovered error entry when an array value is missing.
	if (next?.type === 'EditorError' && document.text[next.range[0]] === ',') {
		const result = gap(document, end, next.range[0], false);
		return isBraced && result.valid && !result.separated;
	}

	const result = gap(document, end, next?.range[0] ?? boundary, isBraced);
	return result.valid && (!next || result.separated);
}

/**
Find an eligible completion site without reparsing or choosing suggestions. Returns a grammatical slot, ancestors, an optional token, the whole-token replacement range, and the source prefix before the cursor. Empty sites have a zero-width range. Key slots expose an existing member's `colonRange`; replace only the key when that colon exists.

Completion supports unquoted keys and scalar tokens, empty member values and collection entries, and empty documents. It is suppressed inside strings and comments, before existing values separated by whitespace, and at ambiguous or unsupported recovery boundaries. It never adds separators or repairs surrounding syntax. Eligibility does not imply the whole document is valid. Returns `undefined` beyond EOF or when no supported completion applies.

@param document - An unchanged snapshot from `parseForEditor()`.
@param offset - A non-negative safe integer UTF-16 offset.
@throws {TypeError} For an invalid offset.

@example
```
import {parseForEditor, getCompletionContext} from 'soml-lang';

const document = parseForEditor('enabled: tr');
const context = getCompletionContext(document, 11);
context?.prefix;
//=> 'tr'
context?.range;
//=> [9, 11]
```
*/
export function getCompletionContext(document: EditorParseResult, offset: number): EditorCompletionContext | undefined {
	let context = getEditorContext(document, offset, {side: 'left'});
	if (!context) {
		return undefined;
	}

	const left = context.token;
	const right = document.tokens[at(document.tokens, offset, 'right')];
	for (const token of [left, right]) {
		if (token && offset > token.range[0] && (token.kind === 'lineComment' || (token.kind === 'blockComment' && (offset < token.range[1] || document.text.slice(token.range[1] - 2, token.range[1]) !== '*/')))) {
			return undefined;
		}
	}

	let token = left?.kind === 'key' || left?.kind === 'scalar' ? left : undefined;
	if (!token && (right?.kind === 'key' || right?.kind === 'scalar')) {
		token = right;
		context = getEditorContext(document, offset)!;
	}

	const range: EditorRange = token?.range ?? [offset, offset];
	const {slot} = context;
	if (!slot || (context.token?.kind === 'string' && offset < context.token.range[1])) {
		return undefined;
	}

	switch (slot.kind) {
		case 'member-value': {
			const {owner} = slot;
			const object = context.ancestors.findLast(node => node.type === 'EditorObject');
			if (!object || (owner.value.type !== 'EditorMissing' && (token?.range[0] !== owner.value.range[0] || token.range[1] !== owner.value.range[1])) || !gap(document, owner.colonRange![1], range[0], false).valid || !canInsertAfterEntry(document, object, range[1])) {
				return undefined;
			}

			break;
		}

		case 'key': {
			if ((token !== undefined && (token.range[0] !== slot.member?.key.range[0] || token.range[1] !== slot.member?.key.range[1])) || !canInsertBeforeEntry(document, slot.owner, range[0]) || (!slot.member?.colonRange && !canInsertAfterEntry(document, slot.owner, range[1]))) {
				return undefined;
			}

			break;
		}

		case 'array-element': {
			if (!canInsertBeforeEntry(document, slot.owner, range[0]) || !canInsertAfterEntry(document, slot.owner, range[1])) {
				return undefined;
			}

			break;
		}

		default: {if (!gap(document, 0, offset, false).valid || !gap(document, offset, document.text.length, false).valid) {
			return undefined;
		}}
	}

	return {
		...context, slot, range, prefix: document.text.slice(range[0], offset),
	};
}
