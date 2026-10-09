import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
	parseForEditor,
	parseTree,
	ParseError,
	type EditorNode,
	type EditorObject,
	type EditorParseResult,
	type Node,
} from '../source/index.ts';

function object(text: string): EditorObject {
	const result = parseForEditor(text);
	const node = result.root.children.at(0);
	assert.equal(node?.type, 'EditorObject');
	return node;
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

function checkRanges(result: EditorParseResult): void {
	const {text, root, tokens, diagnostics} = result;
	assert.deepEqual(root.range, [0, text.length]);
	function visit(node: EditorNode): void {
		assert.ok(node.range[0] >= 0);
		assert.ok(node.range[0] <= node.range[1]);
		assert.ok(node.range[1] <= text.length);
		let previousEnd = node.range[0];
		for (const child of children(node)) {
			assert.ok(child.range[0] >= previousEnd);
			assert.ok(child.range[1] <= node.range[1]);
			previousEnd = child.range[1];
			visit(child);
		}
	}

	visit(root);
	let previousEnd = 0;
	for (const token of tokens) {
		assert.ok(token.range[0] >= previousEnd);
		assert.ok(token.range[0] < token.range[1]);
		assert.ok(token.range[1] <= text.length);
		previousEnd = token.range[1];
	}

	assert.ok(diagnostics.length <= 100);
	for (const diagnostic of diagnostics) {
		assert.ok(diagnostic.range[0] >= 0);
		assert.ok(diagnostic.range[0] <= diagnostic.range[1]);
		assert.ok(diagnostic.range[1] <= text.length);
		for (const related of diagnostic.related ?? []) {
			assert.ok(related.range[0] >= 0);
			assert.ok(related.range[1] <= text.length);
		}
	}
}

function shape(node: EditorNode | Node): unknown {
	switch (node.type) {
		case 'Document': {return shape(node.body);} // eslint-disable-line unicorn/no-useless-recursion -- Normalize the document wrapper.
		case 'EditorDocument': {return shape(node.children.at(0)!);} // eslint-disable-line unicorn/no-useless-recursion -- Normalize the document wrapper.
		case 'Object':
		case 'EditorObject': {return {object: node.members.map(member => shape(member))};}
		case 'Array':
		case 'EditorArray': {return {array: node.elements.map(element => shape(element))};}
		case 'Member':
		case 'EditorMember': {return {key: shape(node.key), value: shape(node.value)};}
		case 'Key': {return node.value;}
		case 'EditorKey': {return node.key;}
		case 'EditorScalar': {return node.scalarKind;}
		case 'String': {return 'string';}
		case 'Integer': {return 'int';}
		case 'Float': {return 'float';}
		case 'Boolean': {return 'bool';}
		case 'Null': {return 'null';}
		case 'Instant': {return 'instant';}
		case 'Duration': {return 'duration';}
		default: {throw new Error(`Unexpected ${node.type}`);}
	}
}

test('missing values preserve unrelated members and explicit placeholders', () => {
	for (const next of ['next: true', '\'next\': true', '"next": true', '404: true']) {
		const text = `host: 'local'\nport:\n${next}`;
		const result = parseForEditor(text);
		const {members} = object(text);
		assert.equal(members.length, 3);
		assert.equal(members[1]?.type, 'EditorMember');
		if (members[1]?.type === 'EditorMember') {
			assert.equal(members[1].value.type, 'EditorMissing');
			assert.equal(members[1].value.range[0], members[1].value.range[1]);
		}

		assert.equal(result.diagnostics[0]?.code, 'invalid-document');
		checkRanges(result);
	}
});

test('values on following lines remain valid, including instants and block strings', () => {
	for (const value of ['8080', 'true', '\'text\'', '2026-10-11T12:00:00Z', '2026-10-11T12:00:00.123456789+02:00', '\'\'\'\nnext: fake\n\'\'\'', '{next: true}']) {
		const text = `value:\n${value}\nafter: 1`;
		const result = parseForEditor(text);
		assert.deepEqual(result.diagnostics, [], text);
		assert.deepEqual(shape(result.root), shape(parseTree(text)), text);
	}
});

test('nested block strings preserve strict tree structure and lexical positions', () => {
	function rangeShape(node: EditorNode | Node): unknown {
		let descendants: ReadonlyArray<EditorNode | Node> = [];
		if ('members' in node) {
			descendants = node.members;
		} else if ('elements' in node) {
			descendants = node.elements;
		} else if (node.type === 'Member' || node.type === 'EditorMember') {
			descendants = [node.key, node.value];
		}

		return [node.range, descendants.map(child => rangeShape(child))];
	}

	const memberShapes = [{key: 'key😀', value: 'string'}, {key: '😀', value: 'duration'}];
	const expectedShape = {object: [{key: 'outer', value: {array: [{object: memberShapes}]}}]};
	const cases = [3, 4, 5, 6, 7, 8].flatMap(length => ['\'', '"'].flatMap(quote => ['', '\t', ' \t'].map(indentation => ({length, quote, indentation}))));
	for (const {length, quote, indentation} of cases) {
		const delimiter = quote.repeat(length);
		const content = [`${indentation}body 😀 # /* */ [ ]`, `${indentation}${quote.repeat(length + 1)}`, `${indentation}${quote.repeat(length - 1)} inside`, ' \t ', `${indentation}end`].join('\n');
		const block = `${delimiter}\n\n${content}\n\n${indentation}${delimiter}`;
		const text = `# header 😀\n{outer: [{"key\\u{1f600}": ${block}, '😀': 1ns}]} # tail`;
		const strict = parseTree(text);
		const result = parseForEditor(text);
		assert.deepEqual(result.diagnostics, [], text);
		assert.deepEqual(shape(strict), expectedShape, text);
		assert.deepEqual(shape(result.root), expectedShape, text);
		assert.deepEqual(rangeShape(result.root.children.at(0)!), rangeShape(strict.body), text);
		checkRanges(result);

		const lexical = [...strict.tokens, ...strict.comments].toSorted((first, second) => first.range[0] - second.range[0]);
		assert.deepEqual(result.tokens.map(token => token.range), lexical.map(token => token.range), text);
		for (const token of lexical) {
			for (const [index, boundary] of (['start', 'end'] as const).entries()) {
				const lines = text.slice(0, token.range[index]).split('\n');
				assert.deepEqual(token.loc[boundary], {line: lines.length, column: lines.at(-1)!.length}, text);
			}
		}
	}
});

test('unfinished containers preserve children and return ancestor closers to their owner', () => {
	for (const text of ['a: [1, 2', 'a: {b: true', 'a: [{b: 1]', '{a: [1}']) {
		const result = parseForEditor(text);
		assert.ok(result.diagnostics.some(error => error.code === 'missing-close'));
		checkRanges(result);
	}

	const result = parseForEditor('a: [{b: 1]\nafter: true');
	assert.equal(object(result.text).members.length, 2);
	assert.ok(JSON.stringify(result.root).includes('after'));
});

test('unfinished ordinary strings recover at LF while blocks and comments consume EOF', () => {
	assert.equal(object('a: \'unfinished\nb: true').members.length, 2);
	assert.equal(object('a: "unfinished\\\nb: true').members.length, 2);
	for (const text of ['a: \'\'\'\nb: true', 'a: /* unfinished\nb: true', 'a: """\nb: true']) {
		assert.equal(object(text).members.length, 1);
		checkRanges(parseForEditor(text));
	}
});

test('duplicate decoded keys retain source members and related ranges without prototype lookup', () => {
	for (const key of ['__proto__', 'constructor', 'toString', 'normal']) {
		const text = `${key}: 1\n'${key}': 2`;
		const result = parseForEditor(text);
		assert.equal(object(text).members.length, 2);
		const diagnostic = result.diagnostics.find(error => error.code === 'duplicate-key');
		assert.deepEqual(diagnostic?.range, [key.length + 4, (key.length * 2) + 6]);
		assert.deepEqual(diagnostic?.related?.[0]?.range, [0, key.length]);
	}
});

test('malformed scalars never acquire invented values or scalar kinds', () => {
	for (const value of ['9223372036854775808', '0.5ns', '2026-02-30T00:00:00Z', 'unknown', String.raw`"\r"`, '\'raw\u{0}\'', '\'\u{D800}\'']) {
		const member = object(`a: ${value}\nb: true`).members[0];
		assert.equal(member?.type, 'EditorMember');
		if (member?.type === 'EditorMember') {
			assert.equal(member.value.type, 'EditorError');
		}
	}
});

test('recovery is bounded in depth and diagnostics while retaining later structure', () => {
	const deep = `[${'['.repeat(20_000)}0${']'.repeat(20_000)}, true]`;
	const result = parseForEditor(deep);
	checkRanges(result);
	assert.ok(result.diagnostics.some(error => error.code === 'depth-limit'));
	const many = parseForEditor(`${Array.from({length: 200}, (_, index) => `key${index}: bad`).join('\n')}\nlast: true`);
	assert.equal(many.diagnostics.length, 100);
	assert.equal(many.diagnosticsTruncated, true);
	assert.equal(object(many.text).members.length, 201);
});

test('recovery diagnostics sanitize terminal and bidirectional controls', () => {
	const controls = [...Array.from({length: 32}, (_, index) => 0x80 + index), 0x6_1C, 0x20_0E, 0x20_0F, 0x20_2A, 0x20_2B, 0x20_2C, 0x20_2D, 0x20_2E, 0x20_66, 0x20_67, 0x20_68, 0x20_69];
	for (const codePoint of controls) {
		const character = String.fromCodePoint(codePoint);
		const text = `value: "\\${character}"`;
		const result = parseForEditor(text);
		const strict = result.diagnostics.find(diagnostic => diagnostic.code === 'invalid-document');
		const recovered = result.diagnostics.find(diagnostic => diagnostic.code === 'invalid-value');
		assert.ok(strict);
		assert.ok(recovered);
		assert.equal(recovered.message, strict.message, codePoint.toString(16));
		for (const diagnostic of result.diagnostics) {
			assert.ok(!diagnostic.message.includes(character));
		}

		assert.deepEqual(parseForEditor(`value: '${character}'`).diagnostics, []);
	}
});

test('input is decoded text and empty documents still have roots', () => {
	assert.throws(() => parseForEditor(42 as unknown as string), TypeError);
	const result = parseForEditor('');
	assert.deepEqual(result.root, {type: 'EditorDocument', range: [0, 0], children: []});
	assert.equal(result.diagnostics.length, 1);
});

test('editor parsing agrees with strict validity and structure across conformance fixtures', () => {
	const directory = path.join(import.meta.dirname, 'conformance');
	const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}); // eslint-disable-line @typescript-eslint/naming-convention
	for (const category of ['valid', 'invalid']) {
		const root = path.join(directory, category);
		const files = fs.readdirSync(root, {recursive: true, encoding: 'utf8'}).filter(file => file.endsWith('.soml') && !/\.(?:formatted|canonical)\.soml$/v.test(file));
		for (const file of files) {
			let text: string;
			try {
				text = decoder.decode(fs.readFileSync(path.join(root, file)));
			} catch {
				continue; // eslint-disable-line unicorn/no-break-in-nested-loop -- Byte-invalid fixtures are outside this decoded-string API.
			}

			const result = parseForEditor(text);
			checkRanges(result);
			if (category === 'valid') {
				assert.deepEqual(result.diagnostics, [], file);
				assert.deepEqual(shape(result.root), shape(parseTree(text)), file);
			} else {
				assert.ok(result.diagnostics.length > 0, file);
				assert.throws(() => parseTree(text), error => {
					assert.ok(error instanceof ParseError);
					assert.equal(result.diagnostics[0]?.message, error.reason, file);
					const width = (text.codePointAt(error.offset) ?? 0) > 0xFF_FF ? 2 : 1;
					assert.deepEqual(result.diagnostics[0]?.range, [error.offset, Math.min(text.length, error.offset + width)], file);
					return true;
				});
			}
		}
	}
});

