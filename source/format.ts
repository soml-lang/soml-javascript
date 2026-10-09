import {
	type EditorNode,
	type EditorDocument,
	type EditorMember,
	type EditorObject,
	type EditorArray,
} from './editor.ts';
import {
	parseTree,
	type DocumentNode,
	type Comment,
	type MemberNode,
	type ValueNode,
	type Node,
	type ObjectNode,
	type ArrayNode,
} from './tree.ts';
import {
	describeOption,
	getOwnOption,
	ASTERISK,
	COMMA,
	HASH,
	SLASH,
	findLineEnd,
	isSameLine,
	lowerBound,
	isSpace,
	skipSpaces,
	skipSpacesBack,
	LF,
	readRange,
	type TextRange,
	hasBlankLine,
} from './shared.ts';

const INDENT = '\t';

/**
Format a document. Returns the document with its layout normalized, ending with one line feed.

The layout follows the formatter in the specification: one tab per level, every member and item on its own line with no commas, and no trailing whitespace or runs of blank lines. An object or an array whose brackets are on one line stays on one line, as in `ports: [80, 443]`, with a comma and a space between its members or items. To give a one-line container one member or item per line, put a line break anywhere inside it. Comments, member order, block strings, and the spelling of every value stay as they are, so the value never changes. The one change inside a block comment is the same layout rule: trailing whitespace is removed, and runs of blank lines collapse to one.

In detail, as the specification states:

- A block comment that a value follows on the same line, as in `1, /* note *\/ 2`, stays in front of that value when each item goes on its own line.
- One space follows each `:`, as in canonical form.
- A value on the line after its `key:` moves up to that line, unless a comment comes between them. Then it stays on its own line, one level deeper than the key, and the blank lines between them are removed.
- A block string begins on the line after its key, and its delimiters and content have the indentation of that line. Its lines are not otherwise changed.
- There are no blank lines at the start of the file or directly inside brackets.

@param text - The document.
@returns The formatted document, ending with one line feed.
@throws {ParseError} When the document is not valid, the same as `parse()`.
@throws {TypeError} When `text` is not a string.

@example
```
import {format} from 'soml-lang';

format('pool: {min: 2,   max: 16,} # Connections');
//=> 'pool: {min: 2, max: 16} # Connections\n'

format('pool: {\nmin: 2, max: 16}');
//=> 'pool: {\n\tmin: 2\n\tmax: 16\n}\n'
```
*/
export function format(text: string): string {
	return new Printer(text, parseTree(text)).print();
}

/**
A change to a document: a range of its text, and the text that replaces it.
*/
export type FormatEdit = {
	/**
	The start and end of the replaced text, as UTF-16 offsets into the document. They are equal when the edit only inserts.
	*/
	readonly range: TextRange;

	/**
	The text that replaces the range. It is empty when the edit only removes.
	*/
	readonly text: string;
};

/**
The changes that `format()` makes to a document, as edits of its text. For an editor or a linter that applies each change in place.

The edits are sorted, do not overlap, and change only spaces, tabs, line feeds, and commas, as `format()` does. Each one is as small as possible, so it leaves out the characters at its ends that stay the same. Applying all of them gives the same text as `format()`, and a document that is already formatted gives no edits.

@param text - The document.
@returns The edits, in the order of their ranges.
@throws {ParseError} When the document is not valid, the same as `parse()`.
@throws {TypeError} When `text` is not a string.

@example
```
import {formatEdits} from 'soml-lang';

formatEdits('a: [1,\n2]\n');
//=> [{range: [4, 4], text: '\n\t'}, {range: [5, 7], text: '\n\t'}, {range: [8, 8], text: '\n'}]
```
*/
export function formatEdits(text: string): FormatEdit[] {
	return layoutEdits(text, format(text));
}

