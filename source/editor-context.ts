import {
	getOwnOption,
	lowerBound,
	areRangesEqual,
	isOffsetInRange,
	requireOffset,
	isSpace,
	LF,
} from './shared.ts';
import type {
	EditorArray,
	EditorDocument,
	EditorMember,
	EditorNode,
	EditorObject,
	EditorParseResult,
	EditorRange,
	EditorToken,
	EditorValue,
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

function at(items: ReadonlyArray<{readonly range: EditorRange}>, offset: number, side: 'left' | 'right', next = lowerBound(items, offset)): number {
	const index = side === 'right' && items[next]?.range[0] === offset ? next : next - 1;
	const item = items[index];
	return item && isOffsetInRange(item.range, offset, side) ? index : -1;
}

function childAt(node: EditorNode, offset: number, side: 'left' | 'right', isAtEnd: boolean): EditorNode | undefined {
	if (node.type === 'EditorMember') {
		if (isOffsetInRange(node.value.range, offset, side) || (isAtEnd && node.value.range[1] === offset && isUnfinished(node.value))) {
			return node.value;
		}

		return isOffsetInRange(node.key.range, offset, side) ? node.key : undefined;
	}

	let descendants: readonly EditorNode[];
	switch (node.type) {
		case 'EditorDocument': {
			descendants = node.children;
			break;
		}

		case 'EditorObject': {
			descendants = node.members;
			break;
		}

		case 'EditorArray': {
			descendants = node.elements;
			break;
		}

		default: {
			return undefined;
		}
	}

	const child = descendants[at(descendants, offset, side)];
	if (child !== undefined || !isAtEnd) {
		return child;
	}

	const last = descendants.at(-1);
	return last?.range[1] === offset && isUnfinished(last) ? last : undefined;
}

function isUnfinished(node: EditorNode): boolean {
	if (node.type === 'EditorMember') {
		if (node.value.type === 'EditorMissing') {
			return true;
		}

		node = node.value;
	}

	return (node.type === 'EditorArray' || node.type === 'EditorObject') && !node.closingRange;
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
			if (isBraced(node) && (offset <= node.range[0] || (node.closingRange && offset > node.closingRange[0]))) {
				continue;
			}

			if (node.type === 'EditorObject') {
				// Missing values may be zero-width at EOF and therefore absent from ancestors.
				const previous = node.members[lowerBound(node.members, offset) - 1];
				return previous?.type === 'EditorMember' && previous.colonRange && previous.value.type === 'EditorMissing' && offset >= previous.colonRange[1] && offset <= previous.range[1] ? {kind: 'member-value', owner: previous} : {kind: 'key', owner: node};
			}

			const next = lowerBound(node.elements, offset);
			const found = at(node.elements, offset, side, next);
			return {kind: 'array-element', owner: node, index: found < 0 ? next : found};
		}
	}

	const root = ancestors[0];
	return root?.type === 'EditorDocument' && (root.children.length === 0 || offset <= root.children.at(0)!.range[0]) ? {kind: 'document', owner: root} : undefined;
}

/**
Describe syntax at a UTF-16 cursor offset without reparsing. The default affinity is `right`. Left affinity includes token ends and excludes starts; right affinity includes starts and excludes ends. Neither jumps across whitespace. The document is always an ancestor, including at EOF, and unfinished containers remain ancestors at EOF with either affinity. Zero-width missing nodes are represented through slots rather than selected as ancestors.

Nodes and tokens refer to the supplied `parseForEditor()` snapshot. A slot identifies syntactic ownership, including inside comments or before an existing value; it does not promise that insertion is valid. No values are evaluated and no semantic paths are inferred. Returns `undefined` beyond EOF.

Offsets are non-negative safe integer UTF-16 offsets; invalid offsets throw `TypeError`. Invalid options or affinity also throw `TypeError`. Only an own `side` property is read; inherited properties are ignored.

@param document - An unchanged snapshot from `parseForEditor()`.
@param offset - A non-negative safe integer UTF-16 offset.
@param options - Token boundary affinity.
@throws {TypeError} For an invalid offset, options, or affinity.

@example
```
import {parseForEditor, getEditorContext} from 'soml-lang';

const document = parseForEditor('port: ');
getEditorContext(document, 6)?.slot?.kind;
//=> 'member-value'
```
*/
export function getEditorContext(document: EditorParseResult, offset: number, options: EditorContextOptions = {}): EditorContext | undefined {
	requireOffset(offset);

	const requestedSide = getOwnOption(options, 'side');
	if (requestedSide !== undefined && requestedSide !== 'left' && requestedSide !== 'right') {
		throw new TypeError('Expected side to be left or right');
	}

	return offset > document.text.length ? undefined : contextAt(document, offset, requestedSide ?? 'right');
}

