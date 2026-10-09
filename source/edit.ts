import {type FormatEdit} from './format.ts';
import {parseWithTimes} from './parse.ts';
import {
	describeNodeType,
	parseTree,
	VALUE_NODE_TYPES,
	readPath,
	type ArrayNode,
	type Comment,
	type DocumentNode,
	type MemberNode,
	type ObjectNode,
	type PathSegment,
	type ValueNode,
} from './tree.ts';
import {
	formatKey,
	getStringStyle,
	type StringStyle,
	stringifyValueAt,
	getStringifyOptions,
	type StringifyOptions,
	type WriterOptions,
} from './stringify.ts';
import {
	abbreviate,
	describeKey,
	describeText,
	MAX_DEPTH,
	CLOSE_BRACE,
	CLOSE_BRACKET,
	COMMA,
	LF,
	isSameLine,
	findLineStart,
	lowerBound,
	skipSpaces,
	skipSpacesBack,
	skipWhitespace,
	areRangesEqual,
} from './shared.ts';

/**
Options for `edit()` and `editEdits()`, which write the new value as `stringify()` does.
*/
export type EditOptions = StringifyOptions & {
	/**
	Choose the replacement string's representation. An explicit style requires a string value and cannot be combined with `canonical: true`. Newly created parent objects use this style for the inserted string too. Existing surrounding values keep their spelling.

	@default 'auto'

	@example
	```
	edit('message: null', ['message'], 'hello', {stringStyle: 'block'});
	//=> "message:\n\t'''\n\thello\n\t'''"
	```
	*/
	readonly stringStyle?: StringStyle;
};

type Container = ObjectNode | ArrayNode;

type EditorOptions = {
	readonly text: string;
	readonly comments: readonly Comment[];
	readonly stringifyOptions: WriterOptions;
	readonly path: readonly PathSegment[];
	readonly value: unknown;
};

type Removal = {
	start: number;
	end: number;
	/*
	Whether it takes whole lines, which may leave a blank line next to another one.
	*/
	readonly isWholeLines: boolean;
};

type Replacement = {
	readonly start: number;
	readonly end: number;
	readonly text: string;
};