/**
Options for formatting one collection.
*/
export type CollectionFormatOptions = {
	/**
	Preserve the existing layout, expand the outer collection to multiline, or compact the entire subtree. Compact layout returns `undefined` when any comment or block string is present. Empty collections stay compact. Nested collections keep their layout except when compacting.

	@default 'preserve'

	@example
	```
	formatCollectionEdits('[1, 2]', [0, 6], {layout: 'multiline'});
	//=> [{range: [1, 1], text: '\n\t'}, {range: [2, 4], text: '\n\t'}, {range: [5, 5], text: '\n'}]
	```
	*/
	readonly layout?: 'preserve' | 'multiline' | 'compact';

	/**
	The collection's indentation level, from 0 to 1000. Each level is one tab. This affects lines inside the range, including the closing delimiter, but does not insert indentation before the opening delimiter.

	@default `0` for text and a range, and inferred from the ancestors for a snapshot and a collection node

	@example
	```
	formatCollectionEdits('[1,\n2]', [0, 6], {indentationLevel: 1});
	//=> [{range: [1, 1], text: '\n\t\t'}, {range: [2, 4], text: '\n\t\t'}, {range: [5, 5], text: '\n\t'}]
	```
	*/
	readonly indentationLevel?: number;
};

/**
Source text and its syntax tree, for `formatCollectionEdits()`. Accepts a `parseForEditor()` snapshot, or `{text, root: parseTree(text)}`. The tree and text must describe the same unchanged document.
*/
export type CollectionFormatSnapshot = {
	/**
	The unchanged source text that produced the tree.

	@example
	```
	'ports: [80, 443]'
	```
	*/
	readonly text: string;

	/**
	The strict or recovered tree for `text`.

	@example
	```
	parseTree('ports: [80, 443]');
	```
	*/
	readonly root: DocumentNode | EditorDocument;
};

type Collection = ObjectNode | ArrayNode | EditorObject | EditorArray;
type NonCompactOptions = CollectionFormatOptions & {readonly layout?: 'preserve' | 'multiline'};

/**
Format exactly one braced object or array, returning sorted, non-overlapping layout edits with UTF-16 ranges into the original document. Accepts text and an exact opening-through-closing delimiter range, or a syntax snapshot and a collection node belonging to it. A snapshot is a `parseForEditor()` result or `{text, root: parseTree(text)}`. Snapshot input derives indentation from ancestor collections and values below their keys; `indentationLevel` overrides it. Text/range input defaults to level zero.

Only the selected text is strictly parsed. Errors elsewhere do not prevent formatting, and no text outside the range is changed or validated. No final newline is added. Compact layout compacts all nested collections and returns `undefined` if any comment or block string prevents it; an already formatted collection returns `[]`. Other layouts preserve nested collection layout.

Snapshots and nodes must describe the unchanged source text.

@param text - The document, or a snapshot of it.
@param range - The range of the collection, from its opening through its closing bracket, or a collection node of the snapshot.
@param options - The layout and the indentation level.
@returns The edits, in the order of their ranges, or `undefined` when the compact layout cannot be used.
@throws {ParseError} When the selected text is not a valid, complete collection, with positions relative to the selected text.
@throws {TypeError} When the arguments are not text and a range, or a snapshot and one of its collections, when the range does not exactly cover a braced object or array, or when `options` is invalid.
@throws {RangeError} When the range is empty or outside the text, or when `indentationLevel` is not an integer from 0 to 1000.

@example
```
import {formatCollectionEdits, parseForEditor} from 'soml-lang';

const snapshot = parseForEditor('ports: [80, 443]\nbroken:');
const collection = snapshot.root.children[0].members[0].value;
formatCollectionEdits(snapshot, collection, {layout: 'multiline'});
//=> [{range: [8, 8], text: '\n\t'}, {range: [10, 12], text: '\n\t'}, {range: [15, 15], text: '\n'}]
```
*/
export function formatCollectionEdits(text: string, range: readonly [start: number, end: number], options?: NonCompactOptions): FormatEdit[];
export function formatCollectionEdits(snapshot: CollectionFormatSnapshot, collection: Collection, options?: NonCompactOptions): FormatEdit[];
export function formatCollectionEdits(text: string, range: readonly [start: number, end: number], options?: CollectionFormatOptions): FormatEdit[] | undefined;
export function formatCollectionEdits(snapshot: CollectionFormatSnapshot, collection: Collection, options?: CollectionFormatOptions): FormatEdit[] | undefined;
export function formatCollectionEdits(document: string | CollectionFormatSnapshot, target: readonly [number, number] | Collection, options: CollectionFormatOptions = {}): FormatEdit[] | undefined {
	const isText = typeof document === 'string';
	if (isText !== Array.isArray(target)) {
		throw new TypeError('Expected text and a range, or a snapshot and one of its collections');
	}

	const text = isText ? document : document?.text;
	const range = isText ? target as readonly [number, number] : (target as Collection | undefined)?.range;
	const offsets = readRange(range);
	if (typeof text !== 'string' || offsets === undefined) {
		throw new TypeError('Expected text and a pair of integer offsets, or a snapshot and one of its collections');
	}

	const [start, end] = offsets;

	if (start < 0 || end <= start || end > text.length) {
		throw new RangeError('The collection range must be non-empty and within the document');
	}

	const requestedLayout = getOwnOption(options, 'layout');
	if (requestedLayout !== undefined && requestedLayout !== 'preserve' && requestedLayout !== 'multiline' && requestedLayout !== 'compact') {
		throw new TypeError(`The \`layout\` option must be 'preserve', 'multiline', or 'compact', got ${describeOption(requestedLayout)}`);
	}

	const layout = requestedLayout ?? 'preserve';

	const inferredLevel = isText ? 0 : collectionIndentation(document, target as Collection);
	const requestedLevel = getOwnOption(options, 'indentationLevel');
	if (requestedLevel !== undefined && (typeof requestedLevel !== 'number' || !Number.isSafeInteger(requestedLevel) || requestedLevel < 0 || requestedLevel > 1000)) {
		throw new RangeError(`The \`indentationLevel\` option must be an integer from 0 to 1000, got ${typeof requestedLevel === 'number' ? requestedLevel : typeof requestedLevel}`);
	}

	const indentationLevel = requestedLevel ?? inferredLevel;

	const source = text.slice(start, end);
	const tree = parseTree(source);
	const {body} = tree;
	const isCollection = body.type === 'Array' || (body.type === 'Object' && body.braced);
	if (!isCollection || body.range[0] !== 0 || body.range[1] !== source.length) {
		throw new TypeError('The range must exactly cover a braced object or array');
	}

	const formatted = layout === 'compact'
		? (tree.comments.length === 0 ? compact(body, source) : undefined)
		: new Printer(source, tree).printCollection(indentationLevel, layout === 'multiline');

	if (formatted === undefined) {
		return undefined;
	}

	const edits = layoutEdits(source, formatted);
	return start === 0 ? edits : edits.map(edit => ({range: [start + edit.range[0], start + edit.range[1]], text: edit.text}));
}

