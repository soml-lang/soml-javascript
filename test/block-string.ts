import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import process from 'node:process';
import {formatBlockString, formatString, parseTree} from '../source/index.ts';

test('block strings with many internal blank lines serialize within a bounded memory budget', () => {
	const sourceUrl = new URL('../source/index.ts', import.meta.url).href;
	const result = spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '--eval', String.raw`
		import assert from 'node:assert/strict';
		import {formatBlockString, formatString} from ${JSON.stringify(sourceUrl)};
		const count = 14_000_000;
		const value = 'x' + '\n'.repeat(count) + 'x';
		assert.equal(formatString(value), '"x' + '\\n'.repeat(count) + 'x"');
		assert.equal(formatBlockString(value), "'''\n" + value + "\n'''");
	`], {encoding: 'utf8'});
	assert.equal(result.status, 0, result.stderr);
});

test('literal blocks do not allocate an unused escaped representation', () => {
	const sourceUrl = new URL('../source/index.ts', import.meta.url).href;
	const result = spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '--eval', String.raw`
		import assert from 'node:assert/strict';
		import {formatBlockString, formatString} from ${JSON.stringify(sourceUrl)};
		const value = 'x' + '\n'.repeat(39_000_000) + 'x';
		const expected = "'''\n" + value + "\n'''";
		assert.equal(expected.length, 39_000_010);
		assert.equal(expected.at(-1), "'");
		assert.equal(formatBlockString(value), expected);
		assert.equal(formatString(value, {style: 'block'}), expected);
	`], {encoding: 'utf8'});
	assert.equal(result.status, 0, result.stderr);
});

const values = ['', 'hello', 'hello\nworld', '\n', '\n\n', '\nhello', 'hello\n', '\nhello\n', ' ', ' \t ', 'hello\n \t\nworld', 'hello\n\nworld', '  hello\n\tworld  ', '\'\'\'', '\t\'\'\'\' trailing', 'before\n\'\'\'\nafter', '"""', String.raw`C:\path\n`, '\u{0}\u{7}\u{7F}', '😀\u{2028}\u{2029}', 'first\n\n\nlast'];
for (const value of values) {
	test(`block string preserves ${JSON.stringify(value)}`, () => {
		const block = formatBlockString(value);
		for (const indent of ['', '\t', '  ', ' \t']) {
			const nested = block.replaceAll('\n', () => `\n${indent}`);
			const document = parseTree(`{value: ${nested}, next: true}`);
			assert.equal(document.body.type, 'Object');
			const node = document.body.members[0]!.value;
			assert.equal(node.type, 'String');
			assert.equal(node.block, true);
			assert.equal(node.value, value);
			const single = parseTree(`value: ${formatString(node.value)}`);
			assert.equal(single.body.type, 'Object');
			assert.equal(single.body.members[0]!.value.type, 'String');
			assert.equal(single.body.members[0]!.value.value, value);
		}
	});
}

test('literal block delimiter cannot collide with leading quote runs', () => {
	for (let length = 3; length <= 30; length++) {
		const value = `before\n \t${'\''.repeat(length)} suffix\nafter`;
		assert.equal(formatBlockString(value).split('\n', 1)[0], '\''.repeat(length + 1));
	}
});

test('all representable ASCII characters round-trip individually and in multiline combinations', () => {
	for (let code = 0; code < 128; code++) {
		if (code === 13) {
			continue;
		}

		const character = String.fromCodePoint(code);
		for (const value of [character, `a\n${character}\nb`, `${character}\nx\n${character}`]) {
			const tree = parseTree(`[${formatBlockString(value)}]`);
			assert.equal(tree.body.type, 'Array');
			assert.equal(tree.body.elements[0]!.type, 'String');
			assert.equal(tree.body.elements[0]!.value, value);
		}
	}
});

test('forbidden carriage returns and lone surrogates are rejected', () => {
	for (const value of ['\r', 'x\r\ny', '\u{D800}', '\u{DC00}']) {
		assert.throws(() => formatBlockString(value), TypeError);
	}
});
