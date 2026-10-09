/* eslint-disable unicorn/prefer-structured-clone -- Verify JSON round trips preserve query behavior. */
/* eslint-disable node-test/no-useless-assertion, unicorn/no-break-in-nested-loop -- Assertions include fixture context; loops traverse independent fixtures. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
	getEditorContext,
	getCompletionContext,
	parseForEditor,
	parseTree,
	type EditorNode,
	type EditorSlot,
} from '../source/index.ts';

function marked(source: string) {
	const offset = source.indexOf('|');
	assert.notStrictEqual(offset, -1);
	return {document: parseForEditor(source.replace('|', '')), offset};
}

const sites: ReadonlyArray<readonly [string, EditorSlot['kind'], string, string]> = [
	['|', 'document', '', ''],
	[' \t|\n', 'document', '', ''],
	['# header\n|', 'document', '', ''],
	['/* header */|', 'document', '', ''],
	['port: |', 'member-value', '', ''],
	['port:|', 'member-value', '', ''],
	['port:\n\t|', 'member-value', '', ''],
	['enabled: tr|', 'member-value', 'tr', 'tr'],
	['enabled: tr|ue', 'member-value', 'true', 'tr'],
	['enabled: |true', 'member-value', 'true', ''],
	['limit: -inf|', 'member-value', '-inf', '-inf'],
	['duration: 1|ns', 'member-value', '1ns', '1'],
	['date: 2026-10-11T12:|30:00Z', 'member-value', '2026-10-11T12:30:00Z', '2026-10-11T12:'],
	['0: |', 'member-value', '', ''],
	['\'😀\': |', 'member-value', '', ''],
	['port: |\nsecure: true', 'member-value', '', ''],
	['port: | # keep\nsecure: true', 'member-value', '', ''],
	['port: |\n404:80', 'member-value', '', ''],
	['port: |\n12:34', 'member-value', '', ''],
	['port: |\n2026-01-01T01: true', 'member-value', '', ''],
	['port: |\nb:2026-01-01T01:00:00Z', 'member-value', '', ''],
	['port: |\n\'quoted key\': true', 'member-value', '', ''],
	['port: /* comment */|', 'member-value', '', ''],
	['port: | /* comment */', 'member-value', '', ''],
	['port: /* comment\n */ |', 'member-value', '', ''],
	['[|]', 'array-element', '', ''],
	['[|', 'array-element', '', ''],
	['[true, |]', 'array-element', '', ''],
	['[true\n|]', 'array-element', '', ''],
	['[true,\n|]', 'array-element', '', ''],
	['[true /* note */, |]', 'array-element', '', ''],
	['[true # note\n|]', 'array-element', '', ''],
	['[tr|ue]', 'array-element', 'true', 'tr'],
	['[|, false]', 'array-element', '', ''],
	['[|\nfalse]', 'array-element', '', ''],
	['[| # note\nfalse]', 'array-element', '', ''],
	['[| /* note */\nfalse]', 'array-element', '', ''],
	['[|\n2026-01-01T01:00:00Z]', 'array-element', '', ''],
	['[\'\'\'\ntext\n\'\'\', |]', 'array-element', '', ''],
	['{port: |}', 'member-value', '', ''],
	['{port: |, secure: true}', 'member-value', '', ''],
	['{port: |\nsecure: true}', 'member-value', '', ''],
	['{|}', 'key', '', ''],
	['{|', 'key', '', ''],
	['{host: true, |}', 'key', '', ''],
	['{host: true\n|}', 'key', '', ''],
	['{ho|}', 'key', 'ho', 'ho'],
	['{ho|st: true}', 'key', 'host', 'ho'],
	['{|host: true}', 'key', 'host', ''],
	['{host|: true}', 'key', 'host', 'host'],
	['{ho| # note\n}', 'key', 'ho', 'ho'],
	['{|\nhost: true}', 'key', '', ''],
	['{| # note\nhost: true}', 'key', '', ''],
	['host: true\n|', 'key', '', ''],
	['host: true\npo|', 'key', 'po', 'po'],
	['[{host: true}, {ho|}]', 'key', 'ho', 'ho'],
	['[{host: true}, {|}]', 'key', '', ''],
	['{nested: {port: |', 'member-value', '', ''],
	['{nested: [true, |', 'array-element', '', ''],
	['a: true b: |', 'member-value', '', ''],
	['broken:\nvalid: tr|', 'member-value', 'tr', 'tr'],
	['duplicate: 1\nduplicate: tr|', 'member-value', 'tr', 'tr'],
];