/**
The canonical indentation contributed by ancestors before a collection, including values placed below their keys. Node identity also verifies snapshot ownership.
*/
function collectionIndentation(snapshot: CollectionFormatSnapshot, target: Collection): number {
	let node: Node | EditorNode | undefined = snapshot.root;
	let level = 0;
	while (node) {
		const isCollection = node.type === 'Array' || node.type === 'EditorArray' || ((node.type === 'Object' || node.type === 'EditorObject') && node.braced);
		if (isCollection && node === target) {
			return level;
		}

		const isContinuation = (node.type === 'Member' || node.type === 'EditorMember') && isBelowKey(snapshot.text, node);
		if (isCollection || isContinuation) {
			level++;
		}

		if (node.type === 'Document') {
			node = node.body;
			continue;
		}

		if (node.type === 'Member' || node.type === 'EditorMember') {
			node = node.value;
			continue;
		}

		const children = collectionChildren(node);
		const child = children?.[lowerBound(children, target.range[0] + 1) - 1];
		node = child && child.range[1] >= target.range[1] ? child : undefined;
	}

	throw new TypeError('The collection must belong to the supplied snapshot');
}

/*
Whether the value of `member` is on a line below its key, as `format()` keeps a value after a comment. A line break inside a block comment does not count, and the one that ends a line comment does.
*/
function isBelowKey(text: string, member: MemberNode | EditorMember): boolean {
	const end = member.value.range[0];

	for (let offset = member.key.range[1]; offset < end; offset++) {
		const code = text.charCodeAt(offset);

		if (code === LF) {
			return true;
		}

		if (code === HASH) {
			const lineEnd = text.indexOf('\n', offset);
			return lineEnd !== -1 && lineEnd < end;
		}

		if (code !== SLASH || text.charCodeAt(offset + 1) !== ASTERISK) {
			continue;
		}

		const commentEnd = text.indexOf('*/', offset + 2);

		if (commentEnd === -1) {
			return false;
		}

		offset = commentEnd + 1;
	}

	return false;
}

