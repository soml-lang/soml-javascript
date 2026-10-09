import {
	Parser,
	defineMember,
	parseWithTimes,
	type ParsedValue,
	type ParsedObject,
	type Time,
	type Value,
	type Document,
	type ObjectValue,
} from './parse.ts';
import {
	findBareKeyEnd,
	findQuoteRunEnd,
	skipWhitespace,
	findNumberEnd,
	findLineEnd,
	findStringEnd,
	isQuote,
	lowerBound,
	findBlockStringEnd,
	requireString,
	abbreviate,
	describeText,
	type DurationUnit,
	HASH,
	SINGLE_QUOTE,
	ASTERISK,
	COMMA,
	SLASH,
	OPEN_BRACKET,
	CLOSE_BRACKET,
	OPEN_BRACE,
	CLOSE_BRACE,
	type TextRange,
	isOffsetInRange,
} from './shared.ts';

/**
A position in the source: a 1-based line, and a 0-based column in UTF-16 code units, as in ESTree.
*/
export type Position = {
	/**
	The 1-based line.
	*/
	readonly line: number;

	/**
	The 0-based column, in UTF-16 code units.
	*/
	readonly column: number;
};

/**
Where a node, token, or comment is in the source.
*/
export type SourceLocation = {
	/**
	The position of the first character.
	*/
	readonly start: Position;

	/**
	The position after the last character.
	*/
	readonly end: Position;
};

type Located<Type extends string> = {
	readonly type: Type;

	/**
	The start and end, as UTF-16 offsets into the text.
	*/
	readonly range: TextRange;

	/**
	The start and end, as lines and columns.
	*/
	readonly loc: SourceLocation;
};

/**
A token. `value` is its source text.

A `Punctuator` is one of `{`, `}`, `[`, `]`, `:`, and `,`. A `Keyword` is `true`, `false`, or `null`. `infinity` and `-infinity` are `Float` tokens, and a quoted key is a `String` token.
*/
export type Token = Located<'Punctuator' | 'BareKey' | 'String' | 'Integer' | 'Float' | 'Keyword' | 'Instant' | 'Duration'> & {
	readonly value: string;
};

/**
A comment. `value` is its text without its delimiters.
*/
export type Comment = Located<'Line' | 'Block'> & {
	readonly value: string;
};

/**
The root of a tree.
*/
export type DocumentNode = Located<'Document'> & {
	/**
	The document's collection, an object or an array.
	*/
	readonly body: ObjectNode | ArrayNode;

	/**
	Every token, in source order, without comments.
	*/
	readonly tokens: readonly Token[];

	/**
	Every comment, in source order.
	*/
	readonly comments: readonly Comment[];
};

/**
An object, written with braces or as a top-level object without them.
*/
export type ObjectNode = Located<'Object'> & {
	/**
	The members, in source order.
	*/
	readonly members: readonly MemberNode[];

	/**
	`false` only for a top-level object written without braces.
	*/
	readonly braced: boolean;
};

/**
A `key: value` member of an object.
*/
export type MemberNode = Located<'Member'> & {
	/**
	The key.
	*/
	readonly key: KeyNode;

	/**
	The value after the `:`.
	*/
	readonly value: ValueNode;
};

/**
An array, with its items in `elements`.
*/
export type ArrayNode = Located<'Array'> & {
	/**
	The items, in source order.
	*/
	readonly elements: readonly ValueNode[];
};

/**
A key.
*/
export type KeyNode = Located<'Key'> & {
	/**
	The decoded key.
	*/
	readonly value: string;

	/**
	How the key is written: bare, as `'...'`, or as `"..."`.
	*/
	readonly style: 'bare' | 'literal' | 'escaped';
};

/**
A string, written as `'...'`, `"..."`, or a block string.
*/
export type StringNode = Located<'String'> & {
	/**
	The decoded string.
	*/
	readonly value: string;

	/**
	Whether the string is written with `'` (literal) or `"` (escaped).
	*/
	readonly style: 'literal' | 'escaped';

	/**
	Whether it is a block string.
	*/
	readonly block: boolean;
};

