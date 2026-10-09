import {
	parseTree,
	type DocumentNode,
	type Comment,
	type MemberNode,
	type ValueNode,
} from './tree.ts';
import {
	ASTERISK,
	isBlankLine,
	COMMA,
	HASH,
	SLASH,
	findLineEnd,
	isSpace,
	skipSpaces,
	skipSpacesBack,
	LF,
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
	readonly range: readonly [start: number, end: number];

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
	const formatted = format(text);
	const edits: FormatEdit[] = [];
	let textIndex = 0;
	let formattedIndex = 0;

	// Without the characters that the formatter changes, the two texts are the same. So walking both at once, every run of those characters that differs is one edit, which takes linear time, where a general diff takes quadratic time on a document with many changes.
	while (textIndex < text.length || formattedIndex < formatted.length) {
		const textStart = textIndex;
		const formattedStart = formattedIndex;
		const textGapEnd = skipLayout(text, textIndex);
		const formattedGapEnd = skipLayout(formatted, formattedIndex);

		if (text.slice(textIndex, textGapEnd) !== formatted.slice(formattedIndex, formattedGapEnd)) {
			edits.push(createEdit(text, textIndex, textGapEnd, formatted.slice(formattedIndex, formattedGapEnd)));
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
	previousEnd: number;
	itemEnd: number | undefined;
	itemLineStart: number | undefined;
	comma: number | undefined;
};

type ListOptions = {
	start: number;
	end: number;
	level: number;
	isBracketed: boolean;
};

class Printer {
	readonly #text: string;
	readonly #tree: DocumentNode;
	// Joined once at the end. Appending with `+=` builds a deep rope, and reading it one character at a time, as `formatEdits()` does, can take quadratic time once V8 deoptimizes the reader.
	readonly #output: string[] = [];
	#commentIndex = 0;

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

	#isSameLine(start: number, end: number): boolean {
		return !this.#text.slice(start, end).includes('\n');
	}

	/*
	Whether a line between `start` and `end` holds only spaces and tabs, if anything.
	*/
	#hasBlankLine(start: number, end: number): boolean {
		// A slice, so that the search for a line break stops at `end`.
		const gap = this.#text.slice(start, end);

		for (let index = gap.indexOf('\n'); index !== -1; index = gap.indexOf('\n', index + 1)) {
			index = skipSpaces(gap, index + 1);

			if (gap.charCodeAt(index) === LF) {
				return true;
			}
		}

		return false;
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

		if (comment.type === 'Line') {
			this.#write(trimTrailingWhitespace(`#${comment.value}`));
			return;
		}

		// The lines of a block comment keep their own indentation. Trailing whitespace is removed, and runs of blank lines collapse to one, as everywhere outside a block string.
		const lines = `/*${comment.value}*/`.split('\n').map(line => trimTrailingWhitespace(line));
		this.#write(lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n'));
	}

	/*
	The offset of the `,` after an item in the source, or `undefined` when there is none.
	*/
	#findComma(start: number, end: number): number | undefined {
		const text = this.#text;

		// Between two items there is only whitespace, comments, and at most one comma.
		for (let index = start; index < end; index++) {
			const code = text.charCodeAt(index);

			if (code === COMMA) {
				return index;
			}

			// A comma inside a comment is not one. Each jump lands on the line feed after a line comment, or on the `/` of a block comment's end, and the loop steps past it.
			if (code === HASH) {
				index = findLineEnd(text, index);
			} else if (code === SLASH && text.charCodeAt(index + 1) === ASTERISK) {
				index = text.indexOf('*/', index + 2) + 1;
			}
		}

		return undefined;
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

		for (const item of [...items, undefined]) {
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
					this.#newLine(level, hasWritten && this.#hasBlankLine(previousEnd, commentStart));
				}

				this.#writeComment(comment);
				hasWritten ||= !isTrailing;

				// A block comment that the next comment or item follows on the same line keeps it on that line.
				const nextStart = this.#peekComment(itemStart)?.range[0] ?? itemStart;
				isOnSameLine = comment.type === 'Block' && !isTrailing && this.#isSameLine(commentEnd, nextStart);
				previousEnd = commentEnd;
			}

			if (item === undefined) {
				return;
			}

			if (isOnSameLine) {
				this.#write(' ');
			} else {
				this.#newLine(level, hasWritten && this.#hasBlankLine(previousEnd, itemStart));
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
		return this.#isSameLine(lineEnd, commentStart);
	}

	/*
	Writes a container that is on one line in the source on one line, with a comma and a space between its members or items and no trailing comma. Only a block comment can be inside it, and each one stays where it is among the items and commas.
	*/
	#oneLine(items: ReadonlyArray<MemberNode | ValueNode>, {start, end, level}: Omit<ListOptions, 'isBracketed'>, opening: string, closing: string): void {
		this.#write(opening);
		let previousEnd = start + 1;
		let hasWrittenToken = false;

		for (const item of [...items, undefined]) {
			const itemStart = item?.range[0] ?? (end - 1);
			// The comma after the last item is left out.
			const comma = item === undefined ? undefined : this.#findComma(previousEnd, itemStart);
			let hasWrittenComma = false;

			for (let comment = this.#peekComment(itemStart); comment !== undefined; comment = this.#peekComment(itemStart)) {
				if (!hasWrittenComma && comma !== undefined && comma < comment.range[0]) {
					this.#write(',');
					hasWrittenComma = true;
				}

				this.#write(hasWrittenToken ? ' ' : '');
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
		if (this.#isSameLine(start, end)) {
			this.#write(' ');
			return false;
		}

		this.#newLine(level, false);
		return true;
	}

	#value(node: ValueNode, level: number): void {
		const [start, end] = node.range;

		if (node.type === 'Object' || node.type === 'Array') {
			const [opening, closing] = node.type === 'Object' ? ['{', '}'] : ['[', ']'];
			const items = node.type === 'Object' ? node.members : node.elements;

			// Every comment before the container is already written, so a next comment that ends by `end` is inside it. A container that holds only comments is not empty.
			if (items.length === 0 && this.#peekComment(end) === undefined) {
				this.#write(opening + closing);
				return;
			}

			if (this.#isSameLine(start, end)) {
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
	const lines = text.split('\n');
	const closing = lines.at(-1)!;
	const oldIndentation = closing.slice(0, skipSpaces(closing, 0));

	// The first line starts at the opening delimiter, after the indentation that the caller already wrote.
	return lines.map((line, index) => index === 0 || isBlankLine(line) ? line : indentation + line.slice(oldIndentation.length)).join('\n');
}