function collectionChildren(node: Node | EditorNode): ReadonlyArray<Node | EditorNode> | undefined {
	switch (node.type) {
		case 'EditorDocument': {
			return node.children;
		}

		case 'Object':
		case 'EditorObject': {
			return node.members;
		}

		case 'Array':
		case 'EditorArray': {
			return node.elements;
		}

		default: {
			return undefined;
		}
	}
}

/**
Compact a comment-free subtree without serializing or changing its scalar values. Join one shared array of parts once, so ancestors do not copy the subtrees below them.
*/
function compact(node: ValueNode, text: string): string | undefined {
	const parts: string[] = [];
	function canWrite(value: ValueNode): boolean {
		if (value.type === 'String' && value.block) {
			return false;
		}

		if (value.type !== 'Object' && value.type !== 'Array') {
			parts.push(text.slice(...value.range));
			return true;
		}

		const entries = value.type === 'Object' ? value.members : value.elements;
		parts.push(value.type === 'Object' ? '{' : '[');
		// eslint-disable-next-line unicorn/no-for-loop -- Avoid allocating an index/value tuple for each compacted entry.
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index]!;
			if (index > 0) {
				parts.push(', ');
			}

			if (entry.type === 'Member') {
				parts.push(text.slice(...entry.key.range), ': ');
			}

			if (!canWrite(entry.type === 'Member' ? entry.value : entry)) {
				return false;
			}
		}

		parts.push(value.type === 'Object' ? '}' : ']');
		return true;
	}

	return canWrite(node) ? parts.join('') : undefined;
}

function layoutEdits(text: string, formatted: string): FormatEdit[] {
	if (text === formatted) {
		return [];
	}

	const edits: FormatEdit[] = [];
	let textIndex = 0;
	let formattedIndex = 0;

	// Without the characters that the formatter changes, the two texts are the same. So walking both at once, every run of those characters that differs is one edit, which takes linear time, where a general diff takes quadratic time on a document with many changes.
	while (textIndex < text.length || formattedIndex < formatted.length) {
		const textStart = textIndex;
		const formattedStart = formattedIndex;
		const textGapEnd = skipLayout(text, textIndex);
		const formattedGapEnd = skipLayout(formatted, formattedIndex);

		const replacement = formatted.slice(formattedIndex, formattedGapEnd);
		if (textGapEnd - textIndex !== replacement.length || !text.startsWith(replacement, textIndex)) {
			edits.push(createEdit(text, textIndex, textGapEnd, replacement));
		}

		textIndex = textGapEnd;
		formattedIndex = formattedGapEnd;

		while (textIndex < text.length && !isLayout(text.charCodeAt(textIndex)) && text.charCodeAt(textIndex) === formatted.charCodeAt(formattedIndex)) {
			textIndex++;
			formattedIndex++;
		}

		// Both stop at a different character, or one at its end, only when the formatter changed something else, and then the walk would never end.
		if (textIndex === textStart && formattedIndex === formattedStart) {
			throw new Error(`The formatter changed more than the layout at offset ${textIndex}. This is a bug in soml-lang.`);
		}
	}

	return edits;
}

/*
The characters that the formatter changes.
*/
function isLayout(code: number): boolean {
	return isSpace(code) || code === LF || code === COMMA;
}

/*
The end of the run of layout characters at `index`.
*/
function skipLayout(text: string, index: number): number {
	while (index < text.length && isLayout(text.charCodeAt(index))) {
		index++;
	}

	return index;
}

/*
The edit that replaces `text.slice(start, end)` with `replacement`, without the characters at its ends that stay the same, as in `, ` to `\n\t`.
*/
function createEdit(text: string, start: number, end: number, replacement: string): FormatEdit {
	let prefixLength = 0;

	while (start + prefixLength < end && prefixLength < replacement.length && text[start + prefixLength] === replacement[prefixLength]) {
		prefixLength++;
	}

	let suffixLength = 0;

	while (end - suffixLength > start + prefixLength && replacement.length - suffixLength > prefixLength && text[end - suffixLength - 1] === replacement[replacement.length - suffixLength - 1]) {
		suffixLength++;
	}

	return {
		range: [start + prefixLength, end - suffixLength],
		text: replacement.slice(prefixLength, replacement.length - suffixLength),
	};
}

type TrailingOptions = {
	readonly previousEnd: number;
	readonly itemEnd: number | undefined;
	readonly itemLineStart: number | undefined;
	readonly comma: number | undefined;
};

