import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	applyEdits,
	edit,
	editEdits,
	format,
	formatString,
	parseTree,
	getNodeAtPath,
	type PathSegment,
	type StringStyle,
} from '../source/index.ts';

for (const style of ['auto', 'escaped', 'block'] as const) {
	for (const value of ['', 'hello', '😀', 'a\nb', '\nhello\n', ' \t ', 'it\'s', '"""', 'before\n\'\'\'\nafter', String.raw`C:\path`, '\u{0}\u{7F}', 'first\n \t\nlast']) {
		test(`${style} strings and edits preserve ${JSON.stringify(value)}`, () => {
			const formatted = formatString(value, {style});
			const node = getNodeAtPath(parseTree(`value: ${formatted}`), ['value']);
			assert.strictEqual(node?.type, 'String');
			assert.equal(node.value, value);
			const text = 'before: \'😀\'\nvalue: null # keep\nafter: 0xFF';
			const changed = applyEdits(text, editEdits(text, ['value'], value, {stringStyle: style}));
			assert.equal(changed, edit(text, ['value'], value, {stringStyle: style}));
			const edited = getNodeAtPath(parseTree(changed), ['value']);
			assert.strictEqual(edited?.type, 'String');
			assert.equal(edited.value, value);
			assert.ok(changed.startsWith('before: \'😀\'\nvalue:'));
			assert.ok(changed.endsWith(' # keep\nafter: 0xFF'));
			// The style is used, and not only the value kept.
			assert.equal(node.block, style === 'block');
			assert.equal(edited.block, style === 'block');
			if (style !== 'escaped') {
				return;
			}

			assert.equal(node.style, 'escaped');
			assert.equal(edited.style, 'escaped');
		});
	}
}

test('literal style allows tabs and rejects only unrepresentable literal content', () => {
	assert.equal(formatString('a\tb', {style: 'literal'}), '\'a\tb\'');
	for (const value of ['it\'s', 'a\nb', '\u{0}', '\u{7F}']) {
		assert.throws(() => formatString(value, {style: 'literal'}), TypeError);
		assert.throws(() => edit('a: 1', ['a'], value, {stringStyle: 'literal'}), TypeError);
	}
});

test('string styles validate options and do not inherit them', () => {
	for (const style of ['auto', 'literal', 'escaped', 'block'] as const) {
		for (const value of ['\r', '\u{D800}', '\u{DC00}']) {
			assert.throws(() => formatString(value, {style}), TypeError);
		}
	}

	assert.equal(formatString('value', Object.create({style: 'escaped'}) as {style: StringStyle}), '\'value\'');
	assert.equal(edit('a: 1', ['a'], 'value', Object.create({stringStyle: 'block'}) as {stringStyle: StringStyle}), 'a: \'value\'');
	// @ts-expect-error Invalid string style.
	assert.throws(() => formatString('value', {style: 'invalid'}), TypeError);
	// @ts-expect-error Invalid options.
	assert.throws(() => formatString('value', null), TypeError);
	// @ts-expect-error Invalid string input.
	assert.throws(() => formatString(1), TypeError);
	assert.throws(() => edit('a: 1', ['a'], 2n, {stringStyle: 'block'}), TypeError);
	assert.throws(() => edit('a: 1', ['a'], undefined, {stringStyle: 'escaped'}), TypeError);
	assert.throws(() => edit('a: 1', ['a'], 'x', {stringStyle: 'literal', canonical: true}), TypeError);
});

test('explicit styles apply to inserted strings inside newly created parents', () => {
	for (const style of ['literal', 'escaped', 'block'] as const) {
		for (const text of ['a: 1', 'a: {old: 1}', 'a: {}']) {
			const path = text.startsWith('a: {') ? ['a', 'b', 'c'] : ['b', 'c'];
			const changed = edit(text, path, 'hello', {stringStyle: style});
			const node = getNodeAtPath(parseTree(changed), path);
			assert.strictEqual(node?.type, 'String');
			assert.equal(node.value, 'hello');
			assert.equal(node.block, style === 'block');
			assert.equal(node.style, style === 'escaped' ? 'escaped' : 'literal');
		}
	}
});

test('block strings can be inserted into arrays and preserve surrounding values', () => {
	for (const text of ['[]', '[1]', '[1,]', '[1 # keep\n]', '[/* keep */]']) {
		const tree = parseTree(text);
		assert.strictEqual(tree.body.type, 'Array');
		const changed = edit(text, [tree.body.elements.length], 'hello\nworld', {stringStyle: 'block'});
		const node = getNodeAtPath(parseTree(changed), [tree.body.elements.length]);
		assert.strictEqual(node?.type, 'String');
		assert.equal(node.value, 'hello\nworld');
		assert.equal(node.block, true);
	}
});