function contextAt(document: EditorParseResult, offset: number, side: 'left' | 'right'): EditorContext {
	const ancestors: EditorNode[] = [document.root];
	let node: EditorNode = document.root;
	const isAtEnd = offset === document.text.length;
	for (;;) {
		const child = childAt(node, offset, side, isAtEnd);
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
	if (start === end) {
		return {valid: true, separated: false};
	}

	let position = start;
	let isSeparated = false;
	let isComma = false;
	let index = lowerBound(document.tokens, start);
	while (position < end) {
		const token = document.tokens[index];
		const stop = Math.min(end, token?.range[0] ?? end);
		for (; position < stop; position++) {
			const code = document.text.charCodeAt(position);
			if (code === LF) {
				isSeparated = true;
			} else if (!isSpace(code)) {
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
		} else if ((token.kind !== 'lineComment' && token.kind !== 'blockComment') || (token.kind === 'blockComment' && !isClosedBlockComment(document, token))) {
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

/**
The source-ordered entries of a recovered object or array.
*/
function collectionEntries(owner: EditorObject | EditorArray): ReadonlyArray<EditorMember | EditorValue> {
	return owner.type === 'EditorObject' ? owner.members : owner.elements;
}

/**
Whether a recovered collection has explicit brackets.
*/
function isBraced(owner: EditorObject | EditorArray): boolean {
	return owner.type === 'EditorArray' || owner.braced;
}

function canInsertBeforeEntry(document: EditorParseResult, owner: EditorObject | EditorArray, start: number): boolean {
	const entries = collectionEntries(owner);
	const previous = entries[lowerBound(entries, start) - 1];
	if (previous?.type === 'EditorError') {
		return false;
	}

	const hasBrackets = isBraced(owner);
	const result = gap(document, previous ? endOfEntry(previous) : owner.range[0] + (hasBrackets ? 1 : 0), start, hasBrackets);
	return result.valid && (!previous || result.separated);
}

function canInsertAfterEntry(document: EditorParseResult, owner: EditorObject | EditorArray, end: number): boolean {
	const entries = collectionEntries(owner);
	const next = entries[lowerBound(entries, end)];
	const hasBrackets = isBraced(owner);
	const boundary = owner.closingRange?.[0] ?? owner.range[1];
	if (end > boundary) {
		return false;
	}

	// A comma can itself be a recovered error entry when an array value is missing.
	if (next?.type === 'EditorError' && document.text[next.range[0]] === ',') {
		const result = gap(document, end, next.range[0], false);
		return hasBrackets && result.valid && !result.separated;
	}

	const result = gap(document, end, next?.range[0] ?? boundary, hasBrackets);
	return result.valid && (!next || result.separated);
}

function isCompletionToken(token: EditorToken | undefined): token is EditorToken & {readonly kind: 'key' | 'scalar'} {
	return token?.kind === 'key' || token?.kind === 'scalar';
}

function isClosedBlockComment(document: EditorParseResult, token: EditorToken): boolean {
	return token.range[1] - token.range[0] >= 4 && document.text.startsWith('*/', token.range[1] - 2);
}

function isInsideComment(document: EditorParseResult, token: EditorToken | undefined, offset: number): boolean {
	return token !== undefined && offset > token.range[0] && (token.kind === 'lineComment' || (token.kind === 'blockComment' && (offset < token.range[1] || !isClosedBlockComment(document, token))));
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
	requireOffset(offset);
	if (offset > document.text.length) {
		return undefined;
	}

	let context = contextAt(document, offset, 'left');
	const left = context.token;
	const right = left && offset < left.range[1] ? left : document.tokens[at(document.tokens, offset, 'right')];
	if (isInsideComment(document, left, offset) || (right !== left && isInsideComment(document, right, offset))) {
		return undefined;
	}

	let token = isCompletionToken(left) ? left : undefined;
	if (!token && isCompletionToken(right)) {
		token = right;
		context = contextAt(document, offset, 'right');
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
			if (!object || (owner.value.type !== 'EditorMissing' && !areRangesEqual(token?.range, owner.value.range)) || !gap(document, owner.colonRange![1], range[0], false).valid || !canInsertAfterEntry(document, object, range[1])) {
				return undefined;
			}

			break;
		}

		case 'key': {
			if ((token !== undefined && !areRangesEqual(token.range, slot.member?.key.range)) || !canInsertBeforeEntry(document, slot.owner, range[0]) || (!slot.member?.colonRange && !canInsertAfterEntry(document, slot.owner, range[1]))) {
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

		default: {
			if (!gap(document, 0, offset, false).valid || !gap(document, offset, document.text.length, false).valid) {
				return undefined;
			}
		}
	}

	return {
		...context, slot, range, prefix: document.text.slice(range[0], offset),
	};
}