type ListOptions = {
	readonly start: number;
	readonly end: number;
	readonly level: number;
	readonly isBracketed: boolean;
};

class Printer {
	readonly #text: string;
	readonly #tree: DocumentNode;
	// Joined once at the end. Appending with `+=` builds a deep rope, and reading it one character at a time, as `formatEdits()` does, can take quadratic time once V8 deoptimizes the reader.
	readonly #output: string[] = [];
	#commentIndex = 0;
	#tokenIndex = 0;

	constructor(text: string, tree: DocumentNode) {
		this.#text = text;
		this.#tree = tree;
	}

	#write(text: string): void {
		this.#output.push(text);
	}

	/*
	Starts a new line at `level`, with one blank line before it when the source had one.
	*/
	#newLine(level: number, isBlank: boolean): void {
		// The first line of the file has no line break before it.
		if (this.#output.length === 0) {
			return;
		}

		this.#write(`${isBlank ? '\n\n' : '\n'}${INDENT.repeat(level)}`);
	}

	/*
	The next comment that ends at or before `end`, without consuming it.
	*/
	#peekComment(end: number): Comment | undefined {
		const comment = this.#tree.comments[this.#commentIndex];
		return comment !== undefined && comment.range[1] <= end ? comment : undefined;
	}

	#writeComment(comment: Comment): void {
		this.#commentIndex++;
		const text = this.#text.slice(...comment.range);

		if (comment.type === 'Line') {
			this.#write(trimTrailingWhitespace(text));
			return;
		}

		// The lines of a block comment keep their own indentation. Trailing whitespace is removed, and runs of blank lines collapse to one, as everywhere outside a block string.
		let wasBlank = false;

		for (let start = 0; start < text.length;) {
			const end = findLineEnd(text, start);
			const contentEnd = skipSpacesBack(text, end);
			const isBlank = contentEnd === start;

			if (!isBlank || !wasBlank) {
				if (start > 0) {
					this.#write('\n');
				}

				this.#write(text.slice(start, contentEnd));
			}

			wasBlank = isBlank;
			start = end + 1;
		}
	}

	/*
	The offset of the `,` after an item in the source, or `undefined` when there is none.
	*/
	#findComma(start: number, end: number): number | undefined {
		// Between two items there is only whitespace, comments, and at most one comma.
		const {tokens} = this.#tree;
		while (this.#tokenIndex < tokens.length && tokens[this.#tokenIndex]!.range[0] < start) {
			this.#tokenIndex++;
		}

		// A comma inside a comment is not a token. Source-order printing advances this cursor once through the tokens, without rescanning trivia.
		const token = tokens[this.#tokenIndex];
		return token?.value === ',' && token.range[0] < end ? token.range[0] : undefined;
	}

	/*
	Writes `items` one per line at `level`, with the comments between them, from `start` to `end` in the source.

	A comment on the line of the item before it, or of the opening bracket, stays at the end of that line. The exception is a block comment after the comma that the next item follows on the same line, as in `[1, /* note *\/ 2]`: it stays in front of that item. Every other comment starts a new line, and a comment or an item that follows a block comment on its line stays on that line.
	*/
	#list(items: ReadonlyArray<MemberNode | ValueNode>, {start, end, level, isBracketed}: ListOptions): void {
		let previousEnd = start;
		let itemEnd: number | undefined;
		// Whether a comment may stay at the end of the line before it, which needs an item or an opening bracket there.
		let canTrail = isBracketed;
		// Whether the list has written something other than a comment at the end of the opening bracket's line. A blank line is kept only after that, so none is left directly inside the bracket or at the start of the file.
		let hasWritten = false;
		let isOnSameLine = false;

		for (let index = 0; index <= items.length; index++) {
			const item = items[index];
			const itemStart = item?.range[0] ?? end;
			const comma = isBracketed ? this.#findComma(previousEnd, itemStart) : undefined;
			// Found once per item rather than once per comment, which would be quadratic in the number of comments on one line.
			const itemLineStart = item === undefined ? undefined : previousEnd + this.#text.slice(previousEnd, itemStart).lastIndexOf('\n') + 1;

			for (let comment = this.#peekComment(itemStart); comment !== undefined; comment = this.#peekComment(itemStart)) {
				const [commentStart, commentEnd] = comment.range;
				const isTrailing: boolean = canTrail && !isOnSameLine && this.#isTrailing(comment, {
					previousEnd,
					itemEnd,
					itemLineStart,
					comma,
				});

				if (isTrailing || isOnSameLine) {
					this.#write(' ');
				} else {
					this.#newLine(level, hasWritten && hasBlankLine(this.#text, previousEnd, commentStart));
				}

				this.#writeComment(comment);
				hasWritten ||= !isTrailing;

				// A block comment that the next comment or item follows on the same line keeps it on that line.
				const nextStart = this.#peekComment(itemStart)?.range[0] ?? itemStart;
				isOnSameLine = comment.type === 'Block' && !isTrailing && isSameLine(this.#text, commentEnd, nextStart);
				previousEnd = commentEnd;
			}

			if (item === undefined) {
				return;
			}

			if (isOnSameLine) {
				this.#write(' ');
			} else {
				this.#newLine(level, hasWritten && hasBlankLine(this.#text, previousEnd, itemStart));
			}

			this.#item(item, level);

			previousEnd = item.range[1];
			itemEnd = previousEnd;
			canTrail = true;
			hasWritten = true;
			isOnSameLine = false;
		}
	}

	/*
	Whether a comment stays at the end of the line before it. That line ends at the item before it, or at the comma after that item.
	*/
	#isTrailing(comment: Comment, {previousEnd, itemEnd, itemLineStart, comma}: TrailingOptions): boolean {
		const [commentStart, commentEnd] = comment.range;
		const isAfterComma = comma !== undefined && commentStart > comma;

		// A block comment after the comma that the next item follows on the same line stays in front of that item. The comment ends on the item's line when it ends after the start of that line.
		if (itemLineStart !== undefined && comment.type === 'Block' && (comma === undefined || isAfterComma) && commentEnd >= itemLineStart) {
			return false;
		}

		// A comment after the comma ends the comma's line, which is later than the item's when a block comment that spans lines comes between them. The comma is removed, so the comment moves to the end of the item's line, which only holds when nothing came between them.
		const lineEnd = isAfterComma && previousEnd === itemEnd ? comma + 1 : previousEnd;
		return isSameLine(this.#text, lineEnd, commentStart);
	}

	/*
	Writes a container that is on one line in the source on one line, with a comma and a space between its members or items and no trailing comma. Only a block comment can be inside it, and each one stays where it is among the items and commas.
	*/
	#oneLine(items: ReadonlyArray<MemberNode | ValueNode>, {start, end, level}: Omit<ListOptions, 'isBracketed'>, opening: string, closing: string): void {
		this.#write(opening);
		let previousEnd = start + 1;
		let hasWrittenToken = false;

		for (let index = 0; index <= items.length; index++) {
			const item = items[index];
			const itemStart = item?.range[0] ?? (end - 1);
			// The comma after the last item is left out.
			const comma = item === undefined ? undefined : this.#findComma(previousEnd, itemStart);
			let hasWrittenComma = false;

			for (let comment = this.#peekComment(itemStart); comment !== undefined; comment = this.#peekComment(itemStart)) {
				if (!hasWrittenComma && comma !== undefined && comma < comment.range[0]) {
					this.#write(',');
					hasWrittenComma = true;
				}

				if (hasWrittenToken) {
					this.#write(' ');
				}

				this.#writeComment(comment);
				hasWrittenToken = true;
			}

			if (item === undefined) {
				break;
			}

			if (comma !== undefined && !hasWrittenComma) {
				this.#write(', ');
			} else if (hasWrittenToken) {
				this.#write(' ');
			}

			this.#item(item, level);
			previousEnd = item.range[1];
			hasWrittenToken = true;
		}

		this.#write(closing);
	}

	#item(item: MemberNode | ValueNode, level: number): void {
		if (item.type === 'Member') {
			this.#member(item, level);
		} else {
			this.#value(item, level);
		}
	}

	#member(member: MemberNode, level: number): void {
		const {key, value} = member;
		this.#write(`${this.#text.slice(...key.range)}:`);

		const isBlockString = value.type === 'String' && value.block;

		if (this.#peekComment(value.range[0]) === undefined) {
			// A block string begins on the next line, one level deeper, so its delimiters and content line up.
			if (isBlockString) {
				this.#newLine(level + 1, false);
				this.#value(value, level + 1);
				return;
			}

			this.#write(' ');
			this.#value(value, level);
			return;
		}

		// With comments between the `:` and the value, the line breaks between them are kept, but not the blank lines, and a value on a new line is one level deeper.
		let previousEnd = key.range[1] + 1;
		let valueLevel = level;

		for (let comment = this.#peekComment(value.range[0]); comment !== undefined; comment = this.#peekComment(value.range[0])) {
			if (this.#writeSeparator(previousEnd, comment.range[0], level + 1)) {
				valueLevel = level + 1;
			}

			this.#writeComment(comment);
			previousEnd = comment.range[1];
		}

		if (isBlockString) {
			this.#newLine(level + 1, false);
			valueLevel = level + 1;
		} else if (this.#writeSeparator(previousEnd, value.range[0], level + 1)) {
			valueLevel = level + 1;
		}

		this.#value(value, valueLevel);
	}

	/*
	A space when `end` is on the line of `start` in the source, and otherwise a new line at `level`. Returns whether it started a new line.
	*/
	#writeSeparator(start: number, end: number, level: number): boolean {
		if (isSameLine(this.#text, start, end)) {
			this.#write(' ');
			return false;
		}

		this.#newLine(level, false);
		return true;
	}

	#value(node: ValueNode, level: number, isMultiline = false): void {
		const [start, end] = node.range;

		if (node.type === 'Object' || node.type === 'Array') {
			const opening = node.type === 'Object' ? '{' : '[';
			const closing = node.type === 'Object' ? '}' : ']';
			const items = node.type === 'Object' ? node.members : node.elements;

			// Every comment before the container is already written, so a next comment that ends by `end` is inside it. A container that holds only comments is not empty.
			if (items.length === 0 && this.#peekComment(end) === undefined) {
				this.#write(opening + closing);
				return;
			}

			if (!isMultiline && isSameLine(this.#text, start, end)) {
				this.#oneLine(items, {start, end, level}, opening, closing);
				return;
			}

			this.#write(opening);
			this.#list(items, {
				start: start + 1,
				end: end - 1,
				level: level + 1,
				isBracketed: true,
			});
			this.#newLine(level, false);
			this.#write(closing);
			return;
		}

		const text = this.#text.slice(start, end);
		this.#write(node.type === 'String' && node.block ? reindentBlockString(text, INDENT.repeat(level)) : text);
	}

	printCollection(level: number, isMultiline: boolean): string {
		this.#value(this.#tree.body, level, isMultiline);
		return this.#output.join('');
	}

	print(): string {
		const {body} = this.#tree;
		const items = body.type === 'Object' && !body.braced ? body.members : [body];

		// The document is a list without brackets: the members of a brace-less object, or one braced collection.
		this.#list(items, {
			start: 0,
			end: this.#text.length,
			level: 0,
			isBracketed: false,
		});

		this.#output.push('\n');
		return this.#output.join('');
	}
}