/**
An int, in any radix.
*/
export type IntegerNode = Located<'Integer'> & {
	/**
	The value, which is always a `bigint`.
	*/
	readonly value: bigint;

	/**
	The radix it is written in: `2` for `0b`, `8` for `0o`, `16` for `0x`, and otherwise `10`.
	*/
	readonly radix: 2 | 8 | 10 | 16;
};

/**
A float, including `infinity` and `-infinity`.
*/
export type FloatNode = Located<'Float'> & {
	/**
	The value, including `Infinity` and `-Infinity`.
	*/
	readonly value: number;
};

/**
`true` or `false`.
*/
export type BooleanNode = Located<'Boolean'> & {
	/**
	The value.
	*/
	readonly value: boolean;
};

/**
The `null` keyword, which has no fields of its own.
*/
export type NullNode = Located<'Null'>;

/**
An instant, such as `2026-09-19T14:00:00Z`.
*/
export type InstantNode = Located<'Instant'> & {
	/**
	The exact nanoseconds since the Unix epoch, available without Temporal.

	@example
	```
	getNodeAtPath(parseTree('time: 1970-01-01T00:00:00.000000001Z'), ['time']).epochNanoseconds;
	//=> 1n
	```
	*/
	readonly epochNanoseconds: bigint;

	/**
	Made when it is first read, so that only reading it needs `Temporal`. Spreading or serializing the node reads it too.
	*/
	readonly value: Temporal.Instant;
};

/**
One part of a duration, such as `30m` in `1h30m`.
*/
export type DurationPart = {
	/**
	The number as it is written, with any `_` and fraction, such as `1_000` or `1.5`.
	*/
	readonly number: string;

	/**
	The unit.
	*/
	readonly unit: DurationUnit;
};

/**
A duration, such as `1h30m`.
*/
export type DurationNode = Located<'Duration'> & {
	/**
	The exact signed length in nanoseconds, available without Temporal.

	@example
	```
	getNodeAtPath(parseTree('timeout: 1.5s'), ['timeout']).nanoseconds;
	//=> 1500000000n
	```
	*/
	readonly nanoseconds: bigint;

	/**
	Made when it is first read, so that only reading it needs `Temporal`. Spreading or serializing the node reads it too.
	*/
	readonly value: Temporal.Duration;

	/**
	Whether it is written with a `-`, which negates the whole duration.
	*/
	readonly negative: boolean;

	/**
	The parts as they are written, in order. So `-1h30m` is `negative` with the parts `1` `h` and `30` `m`.
	*/
	readonly parts: readonly DurationPart[];
};

/**
A node that is a value.
*/
export type ValueNode = ObjectNode | ArrayNode | StringNode | IntegerNode | FloatNode | BooleanNode | NullNode | InstantNode | DurationNode;

/**
Any node in a tree.
*/
export type Node = DocumentNode | MemberNode | KeyNode | ValueNode;

/**
A key in an object or an index in an array.
*/
export type PathSegment = string | number;

/*
Whether `segment` is a key or an array index. Exported for `edit()`, which takes the same paths.
*/
export function isPathSegment(segment: unknown): segment is PathSegment {
	return typeof segment === 'string' || (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0);
}

/**
Whether a value is an array of keys and array indexes, including checking sparse slots. A type guard rather than `Array.isArray()`, which does not remove a `readonly` array from the union, because a `readonly` array is not assignable to the mutable `any[]` it tests for.

@internal
*/
export function isPath(value: unknown): value is readonly PathSegment[] {
	return readPath(value) !== undefined;
}

