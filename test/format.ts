import {test, suite} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
	format,
	formatEdits,
	parse,
	parseTree,
	stringify,
	visitorKeys,
	ParseError,
	type Node,
} from '../source/index.ts';
import {createRandom, type Random} from './helpers.ts';

const root = path.join(import.meta.dirname, 'conformance', 'valid');

const files = fs.readdirSync(root, {recursive: true, encoding: 'utf8'})
	.filter(file => file.endsWith('.soml') && !/\.(?:canonical|formatted)\.soml$/v.test(file))
	.toSorted();

// Canonical form is unique for a value, so it compares values, including instants and durations.
const canonical = (text: string): string => stringify(parse(text), {canonical: true});

// The formatter removes trailing whitespace in a comment and collapses runs of blank lines in a block comment, so those do not count as a change.
// eslint-disable-next-line regexp/no-super-linear-move -- Only the trusted conformance suite goes through this.
const commentTexts = (text: string): string[] => parseTree(text).comments.map(comment => comment.value.replaceAll(/[\t ]+$/gmv, '').replaceAll(/\n{3,}/gv, '\n\n'));

/*
A document as its tokens and comments, and the whitespace around them: `gaps[0]` comes before the first item, and `gaps[index + 1]` after `items[index]`. Nothing may be written in a fixed gap, which is inside a key or between a key and its `:`.
*/
type Layout = {
	items: Array<{type: string; text: string}>;
	gaps: string[];
	fixedGaps: Set<number>;
};

function keyRanges(node: Node): Array<readonly [number, number]> {
	if (node.type === 'Key') {
		return [node.range];
	}

	return visitorKeys[node.type].flatMap(key => {
		const child = (node as unknown as Record<string, Node | Node[]>)[key]!;
		return (Array.isArray(child) ? child : [child]).flatMap(item => keyRanges(item));
	});
}

function splitLayout(text: string): Layout {
	const tree = parseTree(text);
	const keys = keyRanges(tree);
	const items = [...tree.tokens, ...tree.comments].toSorted((first, second) => first.range[0] - second.range[0]);
	const gaps: string[] = [];
	const fixedGaps = new Set<number>();

	for (const [index, item] of items.entries()) {
		const gapStart = items[index - 1]?.range[1] ?? 0;
		gaps.push(text.slice(gapStart, item.range[0]));

		if (keys.some(([keyStart, keyEnd]) => gapStart > keyStart && gapStart <= keyEnd)) {
			fixedGaps.add(index);
		}
	}

	gaps.push(text.slice(items.at(-1)!.range[1]));

	return {
		items: items.map(item => ({type: item.type, text: text.slice(...item.range)})),
		gaps,
		fixedGaps,
	};
}

function joinLayout({items, gaps}: Layout): string {
	return gaps[0]! + items.map((item, index) => item.text + gaps[index + 1]!).join('');
}

/*
The same document with other spaces and tabs between its tokens and comments. Line breaks are kept.
*/
function changeSpacing(layout: Layout, random: Random): string {
	return joinLayout({
		...layout,
		gaps: layout.gaps.map((gap, index) => layout.fixedGaps.has(index) ? gap : gap.split('\n').map(() => random.pick(['', '', ' ', '\t', ' \t '])).join('\n')),
	});
}

/*
The same value with comments and line breaks added between tokens, and the trailing comma toggled in some brackets.
*/
function changeLayout(layout: Layout, random: Random): string {
	const items = layout.items.map(item => ({...item}));
	const gaps = layout.gaps.map((gap, index) => {
		if (layout.fixedGaps.has(index) || random.next() < 0.6) {
			return gap;
		}

		// A comma must be on the line of the item before it, so no line break outside a comment goes before one, even with comments between them.
		const isBeforeComma = items.slice(index).find(item => item.type !== 'Block')?.text === ',';
		const sameLine = [' ', `/* added ${index} */`, `/* added ${index}\n */`];
		const addition = random.pick(isBeforeComma ? sameLine : [...sameLine, '\n', '\n\n', `# added ${index}\n`]);

		// Text directly after a line comment would be part of it, so the addition goes on the next line.
		return items[index - 1]?.type === 'Line' ? `${gap}\n${addition}` : `${addition}${gap}`;
	});

	for (const [index, item] of items.entries()) {
		if (item.type !== 'Punctuator' || (item.text !== ']' && item.text !== '}') || random.boolean()) {
			continue;
		}

		const last = items.findLast((candidate, candidateIndex) => candidateIndex < index && candidate.type !== 'Line' && candidate.type !== 'Block')!;

		if (last.text === ',') {
			last.text = '';
		} else if (last.text !== '[' && last.text !== '{') {
			last.text += ',';
		}
	}

	return joinLayout({...layout, items, gaps});
}