for (const [source, kind, replacement, prefix] of sites) {
	test(`completion site ${JSON.stringify(source)}`, () => {
		const {document, offset} = marked(source);
		const context = getCompletionContext(document, offset);
		assert.ok(context);
		assert.equal(context.slot.kind, kind);
		assert.equal(document.text.slice(...context.range), replacement);
		assert.equal(context.prefix, prefix);
		assert.ok(context.range[0] <= offset);
		assert.ok(offset <= context.range[1]);
		if (replacement === '') {
			assert.deepEqual(context.range, [offset, offset]);
		}
	});
}

const suppressed = [
	'a: true |',
	'a: true\t|',
	'a: [true] |',
	'{}|',
	'[]|',
	'[]\n|',
	'a:| true',
	'a: | [1]',
	'a: | {b: true}',
	'a: |\ntrue',
	'a: |\n2026-01-01T01:00:00Z',
	'a: | # note\n2026-01-01T01:00:00.123456789+01:30',
	'a: | /* comment\n */ true',
	'a: | # note\n\'hello\'',
	'a: | /* unfinished',
	'a: | /* */ false',
	'[| true]',
	'[true, | false]',
	'[true |]',
	'[true /*\n*/ |]',
	'[| /*\n*/ false]',
	'[}\n|',
	'[|\n,false]',
	'[true\n, |]',
	'{a: true |}',
	'{| age: 2}',
	'{| /* note */ age: 2}',
	'a| : true',
	'a |: true',
	'a: |, b: true',
	'a: \'te|xt\'',
	'a: \'text|',
	String.raw`a: "te\"|xt"`,
	'a: "unfinished |',
	'a: \'\'\'\ntext : [ |\n\'\'\'',
	'a: \'\'\'\'\n\'\'\'\n|\n\'\'\'\'',
	'a: """\n|',
	'a: # |',
	'a: # note|',
	'a: /* | */',
	'a: /* note|',
	'a: /* note*|/',
	'{\'na|me\': true}',
	'{"na|me": true}',
	'{\'name|}',
	'{"name|}',
	'[true false|]',
	'{a: true b|: false}',
];

for (const source of suppressed) {
	test(`suppressed completion ${JSON.stringify(source)}`, () => {
		const {document, offset} = marked(source);
		assert.equal(getCompletionContext(document, offset), undefined);
	});
}

for (const source of ['a: |', 'a: tr|ue', 'a: |\nb: false', 'a: | # note', 'a: | /* note */', 'a: |\n404:80', '[|]', '[|, false]', '[|\nfalse]', '[true, |]', '{a: |}', '{a: |, b: false}']) {
	test(`offered scalar replacement produces valid syntax ${JSON.stringify(source)}`, () => {
		const {document, offset} = marked(source);
		const context = getCompletionContext(document, offset)!;
		for (const value of ['true', 'false', 'null', '0', '-1', '1.0', '0xFF', '1ns', '2026-01-01T00:00:00Z', '\'😀\'', '[]', '{}']) {
			assert.doesNotThrow(() => parseTree(document.text.slice(0, context.range[0]) + value + document.text.slice(context.range[1])), value);
		}
	});
}

for (const offset of [-1, -Infinity, Infinity, NaN, 0.1, Number.MAX_SAFE_INTEGER + 1, '1', undefined]) {
	test(`rejects invalid offset ${String(offset)}`, () => {
		const document = parseForEditor('a: 1');
		assert.throws(() => getEditorContext(document, offset as number), TypeError);
		assert.throws(() => getCompletionContext(document, offset as number), TypeError);
	});
}

test('out-of-range offsets return undefined and EOF remains queryable', () => {
	for (const text of ['', 'a:', '[]', 'a: true']) {
		const document = parseForEditor(text);
		assert.ok(getEditorContext(document, text.length));
		assert.equal(getEditorContext(document, text.length + 1), undefined);
		assert.equal(getCompletionContext(document, text.length + 1), undefined);
	}
});

test('affinity is explicit and validated', () => {
	const document = parseForEditor('a:true');
	assert.equal(getEditorContext(document, 1)?.token?.kind, 'punctuation');
	assert.equal(getEditorContext(document, 1, {side: 'left'})?.token?.kind, 'key');
	assert.equal(getEditorContext(document, 2)?.token?.kind, 'scalar');
	assert.equal(getEditorContext(document, 2, {side: 'left'})?.token?.kind, 'punctuation');
	assert.equal(getEditorContext(document, 6)?.token, undefined);
	assert.equal(getEditorContext(document, 6, {side: 'left'})?.token?.kind, 'scalar');
	assert.throws(() => getEditorContext(document, 0, {side: 'nearest' as 'left'}), TypeError);
});