/**
Validate and snapshot path segments once, ignoring inherited slots and getter-added segments.

@internal
*/
export function readPath(value: unknown): PathSegment[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const {length} = value;
	const path: PathSegment[] = [];
	// Note: Not using `Array.from()` because it would honor a caller-supplied iterator instead of the indexed segments.
	// `Array#some()` skips a hole, so every slot is visited instead. An inherited index cannot fill a hole.
	for (let index = 0; index < length; index++) {
		if (!Object.hasOwn(value, index)) {
			return undefined;
		}

		const segment: unknown = value[index];
		if (!isPathSegment(segment)) {
			return undefined;
		}

		path.push(segment);
	}

	return path;
}

const emptyVisitorKeys: readonly never[] = Object.freeze([]);
type VisitorKeys = {readonly [Type in Node['type']]: ReadonlyArray<keyof Extract<Node, {type: Type}>>};

/**
The properties of each node type that hold its child nodes, in source order, for tools that walk the tree, such as an ESLint language plugin.

@example
```
import {visitorKeys} from 'soml-lang';

visitorKeys.Member;
//=> ['key', 'value']

visitorKeys.Integer;
//=> []
```
*/
/* eslint-disable @typescript-eslint/naming-convention -- The keys are node types. */
export const visitorKeys: Readonly<Record<Node['type'], readonly string[]>> = Object.freeze({
	Document: Object.freeze(['body']),
	Object: Object.freeze(['members']),
	Member: Object.freeze(['key', 'value']),
	Array: Object.freeze(['elements']),
	Key: emptyVisitorKeys,
	String: emptyVisitorKeys,
	Integer: emptyVisitorKeys,
	Float: emptyVisitorKeys,
	Boolean: emptyVisitorKeys,
	Null: emptyVisitorKeys,
	Instant: emptyVisitorKeys,
	Duration: emptyVisitorKeys,
} satisfies VisitorKeys);
/* eslint-enable @typescript-eslint/naming-convention */

// A map rather than an object, so that a property added to `Object.prototype` is never read as an entry.
const RADIX: ReadonlyMap<number, 2 | 8 | 16> = new Map([[0x78, 16], [0x6F, 8], [0x62, 2]]);

/**
Parse a document into a syntax tree, for tools such as linters and formatters. Returns a `Document` node, which also holds every token and comment.

Every node, token, and comment has a `range`, which is `[start, end]` as UTF-16 offsets into `text`, and a `loc`, which is `{start: {line, column}, end: {line, column}}`, with a 1-based line and a 0-based column in UTF-16 code units, as in ESTree. A `ParseError` counts its column differently, for people to read, so use its `offset` to find the position in the tree. A scalar node or a key shares its `range` and `loc` with its token, and other nodes, except `Document`, share the positions in `loc` with their first and last token, so treat them as read-only.

@param text - The document.
@returns The root node, which also holds every token and comment.
@throws {ParseError} When the document is not valid, the same as `parse()`.
@throws {TypeError} When `text` is not a string.

@example
```
import {parseTree} from 'soml-lang';

const tree = parseTree('port: 8080 # The default');

tree.body.members[0].value;
//=> {type: 'Integer', value: 8080n, radix: 10, range: [6, 10], loc: {…}}

tree.comments[0];
//=> {type: 'Line', value: ' The default', range: [11, 24], loc: {…}}
```
*/
export function parseTree(text: string): DocumentNode {
	requireString(text);

	// Validates the whole document, so the builder below can assume valid input and reuse the decoded values.
	const value = parseWithTimes(text);
	return new TreeBuilder(text).build(value);
}

/*
The value of one scalar, used to decode escaped keys with the parser itself so that the tree and `parse()` cannot disagree. The document is already validated by `parseTree()`, so the scalar is parsed directly rather than inside `[...]`, avoiding another character check and a temporary string and array. Value nodes reuse the values from the document's validation pass.
*/
function readScalar(raw: string): ParsedValue {
	return new Parser(raw, 'bigint').parseScalar();
}