/*
Only spaces and tabs are whitespace in SOML. Any other character, such as a no-break space, is content.
*/
function trimTrailingWhitespace(text: string): string {
	// A loop rather than a regular expression, which would take quadratic time on a long run of spaces inside a line.
	return text.slice(0, skipSpacesBack(text, text.length));
}

/*
Moves a block string to a new indentation. Its content is relative to the closing delimiter's indentation, so replacing that indentation on every line keeps the value. A blank line is left as it is, because it becomes an empty line either way.
*/
function reindentBlockString(text: string, indentation: string): string {
	const closingStart = text.lastIndexOf('\n') + 1;
	const oldIndentationLength = skipSpaces(text, closingStart) - closingStart;
	if (text.startsWith(indentation, closingStart) && indentation.length === oldIndentationLength) {
		return text;
	}

	const parts: string[] = [];
	let unchangedStart = 0;

	// The first line starts at the opening delimiter, after the indentation that the caller already wrote.
	for (let start = text.indexOf('\n') + 1; start < text.length;) {
		const end = findLineEnd(text, start);

		if (skipSpaces(text, start) !== end) {
			parts.push(text.slice(unchangedStart, start), indentation);
			unchangedStart = start + oldIndentationLength;
		}

		start = end + 1;
	}

	parts.push(text.slice(unchangedStart));
	return parts.join('');
}
