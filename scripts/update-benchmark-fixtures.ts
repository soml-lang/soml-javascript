/*
Writes the JSON and TOML files of the benchmark fixtures from their SOML files, so that every format holds the same data. The fixtures are in the `soml` repository, which must be checked out next to this one. Copy them here again afterwards with `rsync --archive --delete ../soml/benchmark/ bench/fixtures/`.

	node scripts/update-benchmark-fixtures.ts

Each file is written as a person writes that format, with the layout of the SOML file: a container on one line in SOML is on one line in the other formats, and one that spans lines spans lines. So a parser of each format reads the same data in about the same amount of text, and the comparison is fair.

- JSON has no comments, so it has none. TOML has the comments of the SOML file, as `#` lines.
- JSON and TOML have no duration, so a duration is its ISO 8601 string, such as `"PT55S"`. JSON has no instant, so an instant is its ISO 8601 string, such as `"2026-09-19T14:00:00Z"`, and TOML has it as an offset date-time.
- TOML has no null, so a member whose value is null is left out of the TOML.
- An int is written as in the SOML file in TOML, which has the same `0x`, `0o`, `0b`, and `_` forms, and as a decimal in JSON. A float keeps its fraction in both, as in `180.0`, so a parser that keeps the difference gets the same types as from SOML.
- An object in an array that is not an array of tables is an inline table in TOML, which must be on one line.

Every file is read back with `JSON.parse()` and smol-toml and compared with the SOML value, with ints exact and instants to the nanosecond, so a mistake here fails rather than skews a benchmark.
*/
import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import * as smolToml from 'smol-toml';
import {
	parseTree,
	evaluate,
	formatFloat,
	type Comment,
	type DocumentNode,
	type ObjectNode,
	type ArrayNode,
	type MemberNode,
	type KeyNode,
	type StringNode,
	type ValueNode,
} from '../source/index.ts';
import {
	describeText,
	lowerBound,
	isBareKey,
	findLineEnd,
	hasBlankLine,
} from '../source/shared.ts';

const root = path.join(import.meta.dirname, '..', '..', 'soml', 'benchmark');

type Element = MemberNode | ValueNode;

class Writer {
	readonly #text: string;
	readonly #body: ObjectNode | ArrayNode;
	readonly #comments: readonly Comment[];
	// The comments written to the TOML, to report those that TOML has no place for.
	writtenComments = 0;

	constructor(document: DocumentNode, text: string) {
		this.#text = text;
		this.#body = document.body;
		this.#comments = document.comments;
	}