test('typing prefixes and delimiter mutations terminate with deterministic bounded ranges', () => {
	const documents = ['a: [1, {b: \'😀\'}]\nlast: true', 'a:\n\'\'\'\'\ntext\n\'\'\'\'\nb: 2', 'a: [1 /* comment\n */ , 2]', 'a: 2026-10-11T12:00:00.123Z\nb: 1ns'];
	for (const text of documents) {
		for (let index = 0; index <= text.length; index++) {
			for (const changed of [text.slice(0, index), text.slice(0, index) + text.slice(index + 1), `${text.slice(0, index)}]}/*\n${text.slice(index)}`]) {
				const result = parseForEditor(changed);
				checkRanges(result);
				assert.deepEqual(parseForEditor(changed), result);
			}
		}
	}
});

test('invalid bare keys stay error regions instead of publishing partial decoded keys', () => {
	for (const key of ['a.b', 'a💀b', 'a\rb', '???']) {
		const {members} = object(`${key}: 1\nnext: true`);
		assert.equal(members.length, 2);
		assert.equal(members[0]?.type, 'EditorMember');
		if (members[0]?.type === 'EditorMember') {
			assert.equal(members[0].key.type, 'EditorError');
		}
	}
});

test('editor parsing is available without Temporal', async () => {
	const {execFileSync} = await import('node:child_process');
	const moduleUrl = new URL('../source/index.ts', import.meta.url).href;
	const script = String.raw`globalThis.Temporal = undefined;
const {parseForEditor} = await import(${JSON.stringify(moduleUrl)});
const result = parseForEditor('a: 2026-01-01T00:00:00.123456789Z\nb: 1ns\nc:');
if (result.root.children[0].members.length !== 3 || result.diagnostics.length === 0) {
	throw new Error('Incorrect editor result without Temporal');
}`;
	execFileSync(process.execPath, ['--input-type=module', '-e', script]);
});