test('affinity never crosses whitespace', () => {
	const document = parseForEditor('a:  true');
	assert.equal(getEditorContext(document, 3, {side: 'left'})?.token, undefined);
	assert.equal(getEditorContext(document, 3)?.token, undefined);
	assert.equal(getEditorContext(document, 4, {side: 'left'})?.token, undefined);
	assert.equal(getEditorContext(document, 4)?.token?.kind, 'scalar');
});

test('value slots identify ownership without permission to overwrite later values', () => {
	const {document, offset} = marked('port: | /* note */\n8080');
	assert.equal(getEditorContext(document, offset)?.slot?.kind, 'member-value');
	assert.equal(getCompletionContext(document, offset), undefined);
});

test('comments retain structural ownership without becoming completion sites', () => {
	const {document, offset} = marked('a: /* co|mment */ 1');
	const context = getEditorContext(document, offset)!;
	assert.equal(context.token?.kind, 'blockComment');
	assert.equal(context.slot?.kind, 'member-value');
	assert.equal(getCompletionContext(document, offset), undefined);
});

test('duplicate keys and prototype-like names retain node identity', () => {
	for (const key of ['a', '__proto__', 'constructor', 'toString']) {
		const {document, offset} = marked(`${key}: 1\n${key}: tr|`);
		const object = document.root.children.at(0);
		assert.equal(object?.type, 'EditorObject');
		const context = getCompletionContext(document, offset)!;
		assert.equal(context.slot.owner, object.members[1]);
		assert.ok(context.ancestors.includes(object.members[1]!));
		assert.ok(!context.ancestors.includes(object.members[0]!));
	}
});

test('array indexes count recovered syntax including error entries', () => {
	const {document, offset} = marked('[1, , tr|]');
	const slot = getEditorContext(document, offset, {side: 'left'})?.slot;
	assert.equal(slot?.kind, 'array-element');
	assert.equal(slot.index, 2);
	assert.equal(slot.owner, document.root.children.at(0));
});

test('colon ranges distinguish incomplete keys from keys with existing values', () => {
	for (const source of ['[{host: 1}, {ho|}]', '[{host: 1}, {ho|: 2}]']) {
		const {document, offset} = marked(source);
		const context = getCompletionContext(document, offset)!;
		assert.equal(context.slot.kind, 'key');
		assert.ok(context.slot.member);
		const colon = context.slot.member.colonRange;
		const replacement = colon ? 'host' : 'host: null';
		const result = parseTree(document.text.slice(0, context.range[0]) + replacement + document.text.slice(context.range[1]));
		assert.equal(result.body.type, 'Array');
		if (!colon) {
			continue;
		}

		assert.equal(document.text.slice(...colon), ':');
		assert.equal(result.body.elements[1]?.type, 'Object');
		assert.equal(result.body.elements[1].members[0]?.value.type, 'Integer');
	}
});

test('unfinished nested collections remain ancestors at EOF with either affinity', () => {
	for (const source of ['a: [', 'a: {b: [', '[{a: [']) {
		const document = parseForEditor(source);
		for (const side of ['left', 'right'] as const) {
			const context = getEditorContext(document, source.length, {side})!;
			assert.equal(context.ancestors.at(-1)?.type, 'EditorArray');
			assert.equal(context.slot?.kind, 'array-element');
		}
	}
});

function allNodes(node: EditorNode): EditorNode[] {
	let children: readonly EditorNode[] = [];
	switch (node.type) {
		case 'EditorDocument': {children = node.children;
			break;}

		case 'EditorObject': {children = node.members;
			break;}

		case 'EditorArray': {children = node.elements;
			break;}

		case 'EditorMember': {children = [node.key, node.value];
			break;}

		default: {break;}
	}

	return [node, ...children.flatMap(child => allNodes(child))];
}

function verifyQueries(text: string, offsets: readonly number[]): void {
	const document = parseForEditor(text);
	const nodes = new Set(allNodes(document.root));
	const original = JSON.stringify(document);
	for (const offset of offsets) {
		for (const side of ['left', 'right'] as const) {
			const context = getEditorContext(document, offset, {side})!;
			const token = document.tokens.find(token => side === 'left' ? token.range[0] < offset && offset <= token.range[1] : token.range[0] <= offset && offset < token.range[1]);
			assert.equal(context.token, token);
			assert.equal(context.ancestors[0], document.root);
			for (const node of context.ancestors) {
				assert.ok(nodes.has(node));
				assert.ok(node.range[0] <= offset);
				assert.ok(offset <= node.range[1]);
			}

			if (context.slot) {
				assert.ok(nodes.has(context.slot.owner));
			}
		}

		const completion = getCompletionContext(document, offset);
		if (!completion) {
			continue;
		}

		assert.ok(nodes.has(completion.slot.owner));
		assert.ok(completion.range[0] <= offset);
		assert.ok(offset <= completion.range[1]);
		assert.ok(completion.range[1] <= text.length);
		assert.equal(completion.prefix, text.slice(completion.range[0], offset));
	}

	assert.equal(JSON.stringify(document), original);
}