	// Inside an inline table, everything is on one line, because TOML requires an inline table to be.
	#tomlValue(node: ValueNode, indent: string, isInline: boolean): string {
		switch (node.type) {
			case 'Object': {
				// An inline table must be on one line, and it cannot hold a comment.
				const entries = node.members.values().filter(member => member.value.type !== 'Null').map(member => `${tomlKey(member.key)} = ${this.#tomlValue(member.value, indent, true)}`).toArray();
				return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
			}

			case 'Array': {
				if (isInline || !this.#spansLines(node)) {
					return `[${node.elements.map(element => this.#tomlValue(element, indent, isInline)).join(', ')}]`;
				}

				const {leading, trailing, closing} = this.#attachComments(node, node.elements);
				// An empty array that spans lines holds comments, such as an example item, and keeps them.
				if (node.elements.length === 0 && closing.length === 0) {
					return '[]';
				}

				const inner = `${indent}\t`;
				const lines: string[] = [];
				for (const element of node.elements) {
					appendLines(lines, this.#tomlComments(leading.get(element), inner));
					lines.push(`${inner}${this.#tomlValue(element, inner, false)},${this.#tomlTrailing(trailing.get(element))}`);
				}

				appendLines(lines, this.#tomlComments(closing, inner));
				return `[\n${lines.join('\n')}\n${indent}]`;
			}

			case 'String': {
				return tomlString(node);
			}

			case 'Integer':
			case 'Boolean':
			case 'Instant': {
				return this.#source(node);
			}

			case 'Float': {
				if (node.value === 0) {
					return this.#source(node).replace(/^-/v, '');
				}

				return node.value === Infinity ? 'inf' : (node.value === -Infinity ? '-inf' : this.#source(node));
			}

			case 'Duration': {
				return tomlBasic(node.value.toString());
			}

			case 'Null': {
				throw new TypeError('TOML cannot hold a null here');
			}
		}
	}

	// An object that spans lines is a table, also one that holds only comments, such as the keys that a config file shows as examples.
	#isTable(node: ValueNode): node is ObjectNode {
		return node.type === 'Object' && this.#spansLines(node);
	}

	#isArrayOfTables(node: ValueNode): node is ArrayNode {
		return node.type === 'Array' && node.elements.length > 0 && node.elements.every(element => this.#isTable(element));
	}

	/*
	Gives each element of a container the comments before it, back to the element before it, and the comment after it on its own line. The comments after the last element are `closing`. A comment before a member's value leads that member. A comment inside a value belongs to that value, and the value finds it when it is written.
	*/
	#attachComments(container: ObjectNode | ArrayNode, elements: readonly Element[]): {leading: Map<Element, Comment[]>; trailing: Map<Element, Comment>; closing: Comment[]} {
		const leading = new Map<Element, Comment[]>();
		const trailing = new Map<Element, Comment>();
		const closing: Comment[] = [];
		// A top-level object without braces starts at its first member and ends at its last, so the comments of the file before and after it are its own.
		const [start, end] = container === this.#body ? [0, this.#text.length] : container.range;
		// Comments and elements are in source order, so search this container's comments and advance through its elements once.
		const firstComment = lowerBound(this.#comments, start);

		let index = 0;
		for (let commentIndex = firstComment; commentIndex < this.#comments.length && this.#comments[commentIndex]!.range[1] <= end; commentIndex++) {
			const comment = this.#comments[commentIndex]!;
			while (index < elements.length && elements[index]!.range[1] <= comment.range[0]) {
				index++;
			}

			const current = elements[index];
			if (current && isWithin(comment, current.type === 'Member' ? current.value : current)) {
				continue;
			}

			const previous = elements[index - 1];
			if (previous && (!current || comment.range[0] < current.range[0]) && previous.loc.end.line === comment.loc.start.line && !trailing.has(previous)) {
				trailing.set(previous, comment);
			} else if (current) {
				leading.getOrInsertComputed(current, createCommentList).push(comment);
			} else {
				closing.push(comment);
			}
		}

		return {leading, trailing, closing};
	}

	#tomlComments(comments: readonly Comment[] | undefined, indent: string): string[] {
		const lines: string[] = [];
		if (comments === undefined) {
			return lines;
		}

		this.writtenComments += comments.length;
		for (let index = 0; index < comments.length; index++) {
			const comment = comments[index]!;
			// A blank line between two comments, as between two paragraphs, stays.
			if (index > 0 && hasBlankLine(this.#text, comments[index - 1]!.range[1], comment.range[0])) {
				lines.push('');
			}

			for (let start = 0; start <= comment.value.length;) {
				const end = findLineEnd(comment.value, start);
				lines.push(`${indent}#${comment.value.slice(start, end).trimEnd()}`);
				start = end + 1;
			}
		}

		return lines;
	}

	#tomlTrailing(comment: Comment | undefined): string {
		this.writtenComments += comment ? 1 : 0;
		return comment ? ` #${comment.value.replaceAll('\n', ' ').trimEnd()}` : '';
	}

