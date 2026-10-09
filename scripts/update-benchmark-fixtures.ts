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
	parse,
	parseTree,
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

const root = path.join(import.meta.dirname, '..', '..', 'soml', 'benchmark');

type Element = MemberNode | ValueNode;

class Writer {
	readonly #text: string;
	readonly #body: ObjectNode | ArrayNode;
	readonly #comments: readonly Comment[];
	readonly #lineStarts: number[] = [0];
	// The comments written to the TOML, to report those that TOML has no place for.
	writtenComments = 0;

	constructor(document: DocumentNode, text: string) {
		this.#text = text;
		this.#body = document.body;
		this.#comments = document.comments;
		for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
			this.#lineStarts.push(index + 1);
		}
	}

	#jsonContainer(node: ObjectNode | ArrayNode, entries: string[], indent: string): string {
		const [open, close] = node.type === 'Object' ? ['{', '}'] : ['[', ']'];
		if (entries.length === 0) {
			return `${open}${close}`;
		}

		return this.#spansLines(node) ? `${open}\n${entries.map(entry => `${indent}\t${entry}`).join(',\n')}\n${indent}${close}` : `${open}${entries.join(', ')}${close}`;
	}

	// Inside an inline table, everything is on one line, because TOML requires an inline table to be.
	#tomlValue(node: ValueNode, indent: string, isInline: boolean): string {
		switch (node.type) {
			case 'Object': {
				// An inline table must be on one line, and it cannot hold a comment.
				const entries = node.members.filter(member => member.value.type !== 'Null').map(member => `${tomlKey(member.key)} = ${this.#tomlValue(member.value, indent, true)}`);
				return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
			}

			case 'Array': {
				if (node.elements.some(element => element.type === 'Null')) {
					throw new TypeError('TOML cannot hold a null in an array');
				}

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
					lines.push(...this.#tomlComments(leading.get(element), inner), `${inner}${this.#tomlValue(element, inner, false)},${this.#tomlTrailing(trailing.get(element))}`);
				}

				return `[\n${[...lines, ...this.#tomlComments(closing, inner)].join('\n')}\n${indent}]`;
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
	Gives each element of a container the comments before it, back to the element before it, and the comment after it on its own line. The comments after the last element are `closing`. A comment inside an element belongs to that element, and the element finds it when it is written.
	*/
	#attachComments(container: ObjectNode | ArrayNode, elements: readonly Element[]): {leading: Map<Element, Comment[]>; trailing: Map<Element, Comment>; closing: Comment[]} {
		const leading = new Map<Element, Comment[]>();
		const trailing = new Map<Element, Comment>();
		const closing: Comment[] = [];
		// A top-level object without braces starts at its first member and ends at its last, so the comments of the file before and after it are its own.
		const [start, end] = container === this.#body ? [0, this.#text.length] : container.range;
		const inside = this.#comments.filter(comment => comment.range[0] >= start && comment.range[1] <= end && elements.every(element => !isWithin(comment, element)));
		let index = 0;
		for (const comment of inside) {
			while (index < elements.length && elements[index]!.range[1] <= comment.range[0]) {
				index++;
			}

			const previous = elements[index - 1];
			if (previous && this.#line(previous.range[1]) === this.#line(comment.range[0]) && !trailing.has(previous)) {
				trailing.set(previous, comment);
			} else if (index < elements.length) {
				leading.set(elements[index]!, [...(leading.get(elements[index]!) ?? []), comment]);
			} else {
				closing.push(comment);
			}
		}

		return {leading, trailing, closing};
	}

	#tomlComments(comments: readonly Comment[] | undefined, indent: string): string[] {
		this.writtenComments += comments?.length ?? 0;
		const lines: string[] = [];
		for (const [index, comment] of (comments ?? []).entries()) {
			// A blank line between two comments, as between two paragraphs, stays.
			if (index > 0 && /\n[\t ]*\n/v.test(this.#text.slice(comments![index - 1]!.range[1], comment.range[0]))) {
				lines.push('');
			}

			lines.push(...comment.value.split('\n').map(line => `${indent}#${line.trimEnd()}`));
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

	#line(offset: number): number {
		let low = 0;
		let high = this.#lineStarts.length - 1;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (this.#lineStarts[middle]! <= offset) {
				low = middle;
			} else {
				high = middle - 1;
			}
		}

		return low;
	}

	#source(node: ValueNode): string {
		return this.#text.slice(node.range[0], node.range[1]);
	}

	json(node: ValueNode, indent: string): string {
		switch (node.type) {
			case 'Object': {
				const entries = node.members.map(member => `${JSON.stringify(member.key.value)}: ${this.json(member.value, `${indent}\t`)}`);
				return this.#jsonContainer(node, entries, indent);
			}

			case 'Array': {
				return this.#jsonContainer(node, node.elements.map(element => this.json(element, `${indent}\t`)), indent);
			}

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
			const ends = [...comments.map(comment => comment.range[0]), first.range[0]];
			const split = ends.findLastIndex((end, index) => index > 0 && /\n[\t ]*\n/v.test(this.#text.slice(comments[index - 1]!.range[1], end)));
			if (split > 0) {
				lines.push(...this.#tomlComments(comments.slice(0, split), ''), '');
				leading.set(first, comments.slice(split));
			}
		}

		for (const member of object.members) {
			// The comments of a member that TOML leaves out still describe the table, so they stay.
			if (member.value.type === 'Null') {
				const comment = trailing.get(member);
				lines.push(...this.#tomlComments([...(leading.get(member) ?? []), ...(comment ? [comment] : [])], ''));
				continue;
			}

			if (this.#isTable(member.value) || this.#isArrayOfTables(member.value)) {
				tables.push(member);
				continue;
			}

			lines.push(...this.#tomlComments(leading.get(member), ''), `${tomlKey(member.key)} = ${this.#tomlValue(member.value, '', false)}${this.#tomlTrailing(trailing.get(member))}`);
		}

		lines.push(...this.#tomlComments(closing, ''));
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
					lines.push(...body);
					continue;
				}

				lines.push(...comments, `[${header}]${this.#tomlTrailing(trailing.get(member))}`, ...body);
				continue;
			}

			const array = member.value as ArrayNode;
			const elementComments = this.#attachComments(array, array.elements);
			lines.push(...this.#tomlComments(leading.get(member), ''));
			for (const [index, element] of array.elements.entries()) {
				if (index > 0) {
					lines.push('');
				}

				const elementHeader = `[[${header}]]${this.#tomlTrailing(elementComments.trailing.get(element))}`;
				lines.push(...this.#tomlComments(elementComments.leading.get(element), ''), elementHeader, ...this.toml(element as ObjectNode, tableKeys));
			}

			// The comments after the last table, such as one that is commented out, follow it.
			lines.push(...this.#tomlComments(elementComments.closing, ''));
		}

		return lines;
	}
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

	return node.style === 'literal' && !node.value.includes('\'') && !hasControlCharacter(node.value, false) ? `'${node.value}'` : tomlBasic(node.value);
}

// A quoted key keeps its quotes, literal or escaped, as a string does.
function tomlKey(key: KeyNode): string {
	if (/^[\w\-]+$/v.test(key.value)) {
		return key.value;
	}

	return key.style === 'literal' && !key.value.includes('\'') && !hasControlCharacter(key.value, false) ? `'${key.value}'` : tomlBasic(key.value);
}

// `JSON.stringify()` writes a valid TOML basic string, except that TOML also requires DEL to be escaped.
function tomlBasic(value: string): string {
	return JSON.stringify(value).replaceAll('\u{7F}', String.raw`\u007F`);
}

function hasControlCharacter(value: string, canHoldLineFeed: boolean): boolean {
	return [...value].some(character => {
		const code = character.codePointAt(0)!;
		return (code < 0x20 && code !== 0x09 && !(canHoldLineFeed && code === 0x0A)) || code === 0x7F;
	});
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

	if (typeof value !== 'object' || value === null) {
		return value;
	}

	const entries = Object.entries(value).filter(([, item]) => format === 'json' || item !== null);
	return Object.fromEntries(entries.map(([key, item]) => [key, expected(item, format)]));
}

function plainToml(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => plainToml(item));
	}

	if (value instanceof Temporal.ZonedDateTime) {
		return value.epochNanoseconds;
	}

	return typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainToml(item)])) : value;
}