test('every cursor boundary agrees with independent linear token lookup', () => {
	for (const source of [...sites.map(site => site[0]), ...suppressed, '\'😀\': [\'😃\', 1ns]\n# 😀', 'a:\r\nb: \u{D800}', 'a: [1 /* x\n */ , {b: "\\u{1f600}"}]']) {
		const text = source.replace('|', '');
		verifyQueries(text, Array.from({length: text.length + 1}, (_, index) => index));
	}
});

test('typing deletions preserve query invariants at every remaining position', () => {
	for (const text of ['a: [{name: \'😀\', enabled: true}, {other: false}]', 'a: 2026-01-01T01:00:00.123456789+01:30\nb: 1ns', 'a: \'\'\'\'\n\'\'\'\nbody\n\'\'\'\'\nb: /* note */ true']) {
		for (let deleted = 0; deleted < text.length; deleted++) {
			const changed = text.slice(0, deleted) + text.slice(deleted + 1);
			verifyQueries(changed, Array.from({length: changed.length + 1}, (_, index) => index));
		}
	}
});

test('conformance fixtures support queries at all token and node boundaries', () => {
	const directory = path.join(import.meta.dirname, 'conformance');
	const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}); // eslint-disable-line @typescript-eslint/naming-convention
	for (const category of ['valid', 'invalid']) {
		const root = path.join(directory, category);
		for (const file of fs.readdirSync(root, {recursive: true, encoding: 'utf8'})) {
			if (!file.endsWith('.soml') || /\.(?:formatted|canonical)\.soml$/v.test(file)) {
				continue;
			}

			let text: string;
			try {
				text = decoder.decode(fs.readFileSync(path.join(root, file)));
			} catch {
				continue;
			}

			const document = parseForEditor(text);
			const offsets = new Set([0, text.length]);
			for (const item of [...allNodes(document.root), ...document.tokens]) {
				offsets.add(item.range[0]);
				offsets.add(item.range[1]);
			}

			verifyQueries(text, [...offsets]);
			if (category === 'valid') {
				for (let offset = 0; offset <= text.length; offset++) {
					const context = getCompletionContext(document, offset);
					if (context?.slot.kind === 'member-value' || context?.slot.kind === 'array-element') {
						assert.doesNotThrow(() => parseTree(text.slice(0, context.range[0]) + 'true' + text.slice(context.range[1])), `${file}:${offset}`);
					}
				}
			}
		}
	}
});

test('queries accept frozen and serialized snapshots without modifying them', () => {
	const original = parseForEditor('[{host: true}, {ho: false}]');
	function freeze(value: unknown): void {
		if (value === null || typeof value !== 'object') {
			return;
		}

		for (const child of Object.values(value)) {
			freeze(child);
		}

		Object.freeze(value);
	}

	for (const document of [original, JSON.parse(JSON.stringify(original)) as typeof original]) {
		freeze(document);
		const context = getCompletionContext(document, 18)!;
		assert.equal(context.prefix, 'ho');
		assert.equal(context.slot.kind, 'key');
		assert.equal(context.ancestors[0], document.root);
	}
});

test('wide arrays use logarithmic position lookups instead of scanning siblings', () => {
	const document = parseForEditor(`[${'true,'.repeat(99_999)}false]`);
	let reads = 0;
	function tracked<T>(items: readonly T[]): readonly T[] {
		return new Proxy(items, {
			get(target, property, receiver) {
				assert.notEqual(property, Symbol.iterator);
				if (typeof property === 'string' && /^\d+$/v.test(property)) {
					reads++;
				}

				return Reflect.get(target, property, receiver) as unknown;
			},
		});
	}

	const array = document.root.children.at(0)!;
	assert.equal(array.type, 'EditorArray');
	const snapshot = {...document, tokens: tracked(document.tokens), root: {...document.root, children: [{...array, elements: tracked(array.elements)}]}};
	const context = getCompletionContext(snapshot, document.text.length - 2)!;
	assert.equal(context.prefix, 'fals');
	assert.equal(context.slot.kind, 'array-element');
	assert.equal(context.slot.index, 99_999);
	assert.ok(reads < 400, `${reads} indexed reads`);
});