test('missing values do not invent missing separators at the next member', () => {
	for (const text of ['a:\nb: true', 'a: # missing\nb: true', '{a:\nb: true}', 'a:\n\'b\': true', 'a:\n404: true']) {
		const result = parseForEditor(text);
		assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'expected-value'));
		assert.ok(result.diagnostics.every(diagnostic => diagnostic.code !== 'expected-separator'), text);
		assert.equal(object(text).members.length, 2);
	}
});

test('missing values do not hide real comma and separator errors', () => {
	assert.ok(parseForEditor('a:\nb: true c: false').diagnostics.some(diagnostic => diagnostic.code === 'expected-separator'));
	assert.ok(parseForEditor('a:, b: true').diagnostics.some(diagnostic => diagnostic.code === 'expected-separator'));
	assert.ok(parseForEditor('{a:, b: true}').diagnostics.every(diagnostic => diagnostic.code !== 'unexpected-token'));
});

test('literal string scanning preserves delimiters and does not interpret escapes', () => {
	for (const value of [String.raw`dollar $5\n and slash \\`, '😀'.repeat(50_000)]) {
		const literal = `'${value}'`;
		const text = `first: ${literal}\nnext: true`;
		const result = parseForEditor(text);
		assert.deepEqual(result.diagnostics, []);
		assert.deepEqual(result.tokens.filter(token => token.kind === 'string').map(token => text.slice(...token.range)), [literal]);
		assert.equal(object(text).members.length, 2);
	}
});

test('literal string recovery stops at a line break or EOF', () => {
	for (const suffix of ['', '\nnext: true']) {
		const text = `first: 'unfinished${suffix}`;
		const result = parseForEditor(text);
		const token = result.tokens.find(token => token.kind === 'string');
		assert.deepEqual(token?.range, [7, 18]);
		assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'invalid-value'));
		assert.equal(object(text).members.length, suffix === '' ? 1 : 2);
	}

	const result = parseForEditor('first: \'invalid\rtext\'\nnext: true');
	assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'invalid-value'));
	assert.equal(object(result.text).members.length, 2);
});