/**
Change one value in a document, and keep everything else as it is written: comments, member order, layout, and the spelling of every other value. For tools that update a config file, such as a dependency bumper or a `set` command.

Instead of a path, you can pass a member, item, or value node from `parseTree(text)`, such as one that a linter reported. The node and the text must come from the same document.

The value at `path` is replaced, or added when it does not exist yet, and an `undefined` value removes it. Only the changed part of the text is rewritten, and an edit to a formatted document leaves it formatted. The exception is a block string from the `stringStyle: 'block'` option, which is not always placed where `format()` puts it, such as after a comment or in a container on one line. The document is still valid.

- A new value is written as `stringify()` writes it, at the indentation of its line. So `0xFF` that is replaced by `255n` becomes `255`, and `8080` becomes `8080.0` unless you pass `8080n` or the `integers: 'number'` option. The members of a new object keep their order, unless you pass the `canonical: true` option. In a container that is on one line, it is written on one line too, so `[1, 2]` with a new item `{a: 3n}` becomes `[1, 2, {a: 3}]`.
- A new member goes after the last member of its object. Missing objects on the way are created.
- A new item can be added at the end of an array, with the index that is its length.
- A new member or item goes on its own line without a comma, after the comments that the one before it owns (see below), and the commas of the other members and items stay as they are. When something follows the member or item before it on the same line, such as the closing bracket of the one-line container `{a: 1}`, it goes on that line after a comma, as in `{a: 1, b: 2}`. In an empty `[]` or `{}`, it goes on a line of its own, unless that container is inside a container on one line, so `a: [1, []]` becomes `a: [1, [2]]`.
- A removed member or item takes the comments it owns, which in a formatted document are the ones that `format()` keeps with it: the comments after it on its line, also after its comma when nothing else follows there, and the block comments before it on its line, after the comma or bracket before it. So removing `2` from `[1, /* note *\/ 2]` gives `[1]`. A comment on a line of its own belongs to no member or item, so it stays. A removed member or item also removes its lines when nothing else is on them. A line that a block comment after it continues onto counts as one of its lines. Removing every item of a container closes it up to `[]` or `{}`, unless a comment is left inside.
- A removed member or item takes its comma with it. When the removed item is the last one and has no comma after it, it takes the comma directly before it instead, when only spaces, tabs, and the comments it owns are between, so `[1, 2]` becomes `[1]`.
- Removing the only member of a document without braces leaves `{}`.

Comments inside a value that is replaced or removed are removed with it. In a layout that `format()` never writes, an edit can leave odd spacing, such as a new item after a closing block string delimiter on its line that is indented differently from its neighbors. The document is always valid and has the right value. Removing a value that does not exist changes nothing and is not an error: a missing member, a missing object or array on the way, or an index at or past the end of its array. So removing the same path twice is safe, and `edit(text, path, undefined) === text` tells whether something was removed.

The result is parsed before it is returned, so a bug in `edit()` throws an `Error` rather than returning a broken document.

@param text - The document.
@param pathOrNode - The keys and array indexes that lead to the value, such as `['servers', 0, 'port']`, or a member or value node from `parseTree(text)` for the same document.
@param value - The new value, of the types that `stringify()` accepts, or `undefined` to remove the value.
@param options - Integer representation, member ordering, and the replacement string style.
@returns The changed document.
@throws {ParseError} When `text` is not a valid document.
@throws {TypeError} When `text` is not a string, when `pathOrNode` is not a non-empty array of keys and array indexes or a `MemberNode` or `ValueNode` of `parseTree(text)`, when it leads through a value that is not an object or an array, or when it has a key where an array is or an index where an object is. Also when `value` cannot be represented, or `options` is invalid, as for `stringify()`, and when an explicit `stringStyle` is used with a value that is not a string, with `canonical: true`, or with a string that the style cannot hold.
@throws {RangeError} When a value is set at an index past the end of its array, or at an index under a value that does not exist, or when the change would nest the document more than 100 levels deep. Also when `value` is out of range, as for `stringify()`.

@example
```
import {edit, parseTree} from 'soml-lang';

edit('name: \'api\' # The service\nport: 8080\n', ['port'], 9090n);
//=> "name: 'api' # The service\nport: 9090\n"

edit('postgres: {host: \'db\'}\n', ['postgres', 'port'], 5432n);
//=> "postgres: {host: 'db', port: 5432}\n"

edit('a: 1\nb: 2\n', ['a'], undefined);
//=> 'b: 2\n'

edit('port: 8080', ['port'], 9090, {integers: 'number'});
//=> 'port: 9090'

edit('a: 1\n', ['b'], {y: 1n, x: 2n}, {canonical: true});
//=> 'a: 1\nb: {\n\tx: 2\n\ty: 1\n}\n'

const tree = parseTree('name: \'api\'\nport: 8080\n');
edit('name: \'api\'\nport: 8080\n', tree.body.members[1], 9090n);
//=> "name: 'api'\nport: 9090\n"
```
*/
export function edit(text: string, pathOrNode: readonly PathSegment[] | MemberNode | ValueNode, value: unknown, options?: EditOptions): string {
	return createEditResult(text, pathOrNode, value, options).text;
}

/**
The changes that `edit()` makes, as text edits with UTF-16 ranges into the original document, for an editor that applies the change in place. An edit that changes nothing gives no edits.

Accepts the same paths, nodes, values, and options as `edit()`, preserves the same comments and layout, and performs the same validation, including parsing the resulting document before returning.

@param text - The document.
@param pathOrNode - The keys and array indexes that lead to the value, or a member or value node from `parseTree(text)`, as for `edit()`.
@param value - The new value, or `undefined` to remove the value, as for `edit()`.
@param options - Integer representation, member ordering, and the string style, as for `edit()`.
@returns The edits, in the order of their ranges. Applying them gives the same text as `edit()`.
@throws {ParseError} When `text` is not a valid document.
@throws {TypeError} In the same cases as `edit()`.
@throws {RangeError} In the same cases as `edit()`.

@example
```
import {editEdits} from 'soml-lang';

editEdits('port: 8080', ['port'], 9090n);
//=> [{range: [6, 10], text: '9090'}]
```
*/
export function editEdits(text: string, pathOrNode: readonly PathSegment[] | MemberNode | ValueNode, value: unknown, options?: EditOptions): FormatEdit[] {
	return createEditResult(text, pathOrNode, value, options).edits;
}