for (const file of fs.readdirSync(root).filter(file => file.endsWith('.soml')).toSorted()) {
	const name = file.slice(0, -'.soml'.length);
	const text = fs.readFileSync(path.join(root, file), 'utf8');
	const document = parseTree(text);
	if (document.body.type !== 'Object') {
		throw new TypeError(`${file}: TOML needs an object at the top`);
	}

	const writer = new Writer(document, text);
	const json = `${writer.json(document.body, '')}\n`;
	const toml = `${writer.toml(document.body, []).join('\n').replace(/^\n+/v, '')}\n`;

	const value = parse(text, {integers: 'bigint'});
	// An int is read as a `bigint`, so that a change past 2^53 is found too.
	// The TypeScript lib does not know the reviver's `context` yet, so it is optional here, although Node.js always passes it.
	const readInteger = (_key: string, item: unknown, context?: {source: string}): unknown => typeof item === 'number' && !/[.e]/iv.test(context!.source) ? BigInt(context!.source) : item;
	const jsonValue: unknown = JSON.parse(json, readInteger);
	if (!isDeepStrictEqual(jsonValue, expected(value, 'json'))) {
		throw new Error(`${name}.json does not hold the same data as ${file}`);
	}

	if (!isDeepStrictEqual(plainToml(smolToml.parse(toml, {integersAsBigInt: true, useLegacyDate: false})), expected(value, 'toml'))) {
		throw new Error(`${name}.toml does not hold the same data as ${file}`);
	}

	if (writer.writtenComments !== document.comments.length) {
		console.warn(`${name}.toml has ${writer.writtenComments} of the ${document.comments.length} comments, because TOML has no place for the others, such as one inside an inline table`);
	}

	fs.writeFileSync(path.join(root, `${name}.json`), json);
	fs.writeFileSync(path.join(root, `${name}.toml`), toml);
	console.log(`Wrote ${name}.json and ${name}.toml`);
}