/**
A node in a tree as its value, which is what `parse()` reads for the same text. For a document, the whole document, so `evaluate(parseTree(text))` is the same as `parse(text)`. An object or an array is built from its members and elements, with a key named `__proto__` as an ordinary member, as in `parse()`. An instant or a duration is a `Temporal` object, made when the value is read, as for the node.

@param node - A document or value node from `parseTree()`, or from a subtree of it.
@returns The value of the node.
@throws {TypeError} When `node` is not a document or a value node.

@example
```
import {evaluate, parseTree} from 'soml-lang';

const tree = parseTree('name: \'api\'\nlimits: {cpu: 1.5, memory: 512}');

evaluate(tree);
//=> {name: 'api', limits: {cpu: 1.5, memory: 512n}}

evaluate(tree.body.members[1].value);
//=> {cpu: 1.5, memory: 512n}
```
*/
export function evaluate(node: DocumentNode | ValueNode): Document | Value {
	if (!isDocumentOrValueNode(node)) {
		throw new TypeError(`Expected a document or a value node, got ${describeNodeType(node)}`);
	}

	return evaluateValue(node.type === 'Document' ? node.body : node);
}

/*
The types of the value nodes, which `evaluate()` accepts besides a `Document`. Exported for `edit()`, which checks a node passed as its path.
*/
export const VALUE_NODE_TYPES: ReadonlySet<string> = new Set(['Object', 'Array', 'String', 'Integer', 'Float', 'Boolean', 'Null', 'Instant', 'Duration'] satisfies Array<ValueNode['type']>);

/*
Whether `value` is a document or a value node, for a caller that passes one from JavaScript or from an untyped file. The parameter type already says so for TypeScript.
*/
function isDocumentOrValueNode(value: unknown): value is DocumentNode | ValueNode {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const {type} = value as {type?: unknown};
	return typeof type === 'string' && (type === 'Document' || VALUE_NODE_TYPES.has(type));
}

/*
A node, or anything that was meant as one, as an error message shows it, such as “a Key node” or “a string”. Exported for `edit()`, which accepts a node instead of a path.
*/
export function describeNodeType(value: unknown): string {
	if (value === null) {
		return 'null';
	}

	if (typeof value !== 'object') {
		return `a ${typeof value}`;
	}

	const {type} = value as {type?: unknown};
	return typeof type === 'string' ? `a ${describeText(abbreviate(type))} node` : 'an object';
}

function evaluateValue(node: ValueNode): Value {
	switch (node.type) {
		case 'Object': {
			const object: ObjectValue = {};

			for (const member of node.members) {
				defineMember(object, member.key.value, evaluateValue(member.value));
			}

			return object;
		}

		case 'Array': {
			// eslint-disable-next-line unicorn/no-array-callback-reference -- This private callback consumes only its first argument.
			return node.elements.map(evaluateValue);
		}

		case 'String':
		case 'Integer':
		case 'Float':
		case 'Boolean':
		case 'Instant':
		case 'Duration': {
			return node.value;
		}

		case 'Null': {
			return null;
		}
	}
}

/**
The deepest node, token, or comment whose span contains `offset`, such as for an editor that shows what is under the cursor. A span contains its start but not its end. A comment beats the node that holds it, and a token that no node covers, such as `{` or `:`, beats its container. An offset in the whitespace between members or items gives the object or the array, and one before the document's collection or past its end gives `undefined`.

@param tree - The tree, from `parseTree()`.
@param offset - The UTF-16 offset into the source.
@returns The innermost thing at the offset.
@throws {TypeError} When `offset` is not a non-negative integer.

@example
```
import {getNodeAt, parseTree} from 'soml-lang';

const tree = parseTree('ports: [80, 443] # Comments');

getNodeAt(tree, 12);
//=> The IntegerNode `443`

getNodeAt(tree, 22);
//=> The `# Comments` line comment
```
*/
export function getNodeAt(tree: DocumentNode, offset: number): Node | Token | Comment | undefined {
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw new TypeError(`Expected the offset to be a non-negative integer, got ${typeof offset === 'number' ? String(offset) : typeof offset}`);
	}

	if (offset >= tree.range[1]) {
		return undefined;
	}

	const comment = findAt(tree.comments, offset);

	if (comment !== undefined) {
		return comment;
	}

	const node = deepestNodeAt(tree.body, offset);
	if (node === undefined || (node.type !== 'Object' && node.type !== 'Array' && node.type !== 'Member')) {
		return node;
	}

	const token = findAt(tree.tokens, offset);

	// A token that is not itself a node, such as a punctuator or a key's `:`, is smaller than the node that holds it, so it wins. A scalar node shares its token's span, so the node wins. No token exists where no node does, so a missing node is a missing result.
	return token !== undefined && (token.range[0] > node.range[0] || token.range[1] < node.range[1]) ? token : node;
}