/*
Checks that the edits of `text` give `formatted`, and that each one is sorted, apart from the others, and a real change.
*/
function assertEdits(text: string, formatted: string): void {
	const edits = formatEdits(text);
	let output = '';
	let previousEnd = 0;

	for (const edit of edits) {
		const [start, end] = edit.range;
		const replacement = edit.text;

		assert.ok(start >= previousEnd, `The edits overlap or are out of order, for ${JSON.stringify(text)}`);
		assert.notEqual(text.slice(start, end), replacement, `An edit changes nothing, for ${JSON.stringify(text)}`);
		output += text.slice(previousEnd, start) + replacement;
		previousEnd = end;
	}

	assert.equal(output + text.slice(previousEnd), formatted, `The edits do not give the formatted text, for ${JSON.stringify(text)}`);
	assert.deepEqual(formatEdits(formatted), [], 'A formatted document has edits.');
}

suite('conformance', () => {
	for (const [index, file] of files.entries()) {
		test(file, () => {
			const text = fs.readFileSync(path.join(root, file), 'utf8');
			const formatted = format(text);

			assert.equal(canonical(formatted), canonical(text), 'The value changed.');
			assert.equal(format(formatted), formatted, 'Formatting again changed the text.');
			assert.deepEqual(commentTexts(formatted), commentTexts(text), 'A comment changed.');

			// Canonical form is already formatted.
			const canonicalText = fs.readFileSync(path.join(root, file.replace(/\.soml$/v, '.canonical.soml')), 'utf8');
			assert.equal(format(canonicalText), canonicalText);
			assertEdits(text, formatted);

			const layout = splitLayout(text);
			const random = createRandom(index);

			for (let round = 0; round < 3; round++) {
				const respaced = changeSpacing(layout, random);
				assert.equal(format(respaced), formatted, `Spaces and tabs between tokens changed the output, for ${JSON.stringify(respaced)}`);

				const changed = changeLayout(layout, random);
				const changedFormatted = format(changed);
				assertEdits(changed, changedFormatted);
				assert.equal(canonical(changedFormatted), canonical(text), `The value changed, for ${JSON.stringify(changed)}`);
				assert.equal(format(changedFormatted), changedFormatted, `Formatting again changed the text, for ${JSON.stringify(changed)}`);
				assert.deepEqual(commentTexts(changedFormatted), commentTexts(changed), `A comment changed, for ${JSON.stringify(changed)}`);
			}
		});
	}
});

/*
Each case is the input and the expected output, with `→` for a tab to keep the layout readable.
*/
function assertFormat(input: string, expected: string): void {
	const formatted = format(input);
	assert.equal(formatted.replaceAll('\t', '→'), expected);
	assert.equal(canonical(formatted), canonical(input));
	assert.equal(format(formatted), formatted);
}