	#spansLines(node: ValueNode): boolean {
		return node.loc.start.line !== node.loc.end.line;
	}

	#source(node: ValueNode): string {
		return this.#text.slice(node.range[0], node.range[1]);
	}

	#fileCommentSplit(comments: readonly Comment[], first: MemberNode): number {
		for (let index = comments.length; index > 0; index--) {
			if (hasBlankLine(this.#text, comments[index - 1]!.range[1], comments[index]?.range[0] ?? first.range[0])) {
				return index;
			}
		}

		return 0;
	}

	#writeJson(node: ValueNode, indent: string, parts: string[]): void {
		if (node.type !== 'Object' && node.type !== 'Array') {
			parts.push(this.#jsonScalar(node));
			return;
		}

		const isObject = node.type === 'Object';
		const entries = isObject ? node.members : node.elements;
		const opening = isObject ? '{' : '[';
		const closing = isObject ? '}' : ']';
		parts.push(opening);
		if (entries.length === 0) {
			parts.push(closing);
			return;
		}

		const isMultiline = this.#spansLines(node);
		const innerIndent = `${indent}\t`;
		for (const [index, entry_] of entries.entries()) {
			if (index > 0) {
				parts.push(isMultiline ? ',\n' : ', ');
			} else if (isMultiline) {
				parts.push('\n');
			}

			if (isMultiline) {
				parts.push(innerIndent);
			}

			const entry = entry_;
			if (entry.type === 'Member') {
				parts.push(JSON.stringify(entry.key.value), ': ');
				this.#writeJson(entry.value, innerIndent, parts);
			} else {
				this.#writeJson(entry, innerIndent, parts);
			}
		}

		if (isMultiline) {
			parts.push('\n', indent);
		}

		parts.push(closing);
	}

	#jsonScalar(node: Exclude<ValueNode, ObjectNode | ArrayNode>): string {
		switch (node.type) {
			case 'String': {
				return JSON.stringify(node.value);
			}

			case 'Integer': {
				return node.value.toString();
			}

			case 'Float': {
				if (!Number.isFinite(node.value)) {
					throw new TypeError('JSON cannot hold an infinity');
				}

				return formatFloat(node.value);
			}

			case 'Boolean': {
				return String(node.value);
			}

			case 'Null': {
				return 'null';
			}

			case 'Instant':
			case 'Duration': {
				return JSON.stringify(node.value.toString());
			}
		}
	}

	json(node: ValueNode, indent: string): string {
		const parts: string[] = [];
		this.#writeJson(node, indent, parts);
		return parts.join('');
	}

	// The members of a table are its own key and value lines first, then its tables, because TOML requires that order. Each member keeps its comments.
	// `keys` are the parts of the table's header, as they are written.
	toml(object: ObjectNode, keys: string[]): string[] {
		const lines: string[] = [];
		const tables: MemberNode[] = [];
		const {leading, trailing, closing} = this.#attachComments(object, object.members);
		// The comments at the start of a file, up to the last blank line before its first member, are about the file, so they stay first, although TOML may move that member after others.
		const first = object.members[0];
		if (first && keys.length === 0 && leading.has(first)) {
			const comments = leading.get(first)!;
			const split = this.#fileCommentSplit(comments, first);
			if (split > 0) {
				appendLines(lines, this.#tomlComments(comments.slice(0, split), ''));
				lines.push('');
				leading.set(first, comments.slice(split));
			}
		}

		for (const member of object.members) {
			// The comments of a member that TOML leaves out still describe the table, so they stay.
			if (member.value.type === 'Null') {
				const comment = trailing.get(member);
				appendLines(lines, this.#tomlComments([...(leading.get(member) ?? []), ...(comment ? [comment] : [])], ''));
				continue;
			}

			if (this.#isTable(member.value) || this.#isArrayOfTables(member.value)) {
				tables.push(member);
				continue;
			}

			appendLines(lines, this.#tomlComments(leading.get(member), ''));
			lines.push(`${tomlKey(member.key)} = ${this.#tomlValue(member.value, '', false)}${this.#tomlTrailing(trailing.get(member))}`);
		}

		appendLines(lines, this.#tomlComments(closing, ''));
		for (const member of tables) {
			const tableKeys = [...keys, tomlKey(member.key)];
			const header = tableKeys.join('.');
			lines.push('');
			if (member.value.type === 'Object') {
				const body = this.toml(member.value, tableKeys);
				const comments = this.#tomlComments(leading.get(member), '');
				// A table that holds only tables needs no header of its own, as TOML writers leave it out, because each subtable's header names it.
				if (body[0] === '' && comments.length === 0 && !trailing.has(member)) {
					lines.pop();
					appendLines(lines, body);
					continue;
				}

				appendLines(lines, comments);
				lines.push(`[${header}]${this.#tomlTrailing(trailing.get(member))}`);
				appendLines(lines, body);
				continue;
			}

			const array = member.value as ArrayNode;
			const elementComments = this.#attachComments(array, array.elements);
			appendLines(lines, this.#tomlComments(leading.get(member), ''));
			for (const [index, element] of array.elements.entries()) {
				if (index > 0) {
					lines.push('');
				}

				const elementHeader = `[[${header}]]${this.#tomlTrailing(elementComments.trailing.get(element))}`;
				appendLines(lines, this.#tomlComments(elementComments.leading.get(element), ''));
				lines.push(elementHeader);
				appendLines(lines, this.toml(element as ObjectNode, tableKeys));
			}

			// The comments after the last table, such as one that is commented out, follow it.
			appendLines(lines, this.#tomlComments(elementComments.closing, ''));
			const comment = trailing.get(member);
			appendLines(lines, this.#tomlComments(comment ? [comment] : undefined, ''));
		}

		return lines;
	}
}

// Append each line separately so a large comment or table does not exceed the function argument limit.
function appendLines(lines: string[], additions: readonly string[]): void {
	for (const line of additions) {
		lines.push(line);
	}
}

/**
Create a comment bucket only for an element that actually owns a leading comment.
*/
function createCommentList(): Comment[] {
	return [];
}

function isWithin(inner: {range: readonly [number, number]}, outer: {range: readonly [number, number]}): boolean {
	return inner.range[0] >= outer.range[0] && inner.range[1] <= outer.range[1];
}

// A string keeps its quotes, literal or escaped, where TOML has the same kind.
function tomlString(node: StringNode): string {
	if (node.block) {
		// The line break directly after the opening delimiter is not part of a TOML multi-line string, and one before the closing delimiter would be.
		// A literal one cannot end with `'`, which TOML allows but some parsers get wrong. The escaped one keeps its line breaks.
		const isLiteral = !node.value.includes('\'\'\'') && !node.value.endsWith('\'') && !hasControlCharacter(node.value, true);
		return isLiteral ? `'''\n${node.value}'''` : `"""\n${node.value.split('\n').map(line => tomlBasic(line).slice(1, -1)).join('\n')}"""`;
	}

	return tomlQuoted(node.value, node.style);
}

// A quoted key keeps its quotes, literal or escaped, as a string does.
function tomlKey(key: KeyNode): string {
	return isBareKey(key.value) ? key.value : tomlQuoted(key.value, key.style);
}

function tomlQuoted(value: string, style: StringNode['style'] | KeyNode['style']): string {
	return style === 'literal' && !value.includes('\'') && !hasControlCharacter(value, false) ? `'${value}'` : tomlBasic(value);
}

// `JSON.stringify()` writes a valid TOML basic string, except that TOML also requires DEL to be escaped.
function tomlBasic(value: string): string {
	return JSON.stringify(value).replaceAll('\u{7F}', String.raw`\u007F`);
}

function hasControlCharacter(value: string, canHoldLineFeed: boolean): boolean {
	// eslint-disable-next-line no-control-regex, regexp/no-control-character -- TOML rejects these control characters.
	return (canHoldLineFeed ? /[\u{0}-\u{8}\u{B}-\u{1F}\u{7F}]/v : /[\u{0}-\u{8}\u{A}-\u{1F}\u{7F}]/v).test(value);
}

// The SOML value as `JSON.parse()` and smol-toml give it back, to check what was written. Not `JSON.stringify()` of the value, which would write a `Temporal` value with its `toJSON()` and hide a wrong spelling.
function expected(value: unknown, format: 'json' | 'toml'): unknown {
	if (Array.isArray(value)) {
		return value.map(item => expected(item, format));
	}

	if (value instanceof Temporal.Instant) {
		return format === 'json' ? value.toString() : value.epochNanoseconds;
	}

	if (value instanceof Temporal.Duration) {
		return value.toString();
	}

	if (typeof value === 'object' && value !== null) {
		const entries = Object.entries(value).values().filter(([, item]) => format === 'json' || item !== null);
		return Object.fromEntries(entries.map(([key, item]) => [key, expected(item, format)]));
	}

	return value;
}

function plainToml(value: unknown): unknown {
	if (Array.isArray(value)) {
		// eslint-disable-next-line unicorn/no-array-callback-reference -- This private callback consumes only its first argument.
		return value.map(plainToml);
	}

	if (value instanceof Temporal.ZonedDateTime) {
		return value.epochNanoseconds;
	}

	return typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value).values().map(([key, item]) => [key, plainToml(item)])) : value;
}

// An int is read as a `bigint`, so that a change past 2^53 is found too.
// The TypeScript lib does not know the reviver's `context` yet, so it is optional here, although Node.js always passes it.
const readInteger = (_key: string, item: unknown, context?: {source: string}): unknown => typeof item === 'number' && !/[.e]/iv.test(context!.source) ? BigInt(context!.source) : item;

/**
Convert one SOML fixture to checked JSON and TOML, preserving its layout and TOML comments.
*/
export function convertFixture(text: string): {json: string; toml: string; writtenComments: number; commentCount: number} {
	const document = parseTree(text);
	if (document.body.type !== 'Object') {
		throw new TypeError('TOML needs an object at the top');
	}

	const writer = new Writer(document, text);
	const json = `${writer.json(document.body, '')}\n`;
	const toml = `${writer.toml(document.body, []).join('\n').replace(/^\n+/v, '')}\n`;

	const value = evaluate(document);
	const jsonValue: unknown = JSON.parse(json, readInteger);
	if (!isDeepStrictEqual(jsonValue, expected(value, 'json'))) {
		throw new Error('The generated JSON does not hold the same data as the SOML fixture');
	}

	if (!isDeepStrictEqual(plainToml(smolToml.parse(toml, {integersAsBigInt: true, useLegacyDate: false})), expected(value, 'toml'))) {
		throw new Error('The generated TOML does not hold the same data as the SOML fixture');
	}

	return {
		json, toml, writtenComments: writer.writtenComments, commentCount: document.comments.length,
	};
}

if (import.meta.main) {
	// Reject malformed UTF-8, and keep a BOM for the parser to reject rather than silently removing it.
	const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}); // eslint-disable-line @typescript-eslint/naming-convention
	// eslint-disable-next-line unicorn/no-array-sort -- The filtered array belongs to this updater; sorting it avoids another copy.
	for (const file of fs.readdirSync(root).filter(file => file.endsWith('.soml')).sort()) {
		const name = file.slice(0, -'.soml'.length);
		const text = decoder.decode(fs.readFileSync(path.join(root, file)));
		const {json, toml, writtenComments, commentCount} = convertFixture(text);
		if (writtenComments !== commentCount) {
			console.warn(`${describeText(name)}.toml has ${writtenComments} of the ${commentCount} comments, because TOML has no place for the others, such as one inside an inline table`);
		}

		fs.writeFileSync(path.join(root, `${name}.json`), json);
		fs.writeFileSync(path.join(root, `${name}.toml`), toml);
		console.log(`Wrote ${describeText(name)}.json and ${describeText(name)}.toml`);
	}
}