/**
The value node at `path`, such as for showing a schema error where the value is written. The path is the same as for `edit()`, and an empty path gives the document's collection. Returns `undefined` when there is no value there, also when the path has a key where an array is, an index where an object is, or leads through a scalar.

@param tree - The tree, from `parseTree()`.
@param path - The keys and array indexes that lead to the value, such as `['servers', 0, 'port']`.
@returns The value node at the path.
@throws {TypeError} When `path` is not an array of keys and array indexes.

@example
```
import {getNodeAtPath, parseTree} from 'soml-lang';

const tree = parseTree('servers: [{port: 8080}]');

getNodeAtPath(tree, ['servers', 0, 'port']);
//=> {type: 'Integer', value: 8080n, radix: 10, range: [17, 21], loc: {…}}

getNodeAtPath(tree, ['servers', 1]);
//=> undefined
```
*/
export function getNodeAtPath(tree: DocumentNode, path: readonly PathSegment[]): ValueNode | undefined {
	const segments = readPath(path);
	if (segments === undefined) {
		throw new TypeError('The path must be an array of keys and array indexes');
	}

	let node: ValueNode | undefined = tree.body;

	for (const segment of segments) {
		if (typeof segment === 'number' && node?.type === 'Array') {
			node = node.elements[segment];
		} else if (typeof segment === 'string' && node?.type === 'Object') {
			// The keys of an object are unique in a valid document, so the first match is the only one.
			node = node.members.find(member => member.key.value === segment)?.value;
		} else {
			return undefined;
		}
	}

	return node;
}

/*
The last item of `items` that starts at or before `offset`, when its span contains it. The items are in source order and do not overlap, so the one that starts last is the only candidate.
*/
function findAt<Item extends {readonly range: readonly [number, number]}>(items: readonly Item[], offset: number): Item | undefined {
	const item = items[lowerBound(items, offset + 1) - 1];
	return item !== undefined && offset < item.range[1] ? item : undefined;
}

/*
The child of `node` that contains `offset`, or `undefined` when none does. Only containers have children; a member's children are its key and its value.
*/
function childAt(node: Node, offset: number): Node | undefined {
	switch (node.type) {
		case 'Object': {
			return findAt(node.members, offset);
		}

		case 'Array': {
			return findAt(node.elements, offset);
		}

		case 'Member': {
			if (isOffsetInRange(node.value.range, offset)) {
				return node.value;
			}

			return isOffsetInRange(node.key.range, offset) ? node.key : undefined;
		}

		default: {
			return undefined;
		}
	}
}

/*
The deepest node of the subtree at `start` that contains `offset`, or `undefined` when the subtree does not reach it. The children of a container are in source order, so the one that contains the offset is the last one that starts at or before it.
*/
function deepestNodeAt(start: Node, offset: number): Node | undefined {
	if (!isOffsetInRange(start.range, offset)) {
		return undefined;
	}

	let node = start;
	for (;;) {
		const child = childAt(node, offset);
		if (child === undefined) {
			return node;
		}

		node = child;
	}
}