suite('format', () => {
	test('only takes a string', () => {
		assert.throws(() => format(1 as unknown as string), {name: 'TypeError', message: 'Expected a string, got number'});
	});

	test('one tab per level, and every member and item of a container that spans lines on its own line', () => {
		assertFormat('a: {b: 1, c: [1,\n2], d: {}, e: [\n]}', 'a: {\n→b: 1\n→c: [\n→→1\n→→2\n→]\n→d: {}\n→e: []\n}\n');
	});

	test('a container on one line stays on one line', () => {
		assertFormat('a: {b: 1,  c: [1,2,], d: {}}', 'a: {b: 1, c: [1, 2], d: {}}\n');
		assertFormat('m: [\n[1,0], [0, 1]\n]', 'm: [\n→[1, 0]\n→[0, 1]\n]\n');
		assertFormat('a: [[ /* x */ ], 1]', 'a: [[/* x */], 1]\n');
	});

	test('a braced document stays braced, and a top-level array is indented', () => {
		assertFormat('{a: 1}', '{a: 1}\n');
		assertFormat('{\na: 1}', '{\n→a: 1\n}\n');
		assertFormat('[1,\n[2]]', '[\n→1\n→[2]\n]\n');
	});

	test('one space after the colon', () => {
		assertFormat('a:1\nb:    2', 'a: 1\nb: 2\n');
	});

	test('a value on the line after its key moves up', () => {
		assertFormat('a:\n\t1', 'a: 1\n');
	});

	test('spelling is kept', () => {
		assertFormat('\'b c\': [0xFF, 1_000, 90m, "x", \'y\', 2026-09-19T16:00:00+02:00]', '\'b c\': [0xFF, 1_000, 90m, "x", \'y\', 2026-09-19T16:00:00+02:00]\n');
	});

	test('trailing whitespace is removed, and runs of blank lines become one', () => {
		assertFormat('\n\n# Header   \n\n\n\na: 1  \n\n\n\nb: 2\n\n\n', '# Header\n\na: 1\n\nb: 2\n');
	});

	test('no blank line directly inside brackets', () => {
		assertFormat('a: [\n\n1,\n\n2,\n\n]', 'a: [\n→1\n\n→2\n]\n');
		assertFormat('a: {\n\nb: 1\n\n}', 'a: {\n→b: 1\n}\n');
		assertFormat('[\n\n# c\n1]', '[\n→# c\n→1\n]\n');
	});

	test('a comma at the start of a line is an error', () => {
		assert.throws(() => format('[1\n,\n2]'), {name: 'ParseError'});
		assert.throws(() => format('{a: 1\n, b: 2}'), {name: 'ParseError'});
	});

	test('a comment at the end of a line stays there', () => {
		assertFormat('a: [1, # One\n2 # Two\n]', 'a: [\n→1 # One\n→2 # Two\n]\n');
		assertFormat('a: [1 /* One */\n]', 'a: [\n→1 /* One */\n]\n');
	});

	test('every comma in a container that spans lines is removed, and a trailing comma on one line', () => {
		assertFormat('a: [\n\t1,\n\t2,\n]\nb: {\n\tc: 1,\n\td: [3, 4,],\n}', 'a: [\n→1\n→2\n]\nb: {\n→c: 1\n→d: [3, 4]\n}\n');
		assertFormat('[1, 2\n3,\n4,]', '[\n→1\n→2\n→3\n→4\n]\n');
	});

	test('items separated by line breaks are already formatted', () => {
		assertFormat('a: [\n\t1\n\t2\n]\nb: {\n\tc: 1 # c\n\td: 2\n}', 'a: [\n→1\n→2\n]\nb: {\n→c: 1 # c\n→d: 2\n}\n');
		assertFormat('{\na: 1\nb: 2\n}', '{\n→a: 1\n→b: 2\n}\n');
	});

	test('a block comment before a value on the same line stays in front of it', () => {
		assertFormat('[1, /* x */ 2\n]', '[\n→1\n→/* x */ 2\n]\n');
		assertFormat('a: [1 /* a */, /* b */ 2\n]', 'a: [\n→1 /* a */\n→/* b */ 2\n]\n');
		assertFormat('[1, /* a */ /* b */ 2\n]', '[\n→1\n→/* a */ /* b */ 2\n]\n');
		assertFormat('[1 /* a */, /* b */ 2, /* c */]', '[1 /* a */, /* b */ 2 /* c */]\n');
		assertFormat('/* a */ /* b */ a: 1', '/* a */ /* b */ a: 1\n');
	});

	test('a comment on its own line stays on its own line', () => {
		assertFormat('a: [\n1,\n# Note\n2,\n# End\n]', 'a: [\n→1\n→# Note\n→2\n→# End\n]\n');
	});

	test('a comment after the opening bracket stays on its line', () => {
		assertFormat('a: [ # c\n1]', 'a: [ # c\n→1\n]\n');
		assertFormat('a: { # only\n}', 'a: { # only\n}\n');
		assertFormat('{#\n\n1: []}', '{ #\n→1: []\n}\n');
	});

	test('an empty collection with comments is laid out like a non-empty one', () => {
		assertFormat('a: [\n# only\n]', 'a: [\n→# only\n]\n');
	});

	test('a comment after the colon', () => {
		assertFormat('a: /* c */ 1', 'a: /* c */ 1\n');
		assertFormat('a: # c\n1', 'a: # c\n→1\n');
		assertFormat('a: # c\n{b: 1}', 'a: # c\n→{b: 1}\n');
		assertFormat('a: # c\n{\nb: 1}', 'a: # c\n→{\n→→b: 1\n→}\n');
		assertFormat('a:\n# c\n1', 'a:\n→# c\n→1\n');
	});

	test('a line break inside a block comment after the colon does not move the value', () => {
		assertFormat('a: /* x\ny */ {b: 1}', 'a: /* x\ny */ {b: 1}\n');
	});

	test('the lines of a block comment keep their indentation', () => {
		assertFormat('/* a\n   b */ key: 1', '/* a\n   b */ key: 1\n');
	});

	test('runs of blank lines in a block comment collapse to one', () => {
		assertFormat('/* a\n\n\n\n   b   \n*/\nkey: 1', '/* a\n\n   b\n*/\nkey: 1\n');
	});

	test('only spaces and tabs are trailing whitespace in a comment', () => {
		assertFormat('# x \u{A0}\t\na: 1', '# x \u{A0}\na: 1\n');
		assertFormat('a: 1 #\u{FEFF}', 'a: 1 #\u{FEFF}\n');
	});

	test('a block string begins on the line after its key, and its delimiters and content line up', () => {
		assertFormat('pool: {\n    description: \'\'\'\n        one\n          two\n\n        \'\'\',\n}', 'pool: {\n→description:\n→→\'\'\'\n→→one\n→→  two\n\n→→\'\'\'\n}\n');
		assertFormat('a: [\n\'\'\'\nx\n\'\'\'\n]', 'a: [\n→\'\'\'\n→x\n→\'\'\'\n]\n');
		assertFormat('a:\n\t\'\'\'\n\tx\n\t\'\'\'', 'a:\n→\'\'\'\n→x\n→\'\'\'\n');
	});

	test('trailing whitespace in a block string is content', () => {
		assertFormat('a: \'\'\'\n\tx  \n\t\'\'\'', 'a:\n→\'\'\'\n→x  \n→\'\'\'\n');
	});

	test('a blank line between comments is kept', () => {
		assertFormat('a: [\n1,\n# One\n\n# Two\n2,\n]', 'a: [\n→1\n→# One\n\n→# Two\n→2\n]\n');
		assertFormat('# One\n\n# Two\na: 1', '# One\n\n# Two\na: 1\n');
	});

	test('a top-level array with comments', () => {
		assertFormat('# Head\n[1, # One\n2] # Tail', '# Head\n[\n→1 # One\n→2\n] # Tail\n');
	});

	test('a comment after the closing bracket stays on its line', () => {
		assertFormat('a: [1,\n2] /* t */\nb: 3', 'a: [\n→1\n→2\n] /* t */\nb: 3\n');
	});

	test('a multi-line block comment inside an array', () => {
		assertFormat('a: [1,\n/* one\n  two */\n2]', 'a: [\n→1\n→/* one\n  two */\n→2\n]\n');
	});

	test('a block string after a comment that follows the colon', () => {
		assertFormat('a: # c\n\t\'\'\'\n\tx\n\t\'\'\'', 'a: # c\n→\'\'\'\n→x\n→\'\'\'\n');
		assertFormat('a: /* c */ \'\'\'\n\tx\n\t\'\'\'', 'a: /* c */\n→\'\'\'\n→x\n→\'\'\'\n');
	});

	test('a blank line inside a block string is left as it is', () => {
		assertFormat('a: \'\'\'\n  x\n   \n  y\n  \'\'\'', 'a:\n→\'\'\'\n→x\n   \n→y\n→\'\'\'\n');
	});

	test('an invalid document throws', () => {
		assert.throws(() => format('a: b'), ParseError);
	});
});