test('block replacement preserves comments and moves single-line replacements beside their keys', () => {
	for (const prefix of ['value: ', 'value: # before\n\t', 'value: /* before */ ']) {
		const text = `${prefix}'hello' # after`;
		const block = edit(text, ['value'], 'hello\nworld', {stringStyle: 'block'});
		assert.equal(parseTree(block).comments.length, parseTree(text).comments.length);
		const escaped = edit(block, ['value'], 'hello', {stringStyle: 'escaped'});
		const node = getNodeAtPath(parseTree(escaped), ['value']);
		assert.strictEqual(node?.type, 'String');
		assert.equal(node.value, 'hello');
		assert.equal(node.block, false);
	}

	assert.equal(edit('value:\n\t\'\'\'\n\thello\n\t\'\'\'', ['value'], 'world', {stringStyle: 'escaped'}), 'value: "world"');
});

test('literal style rejects every control character but tab', () => {
	for (let code = 0; code < 0x80; code++) {
		// A carriage return cannot be written in any style.
		if (code === 0x0D) {
			continue;
		}

		const character = String.fromCodePoint(code);
		if (code === 0x09 || (code !== 0x27 && code !== 0x7F && code >= 0x20)) {
			assert.equal(formatString(character, {style: 'literal'}), `'${character}'`);
		} else {
			assert.throws(() => formatString(character, {style: 'literal'}), TypeError, `U+${code.toString(16)}`);
		}
	}
});

test('auto style still allows any value and canonical: true', () => {
	assert.equal(edit('a: 1', ['a'], 2n, {stringStyle: 'auto', canonical: true}), 'a: 2');
});

test('a block replacement goes below its key, one level deeper, and keeps a formatted document formatted', () => {
	const cases: Array<[string, PathSegment[], string]> = [
		['value: \'x\' # keep\n', ['value'], 'value:\n\t\'\'\'\n\thello\n\tworld\n\t\'\'\' # keep\n'],
		['a: {\n\tb: \'x\'\n}\n', ['a', 'b'], 'a: {\n\tb:\n\t\t\'\'\'\n\t\thello\n\t\tworld\n\t\t\'\'\'\n}\n'],
		['items: [\n\t\'x\'\n]\n', ['items', 0], 'items: [\n\t\'\'\'\n\thello\n\tworld\n\t\'\'\'\n]\n'],
		['value:\n\t\'\'\'\n\told\n\t\'\'\'\n', ['value'], 'value:\n\t\'\'\'\n\thello\n\tworld\n\t\'\'\'\n'],
	];

	for (const [text, pathSegments, expected] of cases) {
		const changed = edit(text, pathSegments, 'hello\nworld', {stringStyle: 'block'});
		assert.equal(changed, expected);
		assert.equal(format(changed), changed);
	}
});

test('a block replacement inside a one-line container moves to its own line', () => {
	assert.equal(edit('a: {b: \'x\'}\n', ['a', 'b'], 'hello', {stringStyle: 'block'}), 'a: {b:\n\t\'\'\'\n\thello\n\t\'\'\'}\n');
	assert.equal(edit('items: [1, \'x\', 3]\n', ['items', 1], 'hello', {stringStyle: 'block'}), 'items: [1,\n\t\'\'\'\n\thello\n\t\'\'\', 3]\n');
});

test('a block string in a new member or a new parent goes below its key', () => {
	assert.equal(edit('a: 1\n', ['b'], 'hello\nworld', {stringStyle: 'block'}), 'a: 1\nb:\n\t\'\'\'\n\thello\n\tworld\n\t\'\'\'\n');
	assert.equal(edit('a: 1\n', ['b', 'c'], 'hello\nworld', {stringStyle: 'block'}), 'a: 1\nb: {\n\tc:\n\t\t\'\'\'\n\t\thello\n\t\tworld\n\t\t\'\'\'\n}\n');
});

test('a block string in an empty one-line container takes the indentation of its line', () => {
	assert.equal(edit('x: {\n\ta: [/* c */]\n}\n', ['x', 'a', 0], 'v\nw', {stringStyle: 'block'}), 'x: {\n\ta: [/* c */ \'\'\'\n\tv\n\tw\n\t\'\'\']\n}\n');
	assert.equal(edit('x: {\n\tb: {/* c */}\n}\n', ['x', 'b', 'k'], 'v\nw', {stringStyle: 'block'}), 'x: {\n\tb: {/* c */ k:\n\t\t\'\'\'\n\t\tv\n\t\tw\n\t\t\'\'\'}\n}\n');
});

test('literal and escaped styles apply to replacements', () => {
	assert.equal(edit('value: null # keep\n', ['value'], 'hello', {stringStyle: 'escaped'}), 'value: "hello" # keep\n');
	assert.equal(edit('value: "hello"\n', ['value'], 'hello', {stringStyle: 'literal'}), 'value: \'hello\'\n');
});