/*
Every node is an object literal with the same property order, `type`, its own fields, `range`, and `loc`, rather than one generic function that spreads the fields, which is several times slower. A node that is one token, such as a scalar or a key, shares the token's `range` and `loc`.
*/
class TreeBuilder {
	readonly #source: string;
	#index = 0;
	// The builder reads the source once from start to end, so tokens and comments are pushed in source order, which the binary search in `findAt()` relies on.
	readonly #tokens: Token[] = [];
	readonly #comments: Comment[] = [];
	// Positions are looked up in source order. Keep only the current line, caching its end so repeated lookups on a long line do not scan it again.
	#line = 1;
	#lineStart = 0;
	#lineEnd: number;

	constructor(source: string) {
		this.#source = source;
		this.#lineEnd = findLineEnd(source, 0);
	}

	// Past the end of the source, `NaN`, which matches no character, so `#skipTrivia()` stops at the end without checking the length.
	#code(offset = this.#index): number {
		return this.#source.charCodeAt(offset);
	}

	/*
	1-based line, and 0-based column in UTF-16 code units, as in ESTree.
	*/
	#position(offset: number): Position {
		// Source-order lookups scan each line once without storing every line start.
		while (this.#lineEnd < offset) {
			this.#line++;
			this.#lineStart = this.#lineEnd + 1;
			this.#lineEnd = findLineEnd(this.#source, this.#lineStart);
		}

		return {line: this.#line, column: offset - this.#lineStart};
	}

	#location(start: number, end: number): SourceLocation {
		return {start: this.#position(start), end: this.#position(end)};
	}

	#token(type: Token['type'], start: number, end: number): Token {
		const token: Token = {
			type,
			value: this.#source.slice(start, end),
			range: [start, end],
			loc: this.#location(start, end),
		};

		this.#tokens.push(token);
		return token;
	}

	#punctuator(): Token {
		this.#index++;
		return this.#token('Punctuator', this.#index - 1, this.#index);
	}

	#skipTrivia(): void {
		const source = this.#source;

		for (;;) {
			const start = skipWhitespace(source, this.#index);
			const code = source.charCodeAt(start);

			this.#index = start;

			if (code === HASH) {
				this.#index = findLineEnd(source, start);
				this.#comment('Line', start, this.#index, source.slice(start + 1, this.#index));
			} else if (code === SLASH && this.#code(start + 1) === ASTERISK) {
				// The `*/` begins after the `/*`, so the `*` of `/*/` does not close it, and the document is valid, so the `*/` exists.
				this.#index = source.indexOf('*/', start + 2) + 2;
				this.#comment('Block', start, this.#index, source.slice(start + 2, this.#index - 2));
			} else {
				return;
			}
		}
	}

	#comment(type: Comment['type'], start: number, end: number, value: string): void {
		this.#comments.push({
			type,
			value,
			range: [start, end],
			loc: this.#location(start, end),
		});
	}

	#bareObject(value: ParsedObject): ObjectNode {
		const members: MemberNode[] = [];

		// The document is valid, so after a member and the trivia after it, either the source ends or another member begins.
		do {
			members.push(this.#member(value));
			this.#skipTrivia();
		} while (this.#index < this.#source.length);

		const first = members[0]!;
		const last = members.at(-1)!;

		return {
			type: 'Object',
			members,
			braced: false,
			range: [first.range[0], last.range[1]],
			loc: spanLocation(first, last),
		};
	}

	#object(value: ParsedObject): ObjectNode {
		const {items: members, opening, closing} = this.#items(CLOSE_BRACE, () => this.#member(value));

		return {
			type: 'Object',
			members,
			braced: true,
			range: [opening.range[0], closing.range[1]],
			loc: spanLocation(opening, closing),
		};
	}

	#array(value: ParsedValue[]): ArrayNode {
		const {items: elements, opening, closing} = this.#items(CLOSE_BRACKET, index => this.#value(value[index]!));

		return {
			type: 'Array',
			elements,
			range: [opening.range[0], closing.range[1]],
			loc: spanLocation(opening, closing),
		};
	}

	/*
	The items between an opening bracket and its `closingCode` bracket, which is consumed too. Items are separated by a comma, a line break, or both, so a comma token may be absent. The parser has already checked the separators, including that a comma is on the line of the item before it.
	*/
	#items<Item>(closingCode: typeof CLOSE_BRACE | typeof CLOSE_BRACKET, parseItem: (index: number) => Item): {items: Item[]; opening: Token; closing: Token} {
		const items: Item[] = [];
		const opening = this.#punctuator();
		this.#skipTrivia();

		while (this.#code() !== closingCode) {
			items.push(parseItem(items.length));
			this.#skipTrivia();

			if (this.#code() !== COMMA) {
				continue;
			}

			this.#punctuator();
			this.#skipTrivia();
		}

		return {items, opening, closing: this.#punctuator()};
	}

	#member(object: ParsedObject): MemberNode {
		const key = this.#key();
		// Nothing may come between a key and its `:`, so no trivia is skipped before it.
		this.#punctuator(); // `:`
		this.#skipTrivia();
		const value = this.#value(object[key.value]!);

		return {
			type: 'Member',
			key,
			value,
			range: [key.range[0], value.range[1]],
			loc: spanLocation(key, value),
		};
	}

	#key(): KeyNode {
		const start = this.#index;
		const code = this.#code();

		if (isQuote(code)) {
			const {style, token: {value: raw, range, loc}} = this.#singleLineString();
			const value = style === 'literal' ? raw.slice(1, -1) : readScalar(raw) as string;

			return {
				type: 'Key',
				value,
				style,
				range,
				loc,
			};
		}

		this.#index = findBareKeyEnd(this.#source, start);

		const {value, range, loc} = this.#token('BareKey', start, this.#index);

		return {
			type: 'Key',
			value,
			style: 'bare',
			range,
			loc,
		};
	}

	#value(value: ParsedValue): ValueNode {
		const code = this.#code();

		if (code === OPEN_BRACE) {
			return this.#object(value as ParsedObject);
		}

		if (code === OPEN_BRACKET) {
			return this.#array(value as ParsedValue[]);
		}

		const start = this.#index;

		if (isQuote(code)) {
			// In a valid document, a quote never follows a value directly, so three quotes always open a block string rather than an empty string and another quote.
			if (this.#code(start + 1) === code && this.#code(start + 2) === code) {
				return this.#blockString(code, value as string);
			}

			const {style, token: {range, loc}} = this.#singleLineString();

			return {
				type: 'String',
				value: value as string,
				style,
				block: false,
				range,
				loc,
			};
		}

		// The document is valid, so any other value is one run of scalar characters, which is a keyword or a number, an instant, or a duration. `infinity` and `-infinity` are read as numbers, because they are floats.
		const end = findNumberEnd(this.#source, start);

		if (typeof value !== 'boolean' && value !== null) {
			return this.#numberOrTime(end, value);
		}

		this.#index = end;
		const {range, loc} = this.#token('Keyword', start, end);
		return value === null
			? {type: 'Null', range, loc}
			: {
				type: 'Boolean', value, range, loc,
			};
	}

	/*
	`'...'` ends at the next `'`. `"..."` ends at the next `"` that is not escaped, and `\` always starts a two-character escape or a `\u{…}`, which holds no quote.
	*/
	#singleLineString(): {style: 'literal' | 'escaped'; token: Token} {
		const start = this.#index;
		const quote = this.#code();
		this.#index = findStringEnd(this.#source, start);
		const token = this.#token('String', start, this.#index);

		return {style: quote === SINGLE_QUOTE ? 'literal' : 'escaped', token};
	}

	/*
	The block ends at the first line whose first non-whitespace content is a run of exactly as many quotes as the opening delimiter.
	*/
	#blockString(quote: number, value: string): StringNode {
		const source = this.#source;
		const start = this.#index;
		const delimiterLength = findQuoteRunEnd(source, start, quote) - start;

		// The opening delimiter is followed directly by a line break, so the content starts on the next line, and the document is valid, so a closing line exists.
		const closing = findBlockStringEnd(source, start + delimiterLength + 1, quote, delimiterLength)!;
		this.#index = closing.delimiterStart + delimiterLength;

		const {range, loc} = this.#token('String', start, this.#index);

		return {
			type: 'String',
			value,
			style: quote === SINGLE_QUOTE ? 'literal' : 'escaped',
			block: true,
			range,
			loc,
		};
	}

	#numberOrTime(end: number, value: ParsedValue): IntegerNode | FloatNode | InstantNode | DurationNode {
		const start = this.#index;
		this.#index = end;
		if (typeof value === 'bigint') {
			const {range, loc} = this.#token('Integer', start, end);

			return {
				type: 'Integer',
				value,
				// An alternate radix takes no sign, so its prefix letter is always the second character, where a decimal int never has a letter.
				radix: RADIX.get(this.#source.charCodeAt(start + 1)) ?? 10,
				range,
				loc,
			};
		}

		if (typeof value === 'number') {
			const {range, loc} = this.#token('Float', start, end);

			return {
				type: 'Float',
				value,
				range,
				loc,
			};
		}

		const time = value as Time;
		const {value: raw, range, loc} = this.#token(time.type, start, end);
		let temporal: Temporal.Instant | Temporal.Duration | undefined;

		if (time.type === 'Duration') {
			// A getter, so that the `Temporal` object is made when `value` is first read.
			return {
				type: 'Duration',
				nanoseconds: time.nanoseconds,
				get value() {
					temporal ??= time.toTemporal();
					return temporal as Temporal.Duration;
				},
				negative: raw.startsWith('-'),
				parts: readDurationParts(raw),
				range,
				loc,
			};
		}

		// A getter, so that the `Temporal` object is made when `value` is first read.
		return {
			type: 'Instant',
			epochNanoseconds: time.nanoseconds,
			get value() {
				temporal ??= time.toTemporal();
				return temporal as Temporal.Instant;
			},
			range,
			loc,
		};
	}

	build(value: ReturnType<typeof parseWithTimes>): DocumentNode {
		this.#skipTrivia();
		const code = this.#code();
		let body: ObjectNode | ArrayNode;

		if (code === OPEN_BRACE) {
			body = this.#object(value as ParsedObject);
		} else if (code === OPEN_BRACKET) {
			body = this.#array(value as ParsedValue[]);
		} else {
			body = this.#bareObject(value as ParsedObject);
		}

		this.#skipTrivia();

		return {
			type: 'Document',
			body,
			tokens: this.#tokens,
			comments: this.#comments,
			range: [0, this.#source.length],
			// The fixed document start keeps position lookups in source order.
			loc: {start: {line: 1, column: 0}, end: this.#position(this.#source.length)},
		};
	}
}

/*
The location from the start of `first` to the end of `last`, which shares their positions rather than looking them up again. This keeps `#position` lookups in source order instead of revisiting the start of a container.
*/
function spanLocation(first: {readonly loc: SourceLocation}, last: {readonly loc: SourceLocation}): SourceLocation {
	return {start: first.loc.start, end: last.loc.end};
}

/*
The parts of a duration that is already valid. A part is a number, which has no letters, and then a unit, which has only lowercase letters.
*/
function readDurationParts(raw: string): DurationPart[] {
	const parts: DurationPart[] = [];
	let index = raw.startsWith('-') ? 1 : 0;

	while (index < raw.length) {
		let unitStart = index;

		while (!isUnitCharacter(raw.charCodeAt(unitStart))) {
			unitStart++;
		}

		let unitEnd = unitStart;

		while (isUnitCharacter(raw.charCodeAt(unitEnd))) {
			unitEnd++;
		}

		parts.push({number: raw.slice(index, unitStart), unit: raw.slice(unitStart, unitEnd) as DurationPart['unit']});
		index = unitEnd;
	}

	return parts;
}

/**
Whether a code unit is a lowercase duration-unit letter, from `a` to `z`.
*/
function isUnitCharacter(code: number): boolean {
	// From `a` to `z`.
	return code >= 0x61 && code <= 0x7A;
}