function createEditResult(text: string, pathOrNode: readonly PathSegment[] | MemberNode | ValueNode, value: unknown, options?: EditOptions): {text: string; edits: FormatEdit[]} {
	const segments = readPath(pathOrNode);
	if (Array.isArray(pathOrNode) && (segments === undefined || segments.length === 0)) {
		throw new TypeError('The path must be a non-empty array of keys and array indexes');
	}

	const stringifyOptions = {...getStringifyOptions(options), stringStyle: getStringStyle(options, 'stringStyle')};
	if (stringifyOptions.stringStyle !== 'auto' && (typeof value !== 'string' || stringifyOptions.canonical)) {
		throw new TypeError('The `stringStyle` option requires a string value, and cannot be combined with `canonical: true`');
	}

	const tree = parseTree(text);
	const path = segments ?? getPathOf(tree, pathOrNode as MemberNode | ValueNode);

	const replacement = new Editor({
		text,
		comments: tree.comments,
		stringifyOptions,
		path,
		value,
	}).replacement(tree.body);

	// One operation replaces, inserts, or removes one source range. A replacement that changes nothing is left out.
	if (replacement === undefined || (replacement.end - replacement.start === replacement.text.length && text.startsWith(replacement.text, replacement.start))) {
		return {text, edits: []};
	}

	const {start, end, text: replacementText} = replacement;
	const result = text.slice(0, start) + replacementText + text.slice(end);

	// The result is checked, so that a mistake here throws rather than writing a broken document.
	try {
		// `parseWithTimes()`, as in `parseTree()`, rather than `parse()`, which makes a `Temporal` object for each instant and duration, so that the check works without `Temporal`.
		parseWithTimes(result);
	} catch (error) {
		throw new Error(`edit() made an invalid document for the path ${describePath(path)}. This is a bug in soml-lang`, {cause: error});
	}

	return {text: result, edits: [{range: [start, end], text: replacementText}]};
}

class Editor {
	readonly #text: string;
	readonly #stringifyOptions: WriterOptions;
	readonly #path: readonly PathSegment[];
	/*
	The new value, or `undefined` to remove it.
	*/
	readonly #value: unknown;
	/*
	The end of each comment, by its start, so that the trivia between tokens can be skipped.
	*/
	readonly #commentEnds = new Map<number, number>();
	readonly #comments: readonly Comment[];
	/*
	Whether the container being edited is inside one that stays on one line, so that it stays on one line too. An edit follows one path, so one flag is enough.
	*/
	#isInsideOneLine = false;

	constructor({text, comments, stringifyOptions, path, value}: EditorOptions) {
		this.#text = text;
		this.#stringifyOptions = stringifyOptions;
		this.#path = path;
		this.#value = value;

		this.#comments = comments;

		for (const comment of comments) {
			const [start, end] = comment.range;
			this.#commentEnds.set(start, end);
		}
	}

	#editInArray(array: ArrayNode, index: number, depth: number): Replacement | undefined {
		const path = this.#path;
		const value = this.#value;
		const position = path[index]!;

		if (typeof position !== 'number') {
			throw new TypeError(`Cannot edit ${describePath(path)}, because ${describeParent(path, index)} is an array, so it needs an index, not a key`);
		}

		const element = array.elements[position];

		if (element === undefined) {
			// Removing an item that is not there changes nothing, at the end of the array or past it, and so does removing something below it.
			if (value === undefined) {
				return;
			}

			const count = array.elements.length;

			if (position !== count) {
				const items = count === 1 ? '1 item' : `${count} items`;
				const owner = index === 0 ? 'the document' : `the array at ${describeParent(path, index)}`;
				throw new RangeError(`Cannot edit ${describePath(path)}, because ${owner} has ${items}. Add an item at index ${count}`);
			}

			const newValue = nest(path, index + 1, value);
			return this.#insert(array, array.elements.at(-1), indentation => this.#valueText(newValue, depth + 1, indentation, array));
		}

		if (index < path.length - 1) {
			this.#isInsideOneLine = this.#isOneLine(array);
			return this.#descend(element, index + 1, depth + 1);
		}