suite('formatEdits', () => {
	test('gives each change as a small edit', () => {
		assert.deepEqual(formatEdits('a: [1,\n2]\n'), [
			{range: [4, 4], text: '\n\t'},
			{range: [5, 7], text: '\n\t'},
			{range: [8, 8], text: '\n'},
		]);
	});

	test('removes and replaces', () => {
		assert.deepEqual(formatEdits('a: 1  \n\n\n\nb:  2'), [
			{range: [4, 8], text: ''},
			{range: [13, 14], text: ''},
			{range: [15, 15], text: '\n'},
		]);
	});

	test('a formatted document has no edits', () => {
		assert.deepEqual(formatEdits('a: [\n\t1\n]\n'), []);
	});

	test('throws like format()', () => {
		assert.throws(() => formatEdits(1 as unknown as string), {name: 'TypeError'});
		assert.throws(() => formatEdits('a: '), ParseError);
	});

	/*
	Adds spaces, tabs, line breaks, commas, and comments to the gaps between the tokens, so that the document stays valid. A comma must stay on the line of the item before it, so no line break or line comment goes before one, and a line comment ends its line.
	*/
	function mutate(text: string, random: Random): string {
		const tree = parseTree(text);
		const items = [...tree.tokens, ...tree.comments].toSorted((first, second) => first.range[0] - second.range[0]);
		const noises = [' ', '\t', '\n', '\n\n', '# c\n', '/* c */', '/* a\n b */', ','];
		const gaps = items.map((item, index) => {
			const gapStart = index === 0 ? 0 : items[index - 1]!.range[1];
			const isBeforeComma = item.type === 'Punctuator' && item.value === ',';
			const choices = isBeforeComma ? noises.filter(noise => !noise.includes('\n') || noise.startsWith('/*')) : noises;
			return random.next() < 0.4 ? `${text.slice(gapStart, item.range[0])}${random.pick(choices)}` : text.slice(gapStart, item.range[0]);
		});
		const lastEnd = items.at(-1)!.range[1];
		return [...gaps, text.slice(lastEnd)].join('');
	}

	test('every edit changes only layout characters and is as small as possible', () => {
		const random = createRandom(9);
		const isLayout = (code: number): boolean => [32, 9, 10, 44].includes(code); // Space, tab, LF, comma

		for (let round = 0; round < 300; round++) {
			const original = fs.readFileSync(path.join(root, random.pick(files)), 'utf8');
			const text = mutate(original, random);
			let formatted: string;

			try {
				formatted = format(text);
			} catch {
				continue;
			}

			const edits = formatEdits(text);
			let output = '';
			let previousEnd = 0;

			for (const edit of edits) {
				const [start, end] = edit.range;
				assert.ok(start >= previousEnd, 'The edits overlap or are out of order.');
				assert.ok(start < end || edit.text.length > 0, 'An edit that changes nothing.');
				assert.notEqual(text.slice(start, end), edit.text, 'An edit that changes nothing.');

				// The formatter changes only the layout, so an edit must replace layout with layout.
				for (let index = start; index < end; index++) {
					assert.ok(isLayout(text.charCodeAt(index)), `A non-layout character was removed:\n${text.slice(start, end)}`);
				}

				for (let index = 0; index < edit.text.length; index++) {
					assert.ok(isLayout(edit.text.charCodeAt(index)), 'A non-layout character was added.');
				}

				// As small as possible: the characters at its ends stay the same, so the range does not share one.
				assert.ok(start === 0 || text.charCodeAt(start) !== edit.text.charCodeAt(0), 'The edit shares its first character.');
				assert.ok(end === text.length || text.charCodeAt(end - 1) !== edit.text.charCodeAt(edit.text.length - 1), 'The edit shares its last character.');

				output += text.slice(previousEnd, start) + edit.text;
				previousEnd = end;
			}

			assert.equal(output + text.slice(previousEnd), formatted);
			assert.deepEqual(formatEdits(formatted), []);
		}
	});
});