		return value === undefined ? this.#removeNode(array, element) : this.#replace(element, depth + 1, array);
	}

	#editInObject(object: ObjectNode, index: number, depth: number): Replacement | undefined {
		const path = this.#path;
		const key = path[index];

		if (typeof key !== 'string') {
			throw new TypeError(`Cannot edit ${describePath(path)}, because ${describeParent(path, index)} is an object, so it needs a key, not an index`);
		}

		const value = this.#value;
		const member = object.members.find(member => member.key.value === key);

		if (member !== undefined) {
			if (index < path.length - 1) {
				this.#isInsideOneLine = this.#isOneLine(object);
				return this.#descend(member.value, index + 1, depth + 1);
			}

			return value === undefined ? this.#removeMember(object, member) : this.#replaceMemberValue(member, depth + 1, object);
		}

		if (value === undefined) {
			return;
		}

		const newValue = nest(path, index + 1, value);
		return this.#insert(object, object.members.at(-1), indentation => {
			const isBlock = typeof newValue === 'string' && this.#stringifyOptions.stringStyle === 'block';
			const valueIndentation = indentation + (isBlock ? '\t' : '');
			const separator = isBlock ? `\n${valueIndentation}` : ' ';
			return `${formatKey(key)}:${separator}${this.#valueText(newValue, depth + 1, valueIndentation, object)}`;
		});
	}

	/*
	Edits the path from `index` on, inside `node`, whose own depth is `depth`.
	*/
	#descend(node: ValueNode, index: number, depth: number): Replacement | undefined {
		if (node.type === 'Array') {
			return this.#editInArray(node, index, depth);
		}

		if (node.type === 'Object') {
			return this.#editInObject(node, index, depth);
		}

		throw new TypeError(`Cannot edit ${describePath(this.#path)}, because ${describeParent(this.#path, index)} is not an object or an array`);
	}

	/*
	Replaces `node`. A block string that would follow something on its line goes on the next line instead, one level deeper.
	*/
	#replace(node: ValueNode, depth: number, container: Container): Replacement {
		const [start, end] = node.range;
		const lineStart = findLineStart(this.#text, start);
		const indentation = this.#indentation(start, lineStart);

		if (this.#stringifyOptions.stringStyle === 'block' && skipSpaces(this.#text, lineStart) < start) {
			const blockIndentation = `${indentation}\t`;
			return {start: skipSpacesBack(this.#text, start), end, text: `\n${blockIndentation}${this.#valueText(this.#value, depth, blockIndentation, container)}`};
		}

		return {start, end, text: this.#valueText(this.#value, depth, indentation, container)};
	}

	/*
	Replaces the value of `member`. A block string begins on the line after its key, so a single-line replacement moves onto the key's line when only whitespace comes between the `:` and the old block string. Explicit block replacements keep their own line.
	*/
	#replaceMemberValue(member: MemberNode, depth: number, object: ObjectNode): Replacement {
		const {key, value} = member;
		// Nothing may come between a key and its `:`, so the `:` is the character right after the key.
		const colonEnd = key.range[1] + 1;

		// eslint-disable-next-line unicorn/prefer-ternary -- Keep the fallback separate from constructing the replacement.
		if (this.#stringifyOptions.stringStyle === 'block' || value.type !== 'String' || !value.block || skipWhitespace(this.#text, colonEnd) !== value.range[0]) {
			return this.#replace(value, depth, object);
		}

		return {start: colonEnd, end: value.range[1], text: ` ${this.#valueText(this.#value, depth, this.#indentation(member.range[0]), object)}`};
	}

	/*
	Removes `member`. Removing the only member of a document without braces leaves `{}` in its place, because a document is never empty, and the comments that the member owned stay.
	*/
	#removeMember(object: ObjectNode, member: MemberNode): Replacement {
		return object.braced || object.members.length > 1 ? this.#removeNode(object, member) : {start: member.range[0], end: member.range[1], text: '{}'};
	}

	/*
	Removes `node` from `container`.

	The removal also takes a blank line that would be left next to another one or directly inside a bracket. When the only item of a braced container goes and no comment is left inside, its brackets close up, as `[]`.
	*/
	#removeNode(container: Container, node: MemberNode | ValueNode): Replacement {
		const items: ReadonlyArray<MemberNode | ValueNode> = container.type === 'Array' ? container.elements : container.members;
		// When the removed item is the last one and has no comma after it, it takes the comma before it, so that no trailing comma is left, as `[1, 2]` becomes `[1]`.
		const shouldTakeCommaBefore = node === items.at(-1) && this.#text.charCodeAt(this.#skipTrivia(node.range[1])) !== COMMA;
		const removal = this.#nodeRemoval(node, shouldTakeCommaBefore);

		if (removal.isWholeLines) {
			this.#takeBlankLine(removal, container);
		}

		if (items.length === 1 && isBraced(container) && !this.#isCommentLeft(container, removal)) {
			const [start, end] = container.range;
			return {start: start + 1, end: end - 1, text: ''};
		}

		return {start: removal.start, end: removal.end, text: ''};
	}

	/*
	Whether a comment inside `container` is outside `removal`.
	*/
	#isCommentLeft(container: Container, removal: Removal): boolean {
		const [start, end] = container.range;
		const first = this.#comments[lowerBound(this.#comments, start + 1)];
		if (first === undefined || first.range[0] >= end) {
			return false;
		}

		const after = this.#comments[lowerBound(this.#comments, removal.end)];
		return first.range[0] < removal.start || (after !== undefined && after.range[0] < end);
	}

	/*
	What removing a member or an item, with the comments it owns and its comma, takes out of the text. With `shouldTakeCommaBefore`, a comma directly before it goes too.
	*/
	#nodeRemoval(node: MemberNode | ValueNode, shouldTakeCommaBefore: boolean): Removal {
		const text = this.#text;
		const start = this.#ownedStart(node.range[0]);
		const end = this.#ownedEnd(node.range[1]);
		const next = skipSpaces(text, end);
		// Only a braced container can have commas.
		const hasComma = text.charCodeAt(next) === COMMA;

		// The comma before it is only taken when spaces alone are between them and the comments it owns. The scan back only crosses spaces, so it stays short on a long line.
		const before = skipSpacesBack(text, start);
		const removalStart = shouldTakeCommaBefore && text.charCodeAt(before - 1) === COMMA ? before - 1 : start;
		// The comments after its comma go with it when they end its line, as the formatter keeps them after it.
		const removalEnd = hasComma ? this.#findLineEndAfterTrivia(next + 1) ?? (next + 1) : end;
		const removal = this.#removal(removalStart, removalEnd);

		// When it takes the comma before it, the spaces before a comment after it stay, so that the comment does not join the item before the comma.
		if (removalStart !== start && !removal.isWholeLines && this.#commentEnds.has(removal.end)) {
			removal.end = skipSpacesBack(text, removal.end);
		}

		return removal;
	}

	/*
	The start of the block comments that a member or an item at `offset` owns before it: those on its line after the comma or the opening bracket before it, as `/* note *\/` in `[1, /* note *\/ 2]`. The formatter keeps them in front of it. It is `offset` when there are none.
	*/
	#ownedStart(offset: number): number {
		let index = lowerBound(this.#comments, offset) - 1;
		for (; index >= 0; index--) {
			const end = skipSpacesBack(this.#text, offset);
			// The start of each block comment, by its end, is found in the existing source-ordered comments, so that the comments before a member or an item can be found.
			const comment = this.#comments[index];

			if (comment?.type !== 'Block' || comment.range[1] !== end) {
				return offset;
			}

			offset = comment.range[0];
		}

		return offset;
	}

	/*
	The end of the comments that a member or an item ending at `offset` owns after it: those on its line before its comma or the closing bracket, as `/* note *\/` in `[1 /* note *\/, 2]` and `[1, 2 /* note *\/]`, and a line comment at the end of its line. The formatter keeps them after it. It is `offset` when there are none.
	*/
	#ownedEnd(offset: number): number {
		for (;;) {
			const commentEnd = this.#commentEnds.get(skipSpaces(this.#text, offset));

			if (commentEnd === undefined) {
				return offset;
			}

			offset = commentEnd;
		}
	}

	/*
	The removal of the text from `start` to `end`. When nothing else is on its lines, it takes the lines, including a comment at the end of the last one.
	*/
	#removal(start: number, end: number): Removal {
		const text = this.#text;
		const lineEnd = this.#findLineEndAfterTrivia(end);

		// The line start is only looked for when nothing follows on the line, because the scan back to it is long for an item in the middle of a long line, and doing it for every item would be quadratic.
		if (lineEnd !== undefined) {
			const lineStart = findLineStart(this.#text, start);

			if (skipSpaces(this.#text, lineStart) === start) {
				return {start: lineStart, end: Math.min(lineEnd + 1, text.length), isWholeLines: true};
			}
		}

		// The spaces after the text go too, and the spaces before it when nothing follows it on the line or in its container.
		const after = skipSpaces(this.#text, end);
		const code = text.charCodeAt(after);
		const isLast = after === text.length || code === LF || code === CLOSE_BRACE || code === CLOSE_BRACKET;
		return {start: isLast ? skipSpacesBack(this.#text, start) : start, end: after, isWholeLines: false};
	}

	/*
	Widens a removal of whole lines by a blank line that would otherwise be left next to another blank line, or directly inside a bracket. The container's content starts at `#contentStart()`.
	*/
	#takeBlankLine(removal: Removal, container: Container): void {
		const text = this.#text;
		const previousLineStart = removal.start > 0 ? findLineStart(text, removal.start - 1) : undefined;
		const isBlankBefore = previousLineStart !== undefined && this.#isBlankLine(previousLineStart);
		const isBlankAfter = removal.end < text.length && this.#isBlankLine(removal.end);

		// The blank line before goes when the one after is blank too, as the spec prefers the one before, or when the closing bracket or the end of the text comes next.
		if (isBlankBefore && (isBlankAfter || this.#isAtClosing(removal.end, container))) {
			removal.start = previousLineStart!;
		} else if (isBlankAfter && removal.start === this.#contentStart(container)) {
			removal.end = text.indexOf('\n', removal.end) + 1;
		}
	}

	/*
	The offset after the blank lines that start at `offset`.
	*/
	#skipBlankLines(offset: number): number {
		while (offset < this.#text.length) {
			const end = skipSpaces(this.#text, offset);
			if (this.#text.charCodeAt(end) !== LF) {
				break;
			}

			offset = end + 1;
		}

		return offset;
	}

	/*
	Whether only blank lines come between the line at `offset` and the line that closes `container`, or the end of the text.
	*/
	#isAtClosing(offset: number, container: Container): boolean {
		offset = this.#skipBlankLines(offset);
		return offset === this.#text.length || (isBraced(container) && skipSpaces(this.#text, offset) === container.range[1] - 1);
	}

	/*
	The start of the first line that is not blank after the line that opens `container`, or after the start of the text. The line that opens a container ends after the comments that follow its bracket, and when an item follows on it, this is `undefined`.
	*/
	#contentStart(container: Container): number | undefined {
		if (!isBraced(container)) {
			return this.#skipBlankLines(0);
		}

		const lineEnd = this.#findLineEndAfterTrivia(container.range[0] + 1);
		return lineEnd === undefined ? undefined : this.#skipBlankLines(lineEnd + 1);
	}

	#isBlankLine(lineStart: number): boolean {
		return this.#text.charCodeAt(skipSpaces(this.#text, lineStart)) === LF;
	}

	/*
	Adds an item after `previous`, or into the empty `container` when there is none. `makeItem` gets the indentation of the item's line.

	An item on its own line needs no comma, so only an item added on the line of the item before it gets one, as in a one-line container.
	*/
	#insert(container: Container, previous: MemberNode | ValueNode | undefined, makeItem: (indentation: string) => string): Replacement {
		if (previous === undefined) {
			const closing = container.range[1] - 1;

			// A container that stays on one line keeps the item on that line, so `[/* note */]` becomes `[/* note */ 1]`, and `[1, []]` becomes `[1, [2]]`.
			if (this.#isOneLine(container)) {
				const start = skipSpacesBack(this.#text, closing);
				// One space after a comment before the item, and none directly inside the brackets.
				return {start, end: closing, text: `${start > container.range[0] + 1 ? ' ' : ''}${makeItem(this.#indentation(closing))}`};
			}

			const outer = this.#indentation(container.range[0]);
			const inner = `${outer}\t`;
			const lineStart = findLineStart(this.#text, closing);

			// A closing bracket on its own line keeps that line, and the item goes on a line before it.
			return lineStart > container.range[0] && skipSpaces(this.#text, lineStart) === closing ? {start: lineStart, end: lineStart, text: `${inner}${makeItem(inner)}\n`} : {start: skipSpacesBack(this.#text, closing), end: closing, text: `\n${inner}${makeItem(inner)}\n${outer}`};
		}

		const text = this.#text;
		// The new item goes after the comments that the one before it owns, so that they stay with that one.
		const previousEnd = this.#ownedEnd(previous.range[1]);
		const next = this.#skipTrivia(previousEnd);
		const hasComma = text.charCodeAt(next) === COMMA;
		const afterComma = hasComma ? next + 1 : previousEnd;
		const lineEnd = this.#findLineEndAfterTrivia(afterComma);

		// Something follows on the same line, such as the closing bracket of a one-line object, so the item goes on that line too, and takes its indentation.
		if (lineEnd === undefined) {
			const item = makeItem(this.#indentation(afterComma));
			// After a comma, the new item gets a comma too, so `[1, 2,]` becomes `[1, 2, 3,]`.
			return hasComma ? {start: afterComma, end: afterComma, text: ` ${item},`} : {start: previousEnd, end: previousEnd, text: `, ${item}`};
		}

		const indentation = this.#indentation(previous.range[0]);
		return {start: lineEnd, end: lineEnd, text: `\n${indentation}${makeItem(indentation)}`};
	}

	/*
	Whether `container` stays on one line: its brackets are on one line and something is between them, which `format()` keeps, or it is inside a container that stays on one line. An empty `[]` or `{}` on its own gets its new item on a line of its own.
	*/
	#isOneLine(container: Container): boolean {
		if (this.#isInsideOneLine) {
			return true;
		}

		const [start, end] = container.range;
		return isBraced(container) && skipSpaces(this.#text, start + 1) < end - 1 && isSameLine(this.#text, start, end);
	}

	/*
	A new value inside `container`. In a container on one line, the value is on one line too.
	*/
	#valueText(value: unknown, depth: number, indentation: string, container: Container): string {
		return stringifyValueAt(value, {
			...this.#stringifyOptions,
			depth,
			indent: indentation,
			isOneLine: this.#isOneLine(container),
		});
	}

	/*
	The spaces and tabs at the start of the line that holds `offset`.
	*/
	#indentation(offset: number, lineStart = findLineStart(this.#text, offset)): string {
		// A line that a block comment from an earlier line runs into, as in `/* a\n b */ x: 1`, is indented as the line where that comment starts.
		for (let comment = this.#commentAcross(lineStart); comment !== undefined; comment = this.#commentAcross(lineStart)) {
			lineStart = findLineStart(this.#text, comment.range[0]);
		}

		return this.#text.slice(lineStart, skipSpaces(this.#text, lineStart));
	}

	/*
	The comment that starts before `offset` and ends after it, if any. The comments are in source order, so a binary search finds the last one that starts before `offset`.
	*/
	#commentAcross(offset: number): Comment | undefined {
		const comment = this.#comments[lowerBound(this.#comments, offset) - 1];
		return comment !== undefined && comment.range[1] > offset ? comment : undefined;
	}

	/*
	Skips whitespace, line breaks, and comments.
	*/
	#skipTrivia(offset: number): number {
		offset = this.#skipLineTrivia(offset);

		while (this.#text.charCodeAt(offset) === LF) {
			offset = this.#skipLineTrivia(offset + 1);
		}

		return offset;
	}

	/*
	Skips spaces, tabs, and comments, but not a line break outside a comment.
	*/
	#skipLineTrivia(offset: number): number {
		for (;;) {
			offset = skipSpaces(this.#text, offset);
			const commentEnd = this.#commentEnds.get(offset);

			if (commentEnd === undefined) {
				return offset;
			}

			offset = commentEnd;
		}
	}

	/*
	The offset of the line break that ends the line at `offset`, or the end of the text, when only whitespace and comments come before it. Otherwise `undefined`.
	*/
	#findLineEndAfterTrivia(offset: number): number | undefined {
		offset = this.#skipLineTrivia(offset);
		return offset === this.#text.length || this.#text.charCodeAt(offset) === LF ? offset : undefined;
	}

	/*
	The replacement that makes the edit, from the document's collection, which is level 1.
	*/
	replacement(body: Container): Replacement | undefined {
		return this.#descend(body, 0, 1);
	}
}

/*
Whether `value` is a member or a value node, for a caller that passes one from JavaScript. The parameter type already says so for TypeScript.
*/
function isMemberOrValueNode(value: unknown): value is MemberNode | ValueNode {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const {type} = value as {type?: unknown};
	return type === 'Member' || (typeof type === 'string' && VALUE_NODE_TYPES.has(type));
}

/*
The path of a node of `tree`, which comes from `parseTree(text)`. Two parses of the same text make nodes that are equal but not the same object, so the node is found by its type and the span of its range, which no other node of its type shares in a valid tree. The path of a member and of its value is the member's key, so editing either replaces the member's value or removes the member, as with the path directly. The document's own collection has no path, so a node that is it is rejected.
*/
function getPathOf(tree: DocumentNode, target: MemberNode | ValueNode): PathSegment[] {
	if (!isMemberOrValueNode(target)) {
		throw new TypeError(`Expected a member or a value node, got ${describeNodeType(target)}`);
	}

	const isTarget = (node: {readonly type: string; readonly range: readonly [number, number]}): boolean => node.type === target.type && areRangesEqual(node.range, target.range);

	if (isTarget(tree.body)) {
		throw new TypeError('The document\'s own collection cannot be edited; pass a member or a value of it');
	}

	const path: PathSegment[] = [];
	let container: Container = tree.body;

	for (;;) {
		const items = container.type === 'Array' ? container.elements : container.members;
		const index = lowerBound(items, target.range[0] + 1) - 1;
		const item = items[index];

		if (!item || item.range[1] < target.range[1]) {
			break;
		}

		const value = item.type === 'Member' ? item.value : item;
		path.push(item.type === 'Member' ? item.key.value : index);

		if (isTarget(item) || isTarget(value)) {
			return path;
		}

		if (value.type !== 'Object' && value.type !== 'Array') {
			break;
		}

		container = value;
	}

	throw new TypeError('The node is not a member or a value of the document. Pass a node from `parseTree(text)` for the same `text`');
}

function isBraced(container: Container): boolean {
	return container.type === 'Array' || container.braced;
}

/*
`value` inside new objects for the keys of `path` from `index` on. An index there names an item of an array that does not exist yet, so it throws a `RangeError`.
*/
function nest(path: readonly PathSegment[], index: number, value: unknown): unknown {
	// A scalar's full path counts its containing collections, including the document; reject excess depth before allocating missing parents.
	if (path.length > MAX_DEPTH) {
		throw new RangeError(`Cannot serialize a value nested more than ${MAX_DEPTH} levels deep`);
	}

	let nested = value;

	for (let position = path.length - 1; position >= index; position--) {
		const segment = path[position]!;

		if (typeof segment === 'number') {
			throw new RangeError(`Cannot edit ${describePath(path)}, because ${describeParent(path, position)} does not exist, so it has no index ${segment}`);
		}

		// A computed property defines the member, so a key named `__proto__` is an ordinary member.
		nested = {[segment]: nested};
	}

	return nested;
}

function describePath(path: readonly PathSegment[]): string {
	const maximumLength = 200;
	let description = '';
	for (const [index, segment] of path.entries()) {
		description += typeof segment === 'number' ? `[${segment}]` : `${index === 0 ? '' : '.'}${describeKey(segment)}`;

		if (description.length > maximumLength) {
			break;
		}
	}

	// Only the prefix needed for abbreviation is built. The path comes from the caller, perhaps from user input, so it is cut short, and invisible characters and those that a terminal acts on, which `JSON.stringify()` leaves as they are, become escapes.
	return describeText(abbreviate(description, maximumLength));
}

/*
The value that holds `path[index]`.
*/
function describeParent(path: readonly PathSegment[], index: number): string {
	return index === 0 ? 'the document' : describePath(path.slice(0, index));
}
