import {test, suite} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parse, ParseError} from '../source/index.ts';
import {createRandom} from './helpers.ts';

const BIDI_CONTROLS = ['\u{61C}', '\u{200E}', '\u{200F}', '\u{202A}', '\u{202B}', '\u{202C}', '\u{202D}', '\u{202E}', '\u{2066}', '\u{2067}', '\u{2068}', '\u{2069}'];

function catchParseError(input: string | Uint8Array): ParseError {
	let parseError: ParseError | undefined;

	assert.throws(() => parse(input), (error: unknown) => {
		assert.ok(error instanceof ParseError, `expected a ParseError, got ${String(error)}`);
		parseError = error;
		return true;
	}, `expected ${JSON.stringify(input)} to be rejected`);

	return parseError!;
}

suite('ParseError', () => {
	test('is a SyntaxError and an Error', () => {
		const error = catchParseError('');
		assert.ok(error instanceof SyntaxError);
		assert.ok(error instanceof Error);
		assert.equal(error.name, 'ParseError');
	});

	test('has the reason, the position, and a code frame', () => {
		const error = catchParseError('a: 1\nb: nope\n');
		assert.equal(error.reason, 'Unexpected “nope”. A string value must be quoted, as in \'nope\'');
		assert.equal(error.line, 2);
		assert.equal(error.column, 4);
		assert.equal(error.offset, 8);
		assert.equal(error.codeFrame, '  1 | a: 1\n> 2 | b: nope\n    |    ^');
	});

	test('the message is the reason, the position, and the code frame', () => {
		const error = catchParseError('a: 1\nb: nope\n');
		assert.equal(error.message, `${error.reason} at line 2, column 4\n\n${error.codeFrame}`);
	});

	test('terminal and bidirectional controls in duplicate keys are sanitized in the reason and message', () => {
		for (const character of ['\u{9B}', ...BIDI_CONTROLS]) {
			const key = String.raw`\u{${character.codePointAt(0)!.toString(16)}}admin`;
			const error = catchParseError(`"${key}": 1\n"${key}": 2`);
			assert.equal(error.reason, 'Duplicate key "\u{FFFD}admin"');
			assert.equal(error.message, `${error.reason} at line 2, column 1\n\n${error.codeFrame}`);
			assert.ok(!error.message.includes(character));
		}
	});

	test('terminal and bidirectional controls in unknown escapes are sanitized in the reason and message', () => {
		for (const character of ['\u{9B}', ...BIDI_CONTROLS]) {
			const error = catchParseError(`a: "\\${character}"`);
			assert.ok(error.reason.startsWith('Unknown escape “\\\u{FFFD}”'));
			assert.equal(error.message, `${error.reason} at line 1, column 5\n\n${error.codeFrame}`);
			assert.ok(!error.message.includes(character));
		}
	});

	test('the stack starts with the name and message', () => {
		const error = catchParseError('a: nope');
		assert.ok(error.stack!.startsWith('ParseError: Unexpected “nope”'));
	});

	test('can be caught as a SyntaxError next to JSON.parse errors', () => {
		for (const run of [() => JSON.parse('{') as unknown, () => parse('{')]) {
			assert.throws(run, SyntaxError);
		}
	});
});

suite('positions', () => {
	test('line and column are 1-based', () => {
		const error = catchParseError('}');
		assert.equal(error.line, 1);
		assert.equal(error.column, 1);
		assert.equal(error.offset, 0);
	});

	test('a column counts code points, so an emoji is one column', () => {
		const error = catchParseError('a: \'😀😀\' x');
		assert.equal(error.column, 9);
		assert.equal(error.offset, 10);
	});

	test('a tab is one column', () => {
		const error = catchParseError('\t\ta: nope');
		assert.equal(error.column, 6);
	});

	test('an error on a later line', () => {
		const error = catchParseError('a: 1\n\n\n# c\nb: 2\nc: nope');
		assert.equal(error.line, 6);
		assert.equal(error.column, 4);
	});

	test('an error at the end of the document points past the last character', () => {
		const error = catchParseError('a:');
		assert.equal(error.reason, 'Expected a value, but reached the end of the document');
		assert.equal(error.column, 3);
		assert.equal(error.offset, 2);
	});

	test('an unterminated container points at its opening', () => {
		const error = catchParseError('a: [1, 2');
		assert.equal(error.reason, 'Unterminated array: expected “]”');
		assert.equal(error.line, 1);
		assert.equal(error.column, 4);
	});

	test('an error right after a line break is on the next line', () => {
		const error = catchParseError('a: 1\n}');
		assert.equal(error.line, 2);
		assert.equal(error.column, 1);
	});

	test('an error on a line break character is on the line it ends', () => {
		const error = catchParseError('{a\n: 1}');
		assert.equal(error.offset, 2);
		assert.equal(error.line, 1);
		assert.equal(error.column, 3);
	});

	test('an unterminated string points at its opening quote', () => {
		const error = catchParseError('a: \'x\n');
		assert.equal(error.line, 1);
		assert.equal(error.column, 4);
	});

	test('the position of a duplicate key is the second key', () => {
		const error = catchParseError('{\n\ta: 1,\n\ta: 2,\n}');
		assert.equal(error.line, 3);
		assert.equal(error.column, 2);
	});

	test('an unterminated block comment points at its opening', () => {
		const error = catchParseError('a: 1\n\n  /* x\n\n');
		assert.equal(error.line, 3);
		assert.equal(error.column, 3);
	});

	test('a dot in a key points at the dot', () => {
		for (const [source, line, column] of [
			['a.b: 1', 1, 2],
			['example.com: 1', 1, 8],
			['3.14: \'x\'', 1, 2],
			['\'a\'.b: 1', 1, 4],
			['a.\'b\': 1', 1, 2],
			['{a.b: 1}', 1, 3],
			['x: {a.b: 1}', 1, 6],
			['[{a.b: 1}]', 1, 4],
			['a: 1\n\tb.c: 2', 2, 3],
			['.a: 1', 1, 1],
		] as const) {
			const error = catchParseError(source);
			assert.deepEqual({line: error.line, column: error.column}, {line, column}, source);
		}
	});

	test('a position after astral characters on earlier lines', () => {
		const error = catchParseError('a: \'😀😀😀\'\nb: nope');
		assert.equal(error.line, 2);
		assert.equal(error.column, 4);
	});
});

suite('code frame', () => {
	test('shows up to two lines before the error', () => {
		const error = catchParseError('a: 1\nb: 2\nc: 3\nd: nope');
		assert.equal(error.codeFrame, '  2 | b: 2\n  3 | c: 3\n> 4 | d: nope\n    |    ^');
	});

	test('aligns the gutter for multi-digit line numbers', () => {
		const source = `${Array.from({length: 9}, (_, index) => `k${index}: ${index}`).join('\n')}\nk9: nope`;
		assert.equal(catchParseError(source).codeFrame, '   8 | k7: 7\n   9 | k8: 8\n> 10 | k9: nope\n     |     ^');
	});

	test('keeps tabs before the caret so it lines up', () => {
		const error = catchParseError('a: {\n\t\tb: nope,\n}');
		assert.equal(error.codeFrame, '  1 | a: {\n> 2 | \t\tb: nope,\n    | \t\t   ^');
	});

	test('an empty line is shown without trailing whitespace', () => {
		const error = catchParseError('a: 1\n\nb: nope');
		assert.equal(error.codeFrame, '  1 | a: 1\n  2 |\n> 3 | b: nope\n    |    ^');
	});

	test('an empty document', () => {
		assert.equal(catchParseError('').codeFrame, '> 1 |\n    | ^');
	});

	test('a long line is clipped around the error', () => {
		const error = catchParseError(`a: [${'1, '.repeat(200)}nope, ${'1, '.repeat(200)}]`);
		const [line, pointer] = error.codeFrame.split('\n', 2) as [string, string];
		assert.ok(line.length < 120);
		assert.ok(line.startsWith('> 1 | …'));
		assert.ok(line.endsWith('…'));
		assert.equal(line.indexOf('nope'), pointer.indexOf('^'));
	});

	test('a long line clipped at its start keeps the pointer right', () => {
		const error = catchParseError(`a: nope ${'x'.repeat(300)}`);
		const [line, pointer] = error.codeFrame.split('\n', 2) as [string, string];
		assert.ok(!line.startsWith('> 1 | …'));
		assert.equal(line.indexOf('nope'), pointer.indexOf('^'));
	});

	test('a long line clipped at its end keeps the pointer right', () => {
		const error = catchParseError(`a: '${'x'.repeat(300)}' nope`);
		const [line, pointer] = error.codeFrame.split('\n', 2) as [string, string];
		assert.ok(line.endsWith('nope'));
		assert.equal(line.indexOf('nope'), pointer.indexOf('^'));
	});

	test('a long context line is clipped too', () => {
		const error = catchParseError(`a: '${'x'.repeat(300)}'\nb: nope`);
		assert.ok(error.codeFrame.split('\n', 1)[0]!.length < 120);
	});

	test('clipping a long line never splits a surrogate pair', () => {
		// One more character before the error moves the start of the clipped window to the other half of a pair. The end of the window always falls inside a pair.
		for (let padding = 0; padding < 2; padding++) {
			const error = catchParseError(`a: '${'😀'.repeat(40)}${'x'.repeat(padding)}' nope ${'😀'.repeat(100)}`);
			assert.ok(error.codeFrame.isWellFormed(), `padding ${padding}`);
		}
	});

	test('a long number with a leading zero is cut short in the reason', () => {
		// An octal number that long is outside the 64-bit range, so it is not suggested.
		assert.equal(catchParseError(`a: 0${'1'.repeat(900)}`).reason, `Leading zeros are not allowed in a decimal number. Write an identifier, such as a ZIP code, as a string: '0${'1'.repeat(39)}…'`);
		assert.equal(catchParseError(`a: 0${'9'.repeat(900)}`).reason, `Leading zeros are not allowed in a decimal number. Write an identifier, such as a ZIP code, as a string: '0${'9'.repeat(39)}…'`);
	});

	test('the surrogate range boundaries: U+10000 is D800 DC00, and U+10FFFF is DBFF DFFF', () => {
		for (const character of ['\u{10000}', '\u{10FFFF}']) {
			assert.equal(catchParseError(`a: '${character.repeat(3)}' nope`).column, 10);

			for (let padding = 0; padding < 4; padding++) {
				const error = catchParseError(`a: '${'x'.repeat(padding)}${character.repeat(40)}' nope ${character.repeat(100)}`);
				assert.ok(error.codeFrame.isWellFormed(), `padding ${padding}`);
			}

			// @ts-expect-error -- An invalid `integers` value, to get an error message that quotes it.
			assert.throws(() => parse('a: 1', {integers: `${'x'.repeat(39)}${character}`}), (error: Error) => error.message.isWellFormed());
		}
	});

	test('a quoted token is cut short without splitting a surrogate pair', () => {
		// @ts-expect-error -- An invalid `integers` value, to get an error message that quotes it.
		assert.throws(() => parse('a: 1', {integers: `${'x'.repeat(39)}😀`}), (error: Error) => error.message.isWellFormed() && error.message.includes('x…'));
	});

	test('characters a terminal would act on are replaced in the code frame, and the caret still lines up', () => {
		for (const [source, line] of [
			['a: "\u{1B}[2J"', '> 1 | a: "\u{FFFD}[2J"'],
			['a: \'x\ry\'', '> 1 | a: \'x\u{FFFD}y\''],
			['a: \u{202E}x', '> 1 | a: \u{FFFD}x'],
			[`a: '${String.fromCharCode(0xD8_00)}'`, '> 1 | a: \'\u{FFFD}\''],
		] as const) {
			const error = catchParseError(source);
			assert.equal(error.codeFrame.split('\n', 1)[0], line);
		}

		assert.equal(catchParseError('a: \'x\ry\'').codeFrame, '> 1 | a: \'x\u{FFFD}y\'\n    |      ^');
	});

	test('tabs are kept in the code frame', () => {
		assert.equal(catchParseError('\ta: nope').codeFrame, '> 1 | \ta: nope\n    | \t   ^');
	});

	test('the caret is placed by code point, as the column counts them', () => {
		// One space for each Unicode scalar value before the error, so a character outside the BMP takes one place, as `column` counts it, and as the Swift and Python ports draw it. `offset` counts UTF-16 code units, so after two of them it is 2 places further along than the number of spaces before the caret. When the terminal draws such a character two columns wide the caret looks one column left of the offending character, which is expected: the message aligns with the column, not with the terminal's rendering.
		const error = catchParseError('a: \'😀😀\' $');
		assert.equal(error.offset, 10);
		assert.equal(error.column, 9);
		assert.equal(error.codeFrame, '> 1 | a: \'😀😀\' $\n    |         ^');
	});

	test('every bidirectional control is sanitized in the code frame', () => {
		for (const character of BIDI_CONTROLS) {
			const error = catchParseError(`'${character}admin': 1\n'${character}admin': 2`);
			assert.equal(error.codeFrame, '  1 | \'\u{FFFD}admin\': 1\n> 2 | \'\u{FFFD}admin\': 2\n    | ^');
		}
	});

	test('the code frame comes from bytes the same way', () => {
		const error = catchParseError(new TextEncoder().encode('a: 1\nb: nope'));
		assert.equal(error.codeFrame, '  1 | a: 1\n> 2 | b: nope\n    |    ^');
	});
});

suite('reasons', () => {
	const cases: Array<[string, string]> = [
		['', 'A document must contain an object or an array, but this one is empty'],
		['# only a comment', 'A document must contain an object or an array, but this one is empty'],
		['5', 'A bare value is not a document. A document is an object or an array, so write it as `key: value` or `[value]`'],
		['2026-09-19T14:00:00Z', 'A bare value is not a document. A document is an object or an array, so write it as `key: value` or `[value]`'],
		['\'hello\'', 'A bare value is not a document. A document is an object or an array, so write it as `key: value` or `[value]`'],
		['true\nb: 1', 'Expected “:” after the key'],
		['2026-09-19T14:1x', 'Invalid number “1x”. A string value must be quoted, as in \'1x\''],
		['a: 1, b: 2', 'Top-level entries are separated by line breaks, not commas. Use braces for a one-line object'],
		['a: 1 b: 2', 'Expected a line break before the next entry, but found “b”'],
		['a: 512 MiB', 'A unit cannot follow a number after a space. Write a duration without the space, as in 10s, and anything else, such as a size, as a string, as in \'512 MiB\''],
		['a: 10 seconds', 'A unit cannot follow a number after a space. Write a duration without the space, as in 10s, and anything else, such as a size, as a string, as in \'10 seconds\''],
		['a: 100 ms', 'A unit cannot follow a number after a space. Write a duration without the space, as in 100ms, and anything else, such as a size, as a string, as in \'100 ms\''],
		// `m` may be meters, so the string is offered too.
		['a: 10 m', 'A unit cannot follow a number after a space. Write a duration without the space, as in 10m, and anything else, such as a size, as a string, as in \'10 m\''],
		['a: 1.5 h # note', 'A unit cannot follow a number after a space. Write a duration without the space, as in 1.5h, and anything else, such as a size, as a string, as in \'1.5 h\''],
		['a: [100 ms]', 'A unit cannot follow a number after a space. Write a duration without the space, as in 100ms, and anything else, such as a size, as a string, as in \'100 ms\''],
		['a: {b: 100 ms}', 'A unit cannot follow a number after a space. Write a duration without the space, as in 100ms, and anything else, such as a size, as a string, as in \'100 ms\''],
		['a: [1 true]', 'Expected “,”, a line break, or “]” after an array item, but found “t”'],
		['a: 5 and more', 'Expected a line break before the next entry, but found “a”'],
		['a: \'x\' MiB', 'Expected a line break before the next entry, but found “M”'],
		['// note\na: 1', 'Expected a key, but found “/”. A comment starts with “#”'],
		['a: 1 // note', 'Expected a line break before the next entry, but found “/”. A comment starts with “#”'],
		['a: [1 // note\n]', 'Expected “,”, a line break, or “]” after an array item, but found “/”. A comment starts with “#”'],
		['a: [1, // note\n2]', 'Expected a value, but found “/”. A comment starts with “#”'],
		['a: 1 / 2', 'Expected a line break before the next entry, but found “/”'],
		['key: |\n  text', 'Expected a value, but found “|”. Write a multiline string as a block string, between \'\'\' lines'],
		// A folded block scalar joins its lines, which a block string does not.
		['key: >-\n  text', 'Expected a value, but found “>”'],
		['key: | x', 'Expected a value, but found “|”'],
		['[server]\nport: 1', 'There are no table headers. Write the table as an object, as in server: {…}'],
		['[[servers]]\nport: 1', 'There are no table headers. Write the table as an object, as in servers: {…}'],
		['a: [server]', 'Unexpected “server”. A string value must be quoted, as in \'server\''],
		['name: \'x\'\n\n[server]\nport: 1', 'There are no table headers. Write the table as an object, as in server: {…}'],
		['a: 1\n[', 'Expected a key, but found “[”'],
		['{2026-09-19T14:00:00Z: 1}', 'A key that contains “:” must be quoted, as in \'2026-09-19T14:00:00Z\''],
		['12:30: \'lunch\'', 'A key that contains “:” must be quoted, as in \'12:30\''],
		['a:b: 1', 'A key that contains “:” must be quoted, as in \'a:b\''],
		['a:b', 'Unexpected “b”. A string value must be quoted, as in \'b\''],
		['a:{b: nope}', 'Unexpected “nope”. A string value must be quoted, as in \'nope\''],
		['{a: 1} x', 'Unexpected “x” after the end of the document'],
		['the name: 1', 'A bare key cannot contain spaces. Quote it, as in \'the name\''],
		['the name \t: 1', 'A bare key cannot contain spaces. Quote it, as in \'the name\''],
		// Only spaces and tabs are whitespace, so a key that ends with another space character does not get the hint.
		['the name\u{A0}: 1', 'Expected “:” after the key, but found “n”'],
		['the name\u{2028}: 1', 'Expected “:” after the key, but found “n”'],
		['the name\u{FEFF}: 1', 'Expected “:” after the key, but found “n”'],
		['a : 1', 'Whitespace is not allowed between a key and its “:”'],
		['a = 1', 'Expected “:” after the key, but found “=”'],
		['a.b c: 1', 'A key cannot contain “.” unless it is quoted. Quote the whole key, or use braces to nest, as in a: {b: …}'],
		['\'a\' b: 1', 'Expected “:” after the key, but found “b”'],
		['\'a\'b: 1', 'Expected “:” after the key, but found “b”'],
		['a/* c */: 1', 'A comment is not allowed between a key and its “:”'],
		['{a /* c */}', 'Expected “:” after the key, but found “/”'],
		['x: 1\ny/*', 'Expected “:” after the key, but found “/”'],
		['a$: 1', 'Expected “:” after the key, but found “$”. A key that contains characters other than letters, digits, “_”, and “-” must be quoted'],
		['$schema: \'x\'', 'Expected a key, but found “$”. A key that contains characters other than letters, digits, “_”, and “-” must be quoted, as in \'$schema\''],
		['a.$b: 1', 'A key cannot contain “.” unless it is quoted. Quote the whole key, or use braces to nest, as in a: {b: …}'],
		['@a b: 1', 'Expected a key, but found “@”. A key that contains characters other than letters, digits, “_”, and “-” must be quoted'],
		['\u{3164}a: 1', 'Expected a key, but found U+3164'],
		['a\u{FE0F}: 1', 'Expected “:” after the key, but found U+FE0F'],
		['a: 1\n}', 'Expected a key, but found “}”'],
		['a:\nb: 1', 'Expected a value, but found the key b'],
		['a:\n1: 2', 'Expected a value, but found the key 1'],
		['a:\n\t2026-09-19T25:00:00Z', 'Invalid instant 2026-09-19T25:00:00Z: the hour must be 00 to 23'],
		['a:\n\t12:30', 'A time of day is a string, so it must be quoted'],
		['a: 07:32:00', 'A time of day is a string, so it must be quoted'],
		['a: 12:00', 'A time of day is a string, so it must be quoted'],
		['a: 10:30 PM', 'A time of day is a string, so it must be quoted'],
		['a: 8080:80', 'Invalid number “8080:80”. A value that contains “:” must be quoted, as in \'8080:80\''],
		['color: #FFF\nsize: 1', 'Expected a value, but found the key size. “#” starts a comment, so a value that starts with “#” must be quoted, as in \'#FFF\''],
		['{color: #FFF\nsize: 1}', 'Expected a value, but found the key size. “#” starts a comment, so a value that starts with “#” must be quoted, as in \'#FFF\''],
		['color: #FFF', 'Expected a value, but reached the end of the document. “#” starts a comment, so a value that starts with “#” must be quoted, as in \'#FFF\''],
		['color: #FFF\n', 'Expected a value, but reached the end of the document. “#” starts a comment, so a value that starts with “#” must be quoted, as in \'#FFF\''],
		['{color: #FFF\n}', 'Expected a value, but found “}”. “#” starts a comment, so a value that starts with “#” must be quoted, as in \'#FFF\''],
		['color: #FFF, size: 1', 'Expected a value, but reached the end of the document. “#” starts a comment, so a value that starts with “#” must be quoted, as in \'#FFF\''],
		['color: # The color\nsize: 1', 'Expected a value, but found the key size'],
		['server:\n  port: 80', 'Expected a value, but found the key port. Indentation does not nest objects, so write server: {port: …}'],
		['ports:\n  - 80\n  - 443', 'Expected a value, but found a “-” list. An array is written in brackets, as in [80, 443]'],
		['ports:\n- 80', 'Expected a value, but found a “-” list. An array is written in brackets, as in [80, 443]'],
		['{\n\ta:\n\tb: 1\n}', 'Expected a value, but found the key b'],
		['a: {b:\n\'c\': 1}', 'Expected a value, but found the key c'],
		['a:\n\'b\':1', 'Expected a value, but found the key b'],
		['a:\n# Note\n"x y": 1', 'Expected a value, but found the key "x y"'],
		['a:\n[1 2]', 'Expected “,”, a line break, or “]” after an array item, but found “2”'],
		['a: 1\n, b: 2', 'Top-level entries are separated by line breaks, not commas. Use braces for a one-line object'],
		['a: 1\na: 2', 'Duplicate key a'],
		['a: hello', 'Unexpected “hello”. A string value must be quoted, as in \'hello\''],
		['a: yes', '“yes” is not a value. Booleans are written true and false, in lowercase'],
		['a: True', '“True” is not a value. Booleans are written true and false, in lowercase'],
		['a: NULL', '“NULL” is not a value. Null is written null, in lowercase'],
		['a: nan', 'NaN is not representable. Use null for a missing value'],
		['a: inf', '“inf” is not a value. Infinity is written infinity, in lowercase'],
		['a: -inf', '“-inf” is not a value. Negative infinity is written -infinity'],
		['a: +1', 'A “+” sign is not allowed. A number without a sign is positive'],
		['a: 1e+5', 'A “+” sign is not allowed in a number, including in an exponent'],
		['a: .5', 'A number cannot begin with “.”; write a digit before it, as in 0.5'],
		['a: 5.', 'A decimal point must be followed by a digit'],
		['a: 01', 'Leading zeros are not allowed in a decimal number. Write an octal number, such as a file mode, as 0o1, and an identifier, such as a ZIP code, as a string: \'01\''],
		['mode: 0644', 'Leading zeros are not allowed in a decimal number. Write an octal number, such as a file mode, as 0o644, and an identifier, such as a ZIP code, as a string: \'0644\''],
		['zip: 08901', 'Leading zeros are not allowed in a decimal number. Write an identifier, such as a ZIP code, as a string: \'08901\''],
		// The digit that is not octal comes after the length that is diagnosed, so the whole number decides that there is no octal suggestion.
		[`a: 0${'0'.repeat(1100)}8`, `Leading zeros are not allowed in a decimal number. Write an identifier, such as a ZIP code, as a string: '${'0'.repeat(40)}…'`],
		[`a: 0${'0'.repeat(1100)}7`, `Leading zeros are not allowed in a decimal number. Write an identifier, such as a ZIP code, as a string: '${'0'.repeat(40)}…'`],
		['a: 01.5', 'Leading zeros are not allowed in a decimal number'],
		['a: 1e05', 'Leading zeros are not allowed in an exponent'],
		['a: 1e-0', '“e-0” is not allowed, because an exponent of zero has one spelling: e0'],
		['a: -0', '“-0” is not allowed, because zero has one spelling: 0'],
		['a: 1__0', 'An underscore in a number must be between two digits'],
		['a: 1E5', 'An exponent marker is a lowercase “e”'],
		['a: 0xff', 'Hexadecimal digits are uppercase: 0xFF'],
		['a: 0XFF', 'A number prefix is lowercase: 0x, 0o, or 0b'],
		['a: -0xFF', 'A hexadecimal integer cannot have a sign, because it states a bit pattern rather than a quantity'],
		['a: 0o9', 'Invalid octal digit “9”'],
		['a: 0b2', 'Invalid binary digit “2”'],
		['a: 0x', 'Expected hexadecimal digits after “0x”'],
		['a: 1.2.3', 'Invalid number “1.2.3”. A value with several dots, such as a version number, must be quoted'],
		['a: 10sec', 'Invalid duration 10sec: “sec” is not a unit. The units are h, m, s, ms, us, and ns, and a string must be quoted'],
		['a: 2days', 'Invalid duration 2days: there is no day unit, because a day is not a fixed length. Write 24h for a fixed 24 hours'],
		['a: 12abc', 'Invalid number “12abc”. A string value must be quoted, as in \'12abc\''],
		['a: 1d', 'Invalid duration 1d: there is no day unit, because a day is not a fixed length. Write 24h for a fixed 24 hours'],
		['a: 1H', 'Invalid duration 1H: the units are lowercase: h'],
		['a: 1.5h30m', 'Invalid duration 1.5h30m: only the last part may have a fraction'],
		['a: 0.5ns', 'Invalid duration 0.5ns: it is not a whole number of nanoseconds'],
		['a: 1.s', 'Invalid duration 1.s: a “.” must be followed by a digit'],
		['a: 2562048h30x', 'Invalid duration 2562048h30x: “x” is not a unit. The units are h, m, s, ms, us, and ns, and a string must be quoted'],
		['a: 1.5s-', 'Invalid duration 1.5s-: expected a number at “-”'],
		['a: 1h.5m', 'Invalid duration 1h.5m: expected a number at “.5m”'],
		['a: 1.5d', 'Invalid duration 1.5d: there is no day unit, because a day is not a fixed length. Write 24h for a fixed 24 hours'],
		['a: 2weeks', 'Invalid duration 2weeks: there is no week unit, because a day is not a fixed length. Write 168h for a fixed 168 hours'],
		['a: 0_5s', 'Invalid duration 0_5s: leading zeros are not allowed'],
		['a: 1.5_s', 'Invalid duration 1.5_s: an underscore must be between two digits'],
		['a: 30m1h', 'Invalid duration 30m1h: the units are in the order h, m, s, ms, us, ns, and each appears at most once'],
		['a: 1h05m', 'Invalid duration 1h05m: leading zeros are not allowed'],
		['a: 1_s', 'Invalid duration 1_s: an underscore must be between two digits'],
		['a: 1h-30m', 'Invalid duration 1h-30m: only the whole duration takes a sign, as in -1h30m'],
		['a: 1h+30m', 'Invalid duration 1h+30m: a “+” sign is not allowed'],
		['a: 1h30', 'Invalid duration 1h30: every number needs a unit: h, m, s, ms, us, or ns'],
		['a: -0s', 'Invalid duration -0s: “-” is not allowed before zero, because zero has one spelling: 0s'],
		['a: 2562048h', 'Invalid duration 2562048h: it is outside the 64-bit range of nanoseconds, about 292 years either way'],
		['a: 1.5x', 'Invalid number “1.5x”. A string value must be quoted, as in \'1.5x\''],
		['a: 1e3s', 'Invalid number “1e3s”. A string value must be quoted, as in \'1e3s\''],
		['a: 9223372036854775808', 'The integer 9223372036854775808 is outside the 64-bit range (-9223372036854775808 to 9223372036854775807)'],
		['a: 1e999', '1e999 is too large to be a finite float. Use infinity if you mean it'],
		['a: 1e-400', '1e-400 is too small to be told apart from zero. Write 0.0 if you mean zero'],
		['a: -1e-400', '-1e-400 is too small to be told apart from zero. Write 0.0 if you mean zero'],
		['a: 2026-09-19', '2026-09-19 is a date, not an instant. Write a date as a string, as in \'2026-09-19\'. An instant needs a time and an offset, as in 2026-09-19T00:00:00Z'],
		['a: 1979-05-27 07:32:00Z', 'The date and time separator in an instant is an uppercase “T”, not a space, as in 1979-05-27T07:32:00Z'],
		['a: 1979-05-27 07:32:00.5+02:00', 'The date and time separator in an instant is an uppercase “T”, not a space, as in 1979-05-27T07:32:00.5+02:00'],
		['a: [1979-05-27 07:32:00Z]', 'The date and time separator in an instant is an uppercase “T”, not a space, as in 1979-05-27T07:32:00Z'],
		['a: 1979-05-27 07:32:00', 'The date and time separator in an instant is an uppercase “T”, not a space, and an instant needs the offset it was meant in, as in 1979-05-27T07:32:00Z for UTC. A date and time without an offset is a local time, which is not an instant, so write it as a string, as in \'1979-05-27 07:32:00\''],
		['a: 1979-05-27 07:32:00,5Z', 'The date and time separator in an instant is an uppercase “T”, not a space. An instant is written as 2026-09-19T14:00:00Z, with an optional fraction of up to nine digits and an offset of Z or ±HH:MM'],
		['a: 1979-05-27 07:32', 'The date and time separator in an instant is an uppercase “T”, not a space. An instant is written as 2026-09-19T14:00:00Z, with an optional fraction of up to nine digits and an offset of Z or ±HH:MM'],
		['a: 1979-05-27 # note', '1979-05-27 is a date, not an instant. Write a date as a string, as in \'1979-05-27\'. An instant needs a time and an offset, as in 1979-05-27T00:00:00Z'],
		['retention: 6M', 'Invalid duration 6M: there is no month unit, because a month is not a fixed length. A size, such as 512M, is a string: \'6M\''],
		['memory: 512M', 'Invalid duration 512M: there is no month unit, because a month is not a fixed length. A size, such as 512M, is a string: \'512M\''],
		['a: 1h6M', 'Invalid duration 1h6M: there is no month unit, because a month is not a fixed length'],
		['a: 2026-09-19t14:00:00Z', 'The date and time separator in an instant is an uppercase “T”'],
		['a: 2026-09-19T14:00:00z', 'The UTC offset in an instant is an uppercase “Z”'],
		['a: 2026-09-19T14:00:00', 'An instant needs an offset: Z or ±HH:MM. A date and time without an offset is a local time, which is not an instant, so write it as a string, as in \'2026-09-19T14:00:00\', or add the offset it was meant in'],
		['a: 2026-09-19T14:00:00.5', 'An instant needs an offset: Z or ±HH:MM. A date and time without an offset is a local time, which is not an instant, so write it as a string, as in \'2026-09-19T14:00:00.5\', or add the offset it was meant in'],
		['a: 2026-09-19T14:00:00+0700', 'An instant\'s offset is written with a colon, as in +07:00'],
		['a: 2026-02-30T00:00:00Z', 'Invalid instant 2026-02-30T00:00:00Z: the day must be 01 to 28 in that month'],
		['a: 2026-12-31T23:59:60Z', 'Invalid instant 2026-12-31T23:59:60Z: the second must be 00 to 59, and a leap second is not representable'],
		['a: \'x', 'Unterminated string. A \'...\' string must end on the line it starts on; use a block string (\'\'\') for multiple lines'],
		['a: "x', 'Unterminated string. A "..." string must end on the line it starts on; use a block string (""") for multiple lines'],
		[String.raw`a: "\q"`, String.raw`Unknown escape “\q”. The escapes are \\, \", \n, \t, and \u{…}; use a '...' string for literal backslashes`],
		[String.raw`a: "\r"`, String.raw`There is no \r escape, because a carriage return cannot be represented`],
		[String.raw`a: "\'"`, 'A \' needs no escape inside "..."'],
		[String.raw`a: "\u0041"`, String.raw`The four-digit \u0041 form is not an escape. Write \u{41}`],
		[String.raw`a: "\u{0041}"`, String.raw`A Unicode escape may not have leading zeros; write \u{41}`],
		[String.raw`a: "\u{E9}"`, 'A Unicode escape uses lowercase hexadecimal digits'],
		[String.raw`a: "\u{d800}"`, String.raw`\u{d800} is a surrogate, which is not a Unicode scalar value`],
		[String.raw`a: "\u{110000}"`, String.raw`\u{110000} is above U+10FFFF, the largest Unicode scalar value`],
		[String.raw`a: "\u{d}"`, String.raw`A carriage return (U+000D) cannot be represented, so \u{d} is not allowed`],
		['a: \'\'\'x\n\'\'\'', 'A block string\'s opening delimiter must be followed directly by a line break, and its content starts on the next line'],
		['a: \'\'\'\nx', 'Unterminated block string'],
		['a: \'\'\'\nWelcome!\'\'\'', 'Unterminated block string. Its closing delimiter must start a line, so move the \'\'\' at the end of line 2 to a new line'],
		['a: """\n\tHello\n\tWelcome!"""  \nb: 1', 'Unterminated block string. Its closing delimiter must start a line, so move the """ at the end of line 3 to a new line'],
		['a: [1,000]', 'Leading zeros are not allowed in a decimal number. A comma separates items, so 1,000 is not one number. Write it as 1_000 or 1000'],
		['a: [-1,000]', 'Leading zeros are not allowed in a decimal number. A comma separates items, so -1,000 is not one number. Write it as -1_000 or -1000'],
		['a: [12,345,000]', 'Leading zeros are not allowed in a decimal number. A comma separates items, so 12,345,000 is not one number. Write it as 12_345_000 or 12345000'],
		['a: [1,234,567,000]', 'Leading zeros are not allowed in a decimal number. A comma separates items, so 1,234,567,000 is not one number. Write it as 1_234_567_000 or 1234567000'],
		['a: [12,050,000]', 'Leading zeros are not allowed in a decimal number. A comma separates items, so 12,050,000 is not one number. Write it as 12_050_000 or 12050000'],
		['a: [0x1,000]', 'Leading zeros are not allowed in a decimal number. Write an octal number, such as a file mode, as 0o0, and an identifier, such as a ZIP code, as a string: \'000\''],
		['a: [1, 000]', 'Leading zeros are not allowed in a decimal number. Write an octal number, such as a file mode, as 0o0, and an identifier, such as a ZIP code, as a string: \'000\''],
		['a: 1.5µs', 'The unit for microseconds is written us, as in 1.5us'],
		['a: 3μs', 'The unit for microseconds is written us, as in 3us'],
		['a: \'it\'\'s\'', 'There is no \'\' escape in a \'...\' string. Write a string that contains \' as "...", as in "it\'s"'],
		['a: \'\'\'\n\tx\n\t\t\'\'\'', 'This line does not start with the indentation of its block string\'s closing delimiter. Every line except a blank one must start with exactly the same spaces and tabs'],
		['\'\'\'\nk\n\'\'\': 1', 'A block string cannot be a key'],
		['a: 1\n/* x', 'Unterminated block comment'],
		['/* a /* b */\na: 1', 'Block comments cannot be nested, and their body may not contain “/*”'],
		['a: [1 2]', 'Expected “,”, a line break, or “]” after an array item, but found “2”'],
		['a: {b: 1 c: 2}', 'Expected “,”, a line break, or “}” after an object member, but found “c”'],
		['a: [1 /*\n*/ 2]', 'Expected “,”, a line break, or “]” after an array item, but found “2”. A line break inside a block comment does not separate items'],
		['a: [1', 'Unterminated array: expected “]”'],
		['a: {b: 1', 'Unterminated object: expected “}”'],
		['a:\u{A0}1', 'Expected a value, but found U+00A0 (NO-BREAK SPACE; only space, tab, and line feed are whitespace)'],
		['a: 1\u{2028}', 'Unexpected U+2028 (LINE SEPARATOR; only space, tab, and line feed are whitespace) after a value'],
		['a: 1\r\n', 'A carriage return (U+000D) is not allowed anywhere. Use LF line endings'],
		['\u{FEFF}a: 1', 'A byte order mark (BOM) is not allowed'],
		['a: \u{1}', String.raw`A raw control character (U+0001) is not allowed anywhere, including in strings and comments. In a string, write it as the escape \u{1} inside "..."`],
		['a: `x`', 'Expected a value, but found “`”'],
		['a: \u{202E}x', 'Expected a value, but found U+202E (RIGHT-TO-LEFT OVERRIDE)'],
		['a: \u{E000}', 'Expected a value, but found U+E000'],
		['a: \u{FFF9}', 'Expected a value, but found U+FFF9'],
		['a: 😀', 'Expected a value, but found “😀”'],
		['a.b: 1', 'A bare key cannot contain “.”. Quote it, as in \'a.b\', or use braces to nest, as in a: {b: …}'],
		['example.com: 1', 'A bare key cannot contain “.”. Quote it, as in \'example.com\', or use braces to nest, as in example: {com: …}'],
		['a.b.c: 1', 'A bare key cannot contain “.”. Quote it, as in \'a.b.c\', or use braces to nest, as in a: {b: {c: …}}'],
		// A number is a valid bare key, so `3.14` as a key is a key with a dot, not a float.
		['3.14: \'x\'', 'A bare key cannot contain “.”. Quote it, as in \'3.14\', or use braces to nest, as in 3: {14: …}'],
		['1.5s: 1', 'A bare key cannot contain “.”. Quote it, as in \'1.5s\', or use braces to nest, as in 1: {5s: …}'],
		['{a.b: 1}', 'A bare key cannot contain “.”. Quote it, as in \'a.b\', or use braces to nest, as in a: {b: …}'],
		// The suggestions are only given when both are valid: a bare key with a word on both sides of every dot, and a `:` right after it.
		['\'a\'.b: 1', 'A key cannot contain “.” unless it is quoted. Quote the whole key, or use braces to nest, as in a: {b: …}'],
		['a.\'b\': 1', 'A key cannot contain “.” unless it is quoted. Quote the whole key, or use braces to nest, as in a: {b: …}'],
		['a.: 1', 'A key cannot contain “.” unless it is quoted. Quote the whole key, or use braces to nest, as in a: {b: …}'],
		['a..b: 1', 'A key cannot contain “.” unless it is quoted. Quote the whole key, or use braces to nest, as in a: {b: …}'],
		['a.b', 'A key cannot contain “.” unless it is quoted. Quote the whole key, or use braces to nest, as in a: {b: …}'],
		['.a: 1', 'Expected a key, but found “.”. A key that contains characters other than letters, digits, “_”, and “-” must be quoted, as in \'.a\''],
		['.env: 1', 'Expected a key, but found “.”. A key that contains characters other than letters, digits, “_”, and “-” must be quoted, as in \'.env\''],
		['files: {.eslintrc.json: 1}', 'Expected a key, but found “.”. A key that contains characters other than letters, digits, “_”, and “-” must be quoted, as in \'.eslintrc.json\''],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, reason);
		});
	}
});

suite('every invalid conformance case fails for the reviewed reason', () => {
	const root = path.join(import.meta.dirname, 'conformance', 'invalid');
	const expected = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'conformance', 'invalid-reasons.json'), 'utf8')) as Record<string, {reason: string; line: number; column: number}>;
	const names = fs.readdirSync(root, {recursive: true, encoding: 'utf8'}).filter(file => file.endsWith('.soml')).map(file => file.slice(0, -'.soml'.length)).toSorted();

	test('every case has an expected reason, and every reason has a case', () => {
		assert.deepEqual(names, Object.keys(expected).toSorted());
	});

	for (const name of names) {
		test(name, () => {
			const error = catchParseError(new Uint8Array(fs.readFileSync(path.join(root, `${name}.soml`))));
			assert.deepEqual({reason: error.reason, line: error.line, column: error.column}, expected[name]);
		});
	}
});

suite('a suggested escape is valid', () => {
	/*
	The escape that a reason tells the user to write, if any.
	*/
	function suggestedEscape(reason: string): string | undefined {
		return /(?<=[Ww]rite )\\u\{[\da-f]+\}/v.exec(reason)?.[0];
	}

	test('a JSON surrogate pair is one escape for the character it encodes', () => {
		assert.equal(catchParseError(String.raw`a: "\uD83D\uDE00"`).reason, String.raw`The four-digit \uD83D\uDE00 form is not an escape. Write \u{1f600}`);
		assert.equal(catchParseError(String.raw`a: "\ud83d\ude00"`).reason, String.raw`The four-digit \ud83d\ude00 form is not an escape. Write \u{1f600}`);
		assert.equal(catchParseError(String.raw`a: "\uD800\uDC00"`).reason, String.raw`The four-digit \uD800\uDC00 form is not an escape. Write \u{10000}`);
		assert.equal(catchParseError(String.raw`a: "\uDBFF\uDFFF"`).reason, String.raw`The four-digit \uDBFF\uDFFF form is not an escape. Write \u{10ffff}`);
	});

	test('a lone JSON surrogate has no escape to suggest', () => {
		const reason = String.raw`is not an escape, and a lone surrogate is not a Unicode scalar value. Write the character it is half of as one \u{…} escape`;
		assert.equal(catchParseError(String.raw`a: "\uD83D"`).reason, String.raw`The four-digit \uD83D form ${reason}`);
		assert.equal(catchParseError(String.raw`a: "\uDE00"`).reason, String.raw`The four-digit \uDE00 form ${reason}`);
		// A low surrogate first, or a high surrogate before something that is not a low one, is not a pair.
		assert.equal(catchParseError(String.raw`a: "\uDE00\uD83D"`).reason, String.raw`The four-digit \uDE00 form ${reason}`);
		assert.equal(catchParseError(String.raw`a: "\uD83D\uD83D"`).reason, String.raw`The four-digit \uD83D form ${reason}`);
		assert.equal(catchParseError(String.raw`a: "\uD83D\u0041"`).reason, String.raw`The four-digit \uD83D form ${reason}`);
		assert.equal(catchParseError(String.raw`a: "\uD83D\u{de00}"`).reason, String.raw`The four-digit \uD83D form ${reason}`);
		assert.equal(catchParseError(String.raw`a: "\uD83Dx"`).reason, String.raw`The four-digit \uD83D form ${reason}`);
	});

	test('a JSON carriage return has no escape to suggest', () => {
		assert.equal(catchParseError(String.raw`a: "\u000D"`).reason, String.raw`The four-digit \u000D form is not an escape, and a carriage return (U+000D) cannot be represented`);
		assert.equal(catchParseError(String.raw`a: "\u000d"`).reason, String.raw`The four-digit \u000d form is not an escape, and a carriage return (U+000D) cannot be represented`);
	});

	test('a braced escape with leading zeros is reported for its value first', () => {
		assert.equal(catchParseError(String.raw`a: "\u{000d}"`).reason, String.raw`A carriage return (U+000D) cannot be represented, so \u{000d} is not allowed`);
		assert.equal(catchParseError(String.raw`a: "\u{00d800}"`).reason, String.raw`\u{00d800} is a surrogate, which is not a Unicode scalar value`);
		assert.equal(catchParseError(String.raw`a: "\u{0dfff}"`).reason, String.raw`\u{0dfff} is a surrogate, which is not a Unicode scalar value`);
		assert.equal(catchParseError(String.raw`a: "\u{011000}"`).reason, String.raw`A Unicode escape may not have leading zeros; write \u{11000}`);
		assert.equal(catchParseError(String.raw`a: "\u{00}"`).reason, String.raw`A Unicode escape may not have leading zeros; write \u{0}`);
	});

	test('every four-digit form suggests an escape that reads as the character JSON reads', () => {
		for (let code = 0; code <= 0xFF_FF; code++) {
			const escape = String.raw`\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
			const suggestion = suggestedEscape(catchParseError(`a: "${escape}"`).reason);
			const isRepresentable = code !== 0x0D && (code < 0xD8_00 || code > 0xDF_FF);
			assert.equal(suggestion !== undefined, isRepresentable, escape);

			if (suggestion === undefined) {
				continue;
			}

			assert.deepEqual(parse(`a: "${suggestion}"`), {a: JSON.parse(`"${escape}"`) as string}, escape);
		}
	});

	test('every surrogate pair suggests an escape that reads as the character JSON reads', () => {
		for (let high = 0xD8_00; high <= 0xDB_FF; high += 0x31) {
			for (let low = 0xDC_00; low <= 0xDF_FF; low += 0x29) {
				const escape = String.raw`\u${high.toString(16)}\u${low.toString(16)}`;
				const suggestion = suggestedEscape(catchParseError(`a: "${escape}"`).reason);
				assert.notEqual(suggestion, undefined, escape);
				assert.deepEqual(parse(`a: "${suggestion}"`), {a: JSON.parse(`"${escape}"`) as string}, escape);
			}
		}
	});

	test('every braced form with leading zeros suggests a valid escape, or none', () => {
		for (const hex of ['00', '000', '0041', '00e9', '000d', '0d800', '00dbff', '0dc00', '0dfff', '0e000', '01f600', '000010']) {
			const {reason} = catchParseError(String.raw`a: "\u{${hex}}"`);
			const suggestion = suggestedEscape(reason);

			if (suggestion === undefined) {
				continue;
			}

			assert.equal(suggestion, String.raw`\u{${hex.replace(/^0+(?=.)/v, '')}}`, reason);
			parse(`a: "${suggestion}"`);
		}
	});
});

suite('a suggested quoted string holds the whole unquoted value', () => {
	const cases: Array<[source: string, text: string]> = [
		['name: John Smith', 'John Smith'],
		['name: John Smith # The owner', 'John Smith'],
		['name: John Smith \t\nisAdmin: true', 'John Smith'],
		['a: foo.bar', 'foo.bar'],
		['a: foo/bar', 'foo/bar'],
		['a: v1.2.3', 'v1.2.3'],
		['a: C# and F#', 'C# and F#'],
		['a: say "hi"', 'say "hi"'],
		['a: [foo bar, true]', 'foo bar'],
		['a: [foo bar]', 'foo bar'],
		['a: {b: foo bar}', 'foo bar'],
		['a: {b: foo bar, c: true}', 'foo bar'],
		['a: [\n\tfoo bar\n]', 'foo bar'],
	];

	for (const [source, text] of cases) {
		test(JSON.stringify(source), () => {
			const {reason} = catchParseError(source);
			assert.ok(reason.endsWith(`A string value must be quoted, as in '${text}'`), reason);
			// The suggestion is what was meant: with the text quoted, the document is valid and holds it.
			assert.equal(JSON.stringify(parse(source.replace(text, () => `'${text}'`))).includes(JSON.stringify(text)), true);
		});
	}

	test('the word itself is still what is unexpected', () => {
		assert.equal(catchParseError('name: John Smith').reason, 'Unexpected “John”. A string value must be quoted, as in \'John Smith\'');
		assert.equal(catchParseError('a: hello').reason, 'Unexpected “hello”. A string value must be quoted, as in \'hello\'');
	});

	test('a value that holds a single quote has no literal string to suggest', () => {
		assert.equal(catchParseError('a: it\'s here').reason, 'Unexpected “it”. A string value must be quoted');
	});

	test('a long value is cut short in the suggestion', () => {
		const words = Array.from({length: 1000}, () => 'word').join(' ');
		assert.equal(catchParseError(`a: ${words}`).reason, `Unexpected “word”. A string value must be quoted, as in '${words.slice(0, 40)}…'`);
	});
});

suite('a word after the ":" of a member and a space is an unquoted string, not a key', () => {
	const cases: Array<[source: string, reason: string]> = [
		['url: https://example.com', 'Unexpected “https”. A string value must be quoted, as in \'https://example.com\''],
		['url: https://example.com/a?b=c # The API', 'Unexpected “https”. A string value must be quoted, as in \'https://example.com/a?b=c\''],
		['host: localhost:8080', 'Unexpected “localhost”. A string value must be quoted, as in \'localhost:8080\''],
		['a: {url: https://x, b: true}', 'Unexpected “https”. A string value must be quoted, as in \'https://x\''],
		['a: x:y', 'Unexpected “x”. A string value must be quoted, as in \'x:y\''],
		['msg: Error: file not found', 'Unexpected “Error”. A string value must be quoted, as in \'Error: file not found\''],
		['a: [Note: x, true]', 'Expected a value, but found the key Note'],
		['a: {msg: Error: x}', 'Unexpected “Error”. A string value must be quoted, as in \'Error: x\''],
		['a: b:', 'Unexpected “b”. A string value must be quoted, as in \'b:\''],
		// Anywhere else, a key where a value should be is reported as a key, as when the value of an entry is left out, or in an array, even when it was meant as text.
		['a:\nb: 1', 'Expected a value, but found the key b'],
		['a:\nb:\t1', 'Expected a value, but found the key b'],
		['a:\nb:', 'Expected a value, but found the key b'],
		['a:\nb:1\nc: 2', 'Expected a value, but found the key b'],
		['{a:\nb:1}', 'Expected a value, but found the key b'],
		['a: [\n\t3\n\tc: 5\n]', 'Expected a value, but found the key c'],
		['[a:1]', 'Expected a value, but found the key a'],
		['x: [a:b, c]', 'Expected a value, but found the key a'],
		['a: [https://x, true]', 'Expected a value, but found the key https'],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, reason);
		});
	}
});

suite('a suggested uppercase hexadecimal integer is valid', () => {
	const cases: Array<[source: string, reason: string]> = [
		['a: 0xff', 'Hexadecimal digits are uppercase: 0xFF'],
		['a: 0xff_ff', 'Hexadecimal digits are uppercase: 0xFF_FF'],
		['a: 0xFf', 'Hexadecimal digits are uppercase: 0xFF'],
		['a: 0x00ff', 'Hexadecimal digits are uppercase: 0x00FF'],
		// The uppercase spelling would still be invalid, so the underscore is reported.
		['a: 0x_ff', 'An underscore in a number must be between two digits'],
		['a: 0xff_', 'An underscore in a number must be between two digits'],
		['a: 0xf__f', 'An underscore in a number must be between two digits'],
		['a: 0x_FF', 'An underscore in a number must be between two digits'],
		// The lowercase digits come after the length that is diagnosed, so the whole number decides the reason.
		[`a: 0x${'1'.repeat(1100)}ff`, 'Hexadecimal digits are uppercase'],
		[`a: 0x${'1'.repeat(1100)}f_f`, 'Hexadecimal digits are uppercase'],
		[`a: 0x${'1'.repeat(1100)}f__f`, 'An underscore in a number must be between two digits'],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, reason);
		});
	}

	test('every suggestion parses to the value the lowercase digits mean', () => {
		for (const digits of ['a', 'f', '0a', 'a0', 'ab_cd', 'a_b_c', '7fffffffffffffff', 'dead_beef', '_a', 'a_', 'a__b', 'a_b_', '_']) {
			const {reason} = catchParseError(`a: 0x${digits}`);
			const suggestion = /(?<=uppercase: )\S+$/v.exec(reason)?.[0];

			if (suggestion === undefined) {
				continue;
			}

			assert.deepEqual(parse(`a: ${suggestion}`), {a: BigInt(`0x${digits.replaceAll('_', '')}`)}, reason);
		}
	});
});

suite('a date is only shown as an instant when the date exists', () => {
	const asString = (date: string) => `${date} is a date, not an instant. Write a date as a string, as in '${date}'`;
	const asInstant = (date: string) => `${asString(date)}. An instant needs a time and an offset, as in ${date}T00:00:00Z`;
	const cases: Array<[source: string, reason: string]> = [
		['a: 2026-09-19', asInstant('2026-09-19')],
		['a: 2024-02-29', asInstant('2024-02-29')],
		['a: 0001-01-01', asInstant('0001-01-01')],
		['a: 9999-12-31', asInstant('9999-12-31')],
		['a: 2026-02-30', asString('2026-02-30')],
		['a: 2025-02-29', asString('2025-02-29')],
		['a: 1900-02-29', asString('1900-02-29')],
		['a: 2026-04-31', asString('2026-04-31')],
		['a: 2026-13-01', asString('2026-13-01')],
		['a: 2026-00-10', asString('2026-00-10')],
		['a: 2026-01-00', asString('2026-01-00')],
		['a: 0000-01-01', asString('0000-01-01')],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			const error = catchParseError(source);
			assert.equal(error.reason, reason);
			const instant = /(?<=as in )\d{4}-\d{2}-\d{2}T00:00:00Z$/v.exec(error.reason)?.[0];

			if (instant !== undefined) {
				parse(`a: ${instant}`);
			}
		});
	}
});

suite('a float that is too large suggests the infinity of its sign', () => {
	const cases: Array<[source: string, reason: string]> = [
		['a: 1e999', '1e999 is too large to be a finite float. Use infinity if you mean it'],
		['a: 1.7976931348623159e308', '1.7976931348623159e308 is too large to be a finite float. Use infinity if you mean it'],
		['a: -1e999', '-1e999 is too large to be a finite float. Use -infinity if you mean it'],
		['a: -1.7976931348623159e308', '-1.7976931348623159e308 is too large to be a finite float. Use -infinity if you mean it'],
		['a: -1_000e1_000', '-1_000e1_000 is too large to be a finite float. Use -infinity if you mean it'],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, reason);
			// The suggestion reads as the value that the literal rounds to.
			const suggestion = /(?<=Use )\S+/v.exec(reason)![0];
			assert.deepEqual(parse(`a: ${suggestion}`), {a: Number(source.slice('a: '.length).replaceAll('_', ''))});
		});
	}
});

suite('a missing ":" is only explained as a key with spaces when the ":" ends the key', () => {
	const cases: Array<[source: string, reason: string]> = [
		// Quoting the words before the `:` would give a valid document with another meaning, or still an invalid one.
		['server localhost:8080', 'Expected “:” after the key, but found “l”'],
		['time 12:30', 'Expected “:” after the key, but found “1”'],
		['homepage https://example.com', 'Expected “:” after the key, but found “h”'],
		['the name: 1', 'A bare key cannot contain spaces. Quote it, as in \'the name\''],
		['the name:\t1', 'A bare key cannot contain spaces. Quote it, as in \'the name\''],
		['the name:\n\t1', 'A bare key cannot contain spaces. Quote it, as in \'the name\''],
		['the name:', 'A bare key cannot contain spaces. Quote it, as in \'the name\''],
		// Text directly after the `:` could be the value, as in `the name:1`, or part of it, as in `server localhost:8080`, so there is no hint.
		['the name:1', 'Expected “:” after the key, but found “n”'],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, reason);
		});
	}
});

suite('a value that starts with "." is only a number when a digit follows', () => {
	const cases: Array<[source: string, reason: string]> = [
		['a: .5', 'A number cannot begin with “.”; write a digit before it, as in 0.5'],
		['a: .5e3', 'A number cannot begin with “.”; write a digit before it, as in 0.5'],
		['a: .env', 'Unexpected “.”. A string value must be quoted, as in \'.env\''],
		['a: ./foo # The path', 'Unexpected “.”. A string value must be quoted, as in \'./foo\''],
		['files: [.env, .git]', 'Unexpected “.”. A string value must be quoted, as in \'.env\''],
		['a: ...', 'Unexpected “.”. A string value must be quoted, as in \'...\''],
		['a: .', 'Unexpected “.”. A string value must be quoted, as in \'.\''],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, reason);
		});
	}
});

suite('a keyword hint is only given for a word on its own', () => {
	const cases: Array<[source: string, reason: string]> = [
		['a: Yes', '“Yes” is not a value. Booleans are written true and false, in lowercase'],
		['a: None # Unset', '“None” is not a value. Null is written null, in lowercase'],
		['a: [NaN, 1]', 'NaN is not representable. Use null for a missing value'],
		['a: Inf', '“Inf” is not a value. Infinity is written infinity, in lowercase'],
		// Following the hint would change the value or leave text behind, so the text is a string.
		['a: Yes please', 'Unexpected “Yes”. A string value must be quoted, as in \'Yes please\''],
		['status: On hold', 'Unexpected “On”. A string value must be quoted, as in \'On hold\''],
		['a: None of the above', 'Unexpected “None”. A string value must be quoted, as in \'None of the above\''],
		['name: Nan Goldin', 'Unexpected “Nan”. A string value must be quoted, as in \'Nan Goldin\''],
		['a: [Inf loop, 1]', 'Unexpected “Inf”. A string value must be quoted, as in \'Inf loop\''],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, reason);
		});
	}
});

suite('a suggested quoted string holds the whole unquoted value that starts with a number', () => {
	const cases: Array<[source: string, reason: string]> = [
		['border: 1px solid black', 'Invalid number “1px”. A string value must be quoted, as in \'1px solid black\''],
		['font: 12pt Arial # Body', 'Invalid number “12pt”. A string value must be quoted, as in \'12pt Arial\''],
		['a: [1px solid, 2]', 'Invalid number “1px”. A string value must be quoted, as in \'1px solid\''],
		['a: 1px', 'Invalid number “1px”. A string value must be quoted, as in \'1px\''],
		['a: 3x it\'s', 'Invalid number “3x”. A string value must be quoted'],
		// The octal suggestion is only for the number on its own.
		['phone: 0412 345 678', 'Leading zeros are not allowed in a decimal number. Write an identifier, such as a ZIP code, as a string: \'0412 345 678\''],
		['date: 01/02/2026', 'Leading zeros are not allowed in a decimal number. Write an identifier, such as a ZIP code, as a string: \'01/02/2026\''],
		['mode: 0644', 'Leading zeros are not allowed in a decimal number. Write an octal number, such as a file mode, as 0o644, and an identifier, such as a ZIP code, as a string: \'0644\''],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, reason);
		});
	}
});

suite('a block comment after the unquoted value is not part of the suggestion', () => {
	test('a block comment after a space or a tab ends the value', () => {
		assert.equal(catchParseError('a: hello world /* note */').reason, 'Unexpected “hello”. A string value must be quoted, as in \'hello world\'');
		assert.equal(catchParseError('a: [hello world\t/* note */]').reason, 'Unexpected “hello”. A string value must be quoted, as in \'hello world\'');
		assert.equal(catchParseError('a: 1px solid /* note */').reason, 'Invalid number “1px”. A string value must be quoted, as in \'1px solid\'');
	});

	test('a "/*" directly after the text is part of it', () => {
		assert.equal(catchParseError('a: src/*.js').reason, 'Unexpected “src”. A string value must be quoted, as in \'src/*.js\'');
	});
});

suite('a suggested uppercase hexadecimal integer is in range', () => {
	const cases: Array<[source: string, reason: string]> = [
		['a: 0x7fffffffffffffff', 'Hexadecimal digits are uppercase: 0x7FFFFFFFFFFFFFFF'],
		['a: 0x0000_7fff_ffff_ffff_ffff', 'Hexadecimal digits are uppercase: 0x0000_7FFF_FFFF_FFFF_FFFF'],
		// The uppercase spelling would be outside the 64-bit range, so there is no example.
		['a: 0x8000000000000000a', 'Hexadecimal digits are uppercase'],
		['a: 0xffffffffffffffff', 'Hexadecimal digits are uppercase'],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, reason);
		});
	}
});

suite('an invalid digit after a radix prefix is the one named', () => {
	const cases: Array<[source: string, reason: string]> = [
		['a: 0xffg', 'Invalid hexadecimal digit “g”'],
		['a: 0xFfz', 'Invalid hexadecimal digit “z”'],
		['a: 0xFG', 'Invalid hexadecimal digit “G”'],
		['a: 0o78', 'Invalid octal digit “8”'],
		['a: 0b102', 'Invalid binary digit “2”'],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, reason);
		});
	}
});

suite('a "=" after a key is not a reason to quote it', () => {
	const cases: Array<[source: string, reason: string]> = [
		['name=foo', 'Expected “:” after the key, but found “=”'],
		['port=8080', 'Expected “:” after the key, but found “=”'],
		['{a=1}', 'Expected “:” after the key, but found “=”'],
		['a = 1', 'Expected “:” after the key, but found “=”'],
		// Other characters directly after a key are still most likely part of it.
		['a$: 1', 'Expected “:” after the key, but found “$”. A key that contains characters other than letters, digits, “_”, and “-” must be quoted'],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, reason);
		});
	}
});

suite('a suggested identifier string can hold the text', () => {
	test('text with a single quote gets no example, because a literal string cannot hold it', () => {
		assert.equal(catchParseError('a: 01234 O\'Brien').reason, 'Leading zeros are not allowed in a decimal number. Write an identifier, such as a ZIP code, as a string');
		assert.equal(catchParseError('a: 0899 x\'y').reason, 'Leading zeros are not allowed in a decimal number. Write an identifier, such as a ZIP code, as a string');
	});
});

suite('a value that starts with "#" is only shown quoted when a literal string can hold it', () => {
	const hint = '“#” starts a comment, so a value that starts with “#” must be quoted';
	const cases: Array<[source: string, reason: string]> = [
		['a: #don\'t', `Expected a value, but reached the end of the document. ${hint}`],
		['a: #\'x\'', `Expected a value, but reached the end of the document. ${hint}`],
		['a: #it\'s\nb: 1', `Expected a value, but found the key b. ${hint}`],
		['{a: #it\'s\n}', `Expected a value, but found “}”. ${hint}`],
		['a: #dont', `Expected a value, but reached the end of the document. ${hint}, as in '#dont'`],
		['a: #say"hi"', `Expected a value, but reached the end of the document. ${hint}, as in '#say"hi"'`],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, reason);
		});
	}

	test('every example is a valid string that holds the value', () => {
		for (const value of ['#FFF', String.raw`#a\b`, '#say"hi"', '#1.5', '#é😀']) {
			const example = /(?<=as in ).+$/v.exec(catchParseError(`a: ${value}`).reason)![0];
			assert.deepEqual(parse(`a: ${example}`), {a: value});
		}
	});
});

suite('a suggested octal integer is in range', () => {
	const octal = (digits: string, text: string) => `Leading zeros are not allowed in a decimal number. Write an octal number, such as a file mode, as 0o${digits}, and an identifier, such as a ZIP code, as a string: '${text}'`;
	const identifier = (text: string) => `Leading zeros are not allowed in a decimal number. Write an identifier, such as a ZIP code, as a string: '${text}'`;
	const cases: Array<[source: string, reason: string]> = [
		['a: 0777777777777777777777', octal('777777777777777777777', '0777777777777777777777')],
		['a: 0000777777777777777777777', octal('777777777777777777777', '0000777777777777777777777')],
		// The largest octal int is 0o777777777777777777777, so one more digit is outside the 64-bit range.
		['a: 01000000000000000000000', identifier('01000000000000000000000')],
		['a: 01777777777777777777777', identifier('01777777777777777777777')],
		['a: 07777777777777777777777777', identifier('07777777777777777777777777')],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, reason);
		});
	}

	test('every suggestion parses to the value the digits mean in octal', () => {
		for (const digits of ['00', '07', '0644', '0755', '00007', '0777777777777777777777', '01000000000000000000000', '0'.repeat(30)]) {
			const suggestion = /(?<=as )0o\d+(?=,)/v.exec(catchParseError(`a: ${digits}`).reason)?.[0];

			if (suggestion === undefined) {
				assert.ok(BigInt(`0o${digits}`) > 9_223_372_036_854_775_807n, digits);
				continue;
			}

			assert.deepEqual(parse(`a: ${suggestion}`), {a: BigInt(`0o${digits}`)});
		}
	});
});

suite('a number with thousands separators is only suggested when it is in range', () => {
	const prefix = (number: string) => `Leading zeros are not allowed in a decimal number. A comma separates items, so ${number} is not one number`;
	const cases: Array<[source: string, reason: string]> = [
		['a: [9,223,372,036,854,775,807]', `${prefix('9,223,372,036,854,775,807')}. Write it as 9_223_372_036_854_775_807 or 9223372036854775807`],
		['a: [-9,223,372,036,854,775,808]', `${prefix('-9,223,372,036,854,775,808')}. Write it as -9_223_372_036_854_775_808 or -9223372036854775808`],
		['a: [9,223,372,036,854,775,808]', prefix('9,223,372,036,854,775,808')],
		['a: [-9,223,372,036,854,775,809]', prefix('-9,223,372,036,854,775,809')],
		['a: [10,000,000,000,000,000,000]', prefix('10,000,000,000,000,000,000')],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, reason);
		});
	}

	test('every suggestion parses to the number without its commas', () => {
		for (const number of ['1,000', '-1,000', '999,000', '12,345,000', '9,223,372,036,854,775,807', '9,223,372,036,854,775,808', '-9,223,372,036,854,775,809']) {
			const suggestions = /(?<=Write it as )(?<first>\S+) or (?<second>\S+)$/v.exec(catchParseError(`a: [${number}]`).reason)?.groups;

			if (suggestions === undefined) {
				const value = BigInt(number.replaceAll(',', ''));
				assert.ok(value > 9_223_372_036_854_775_807n || value < -9_223_372_036_854_775_808n, number);
				continue;
			}

			for (const suggestion of [suggestions['first']!, suggestions['second']!]) {
				assert.deepEqual(parse(`a: [${suggestion}]`), {a: [BigInt(number.replaceAll(',', ''))]});
			}
		}
	});
});

suite('a date and a time with a space between them are only shown as an instant when it is valid', () => {
	const separator = 'The date and time separator in an instant is an uppercase “T”, not a space';
	const general = `${separator}. An instant is written as 2026-09-19T14:00:00Z, with an optional fraction of up to nine digits and an offset of Z or ±HH:MM`;
	const cases: Array<[source: string, reason: string]> = [
		['a: 2024-02-29 14:00:00Z', `${separator}, as in 2024-02-29T14:00:00Z`],
		['a: 2026-01-01 14:00:00.123456789Z', `${separator}, as in 2026-01-01T14:00:00.123456789Z`],
		['a: 2026-02-30 14:00:00Z', general],
		['a: 2025-02-29 14:00:00Z', general],
		['a: 2026-01-01 24:00:00Z', general],
		['a: 2026-01-01 14:60:00Z', general],
		['a: 2026-01-01 14:00:60Z', general],
		['a: 2026-01-01 14:00:00.1234567890Z', general],
		['a: 2026-01-01 14:00:00-00:00', general],
		['a: 2026-01-01 14:00:00+24:00', general],
		// In UTC, these fall outside the years 0001 to 9999.
		['a: 0001-01-01 00:00:00+01:00', general],
		['a: 9999-12-31 23:59:59-01:00', general],
		// A local time is only suggested in UTC when that is valid.
		['a: 2024-02-29 14:00:00', `${separator}, and an instant needs the offset it was meant in, as in 2024-02-29T14:00:00Z for UTC. A date and time without an offset is a local time, which is not an instant, so write it as a string, as in '2024-02-29 14:00:00'`],
		['a: 2026-02-30 14:00:00', general],
		['a: 2026-01-01 25:00:00', general],
		['a: 0000-01-01 00:00:00', general],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, reason);
			const instant = /(?<=as in )\S+T\S+/v.exec(reason)?.[0];

			if (instant !== undefined) {
				parse(`a: ${instant}`);
			}
		});
	}
});

suite('a duration without the space is only suggested when it is valid', () => {
	const reason = (duration: string, text: string) => `A unit cannot follow a number after a space. Write a duration without the space, as in ${duration}, and anything else, such as a size, as a string, as in '${text}'`;
	const cases: Array<[source: string, reason: string]> = [
		['a: 1.5 us', reason('1.5us', '1.5 us')],
		['a: -5 m', reason('-5m', '-5 m')],
		['a: 1_000 ms', reason('1_000ms', '1_000 ms')],
		['a: 2562047 h', reason('2562047h', '2562047 h')],
		// Not a whole number of nanoseconds.
		['a: 1.5 ns', reason('10s', '1.5 ns')],
		['a: 0.0000000001 s', reason('10s', '0.0000000001 s')],
		// Zero has no negative spelling.
		['a: -0.0 s', reason('10s', '-0.0 s')],
		// Outside the 64-bit range of nanoseconds.
		['a: 2562048 h', reason('10s', '2562048 h')],
		['a: 3000000 h', reason('10s', '3000000 h')],
		// An exponent or a radix prefix cannot be part of a duration.
		['a: 1e3 ms', reason('10s', '1e3 ms')],
		['a: 0x10 s', reason('10s', '0x10 s')],
	];

	for (const [source, expected] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, expected);
		});
	}

	test('every suggested duration is valid', () => {
		for (const number of ['1', '-1', '0', '0.5', '1.5', '-1.5', '1_000', '1e3', '0x1F', '0o7', '0b1', '-0.0', '9223372036854775807', '0.000000001', '0.0000000001']) {
			for (const unit of ['h', 'm', 's', 'ms', 'us', 'ns']) {
				const duration = /(?<=as in )\S+(?=,)/v.exec(catchParseError(`a: ${number} ${unit}`).reason)![0];
				parse(`a: ${duration}`);
			}
		}
	});
});

suite('a duration in microseconds written with µ is only suggested with us when it is valid', () => {
	const cases: Array<[source: string, reason: string]> = [
		['a: 1µs', 'The unit for microseconds is written us, as in 1us'],
		['a: -1_000μs', 'The unit for microseconds is written us, as in -1_000us'],
		['a: 0.001µs', 'The unit for microseconds is written us, as in 0.001us'],
		// Not a whole number of nanoseconds.
		['a: 1.0005µs', 'The unit for microseconds is written us'],
		// Zero has no negative spelling.
		['a: -0.0µs', 'The unit for microseconds is written us'],
		// An exponent or a radix prefix cannot be part of a duration.
		['a: 1e3µs', 'The unit for microseconds is written us'],
		['a: 0x10µs', 'The unit for microseconds is written us'],
		// Outside the 64-bit range of nanoseconds.
		['a: 9223372036854775µs', 'The unit for microseconds is written us, as in 9223372036854775us'],
		['a: 9223372036854776µs', 'The unit for microseconds is written us'],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, reason);
			const duration = /(?<=as in )\S+$/v.exec(reason)?.[0];

			if (duration !== undefined) {
				parse(`a: ${duration}`);
			}
		});
	}
});

suite('a table header is only reported where a table could be written instead', () => {
	const tableHeader = (name: string) => `There are no table headers. Write the table as an object, as in ${name}: {…}`;
	const cases: Array<[source: string, reason: string]> = [
		['[server]\nport: 1', tableHeader('server')],
		['# The server.\n[server]\nport: 1', tableHeader('server')],
		['\t[server]\nport: 1', tableHeader('server')],
		['[[servers]]\nport: 1', tableHeader('servers')],
		['a: 1\n[server]\nport: 1', tableHeader('server')],
		['a: {\n\t[server]\n}', tableHeader('server')],
		// An item of a nested array cannot be a member, so a word in brackets there is an unquoted string.
		['roles: [\n\t[admin]\n]', 'Unexpected “admin”. A string value must be quoted, as in \'admin\''],
		['a: [\n\t1,\n\t[x]\n]', 'Unexpected “x”. A string value must be quoted, as in \'x\''],
		['[\n\t1,\n\t[x]\n]', 'Unexpected “x”. A string value must be quoted, as in \'x\''],
		['[\n\t[[x]]\n]', 'Unexpected “x”. A string value must be quoted, as in \'x\''],
		// A value left out before a word in brackets on the next line, as YAML nests a flow sequence, is not a table either.
		['a:\n[server]\nport: 1', 'Unexpected “server”. A string value must be quoted, as in \'server\''],
		['a:\n  [server]', 'Unexpected “server”. A string value must be quoted, as in \'server\''],
		['{a:\n[server]\n}', 'Unexpected “server”. A string value must be quoted, as in \'server\''],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, reason);
		});
	}
});

suite('a table header is only reported for a name that is a valid key', () => {
	const tableHeader = (name: string) => `There are no table headers. Write the table as an object, as in ${name}: {…}`;
	const cases: Array<[source: string, reason: string]> = [
		['[a-b_c]\nport: 1', tableHeader('a-b_c')],
		// A bare key cannot contain a dot.
		['[a.b]\nport: 1', 'Unexpected “a”. A string value must be quoted, as in \'a.b\''],
		['[[a.b]]\nport: 1', 'Unexpected “a”. A string value must be quoted, as in \'a.b\''],
		['[a.]\nport: 1', 'Unexpected “a”. A string value must be quoted, as in \'a.\''],
		['x: 1\n[a.b]\nport: 1', 'Expected a key, but found “[”'],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, reason);
		});
	}

	test('every suggested key is valid', () => {
		for (const name of ['a', 'a.b', 'a.b.c', 'a-b', '_a', 'a..b', 'a.', 'a.b.', 'a...b']) {
			const suggestion = /(?<=as in )\S+(?=: \{…\})/v.exec(catchParseError(`[${name}]\nport: 1`).reason)?.[0];

			if (suggestion === undefined) {
				continue;
			}

			assert.equal(suggestion, name);
			parse(`${suggestion}: {port: 1}`);
		}
	});
});

suite('the keys in the suggestion for an indented key are written as in a document', () => {
	const cases: Array<[source: string, reason: string]> = [
		['server:\n  port: 80', 'Expected a value, but found the key port. Indentation does not nest objects, so write server: {port: …}'],
		['\'a.b\':\n  \'c.d\': 1', 'Expected a value, but found the key "c.d". Indentation does not nest objects, so write \'a.b\': {\'c.d\': …}'],
		['\'the server\':\n  \'the port\': 80', 'Expected a value, but found the key "the port". Indentation does not nest objects, so write \'the server\': {\'the port\': …}'],
		['"it\'s":\n  b: 1', 'Expected a value, but found the key b. Indentation does not nest objects, so write "it\'s": {b: …}'],
		[String.raw`"a\u{1}":` + '\n  b: 1', String.raw`Expected a value, but found the key b. Indentation does not nest objects, so write "a\u{1}": {b: …}`],
		['a:\n  ' + String.raw`"\u{8}\u{c}\u{7f}": 1`, String.raw`Expected a value, but found the key "\b\f` + '\u{FFFD}' + String.raw`". Indentation does not nest objects, so write a: {"\u{8}\u{c}\u{7f}": …}`],
		['a:\n  "b\\\\c": 1', String.raw`Expected a value, but found the key "b\\c". Indentation does not nest objects, so write a: {'b\c': …}`],
	];

	for (const [source, reason] of cases) {
		test(JSON.stringify(source), () => {
			assert.equal(catchParseError(source).reason, reason);
		});
	}

	test('the suggestion is a valid document with the value nested under the key', () => {
		for (const [parent, child] of [['a', 'b'], ['\'a b\'', String.raw`"c\u{1}"`], [String.raw`"\u{7f}"`, String.raw`"\t"`], ['\'x.y\'', '\'é😀\'']]) {
			const match = /so write (?<braced>.+): \{(?<inner>.+): …\}$/v.exec(catchParseError(`${parent}:\n  ${child}: 1`).reason)!.groups!;
			assert.deepEqual(parse(`${match['braced']!}: {${match['inner']!}: 1}`), parse(`${parent}: {${child}: 1}`));
		}
	});
});

suite('every fix that an error suggests is valid', () => {
	/*
	The documents that each fix in a reason makes, where the fix is a value, a key, or an escape. A fix cut short with "…" is left out, because it is not the whole fix.
	*/
	function suggestedDocuments(reason: string): string[] {
		const documents: string[] = [];
		const add = (document: string) => {
			if (!document.includes('…')) {
				documents.push(document);
			}
		};

		for (const pattern of [
			/(?<=as in )(?<value>'[^\n']*')(?=$|[,.] | for )/gv,
			// An offset, as in "written with a colon, as in +07:00", is part of an instant, not a value.
			/(?<=as in )(?![+\-]\d{2}:\d{2}$)(?<value>[^\s']+)(?=, and anything else|$)/gv,
			/(?<=uppercase: )(?<value>0x\S+)$/gv,
			/(?<=as )(?<value>0o\S+)(?=, and)/gv,
			/(?<=Write it as )(?<value>\S+)(?= or \S+$)/gv,
			/(?<=Write it as \S+ or )(?<value>\S+)$/gv,
			/(?<=Use )(?<value>-?infinity)(?= if you mean it)/gv,
		]) {
			for (const match of reason.matchAll(pattern)) {
				add(`a: ${match.groups!['value']!}`);
			}
		}

		for (const match of reason.matchAll(/(?<=as in )(?<value>\S+)(?=Z for UTC)/gv)) {
			add(`a: ${match.groups!['value']!}Z`);
		}

		for (const match of reason.matchAll(/(?<=[Ww]rite )(?<escape>\\u\{[\da-f]+\})/gv)) {
			add(`a: "${match.groups!['escape']!}"`);
		}

		const indentation = /so write (?<parent>.+): \{(?<child>.+): …\}$/v.exec(reason)?.groups;

		if (indentation !== undefined) {
			add(`${indentation['parent']!}: {${indentation['child']!}: 1}`);
		}

		const table = /as in (?<name>.+): \{…\}$/v.exec(reason)?.groups;

		if (table !== undefined) {
			add(`${table['name']!}: {}`);
		}

		const dot = /Quote it, as in (?<key>'.+'), or use braces to nest, as in (?<nested>.+): …(?<closing>\}*)$/v.exec(reason)?.groups;

		if (dot !== undefined) {
			add(`${dot['key']!}: 1`);
			add(`${dot['nested']!}: 1${dot['closing']!}`);
		}

		return documents;
	}

	/*
	Each valid conformance case with a piece inserted, or with a piece in place of one to three characters, at seeded random positions.
	*/
	function createMutations(): string[] {
		const root = path.join(import.meta.dirname, 'conformance', 'valid');
		const files = fs.readdirSync(root, {recursive: true, encoding: 'utf8'}).filter(file => file.endsWith('.soml') && !/\.(?:canonical|formatted)\.soml$/v.test(file)).toSorted();
		// Pieces that make the mistakes that the errors suggest fixes for.
		const pieces = [' ', '\n', '\n  ', ',', ':', '.', '..', '\'', '"', '#', '\\', '-', '_', '0', '00', '1', '9', 'a', 'e', 'x', 'T', ' T', 'Z', 'z', 's', 'm', 'h', ' h', ' ms', ' s', ' ns', 'µs', '0x', '0o', 'f', String.raw`\u00`, String.raw`\u{0`, String.raw`\u{1}`, '[', ']', '[a]', '[a..b]', ' 14:00:00', ':00', '+02:00', '-00:00', ',000', '0000'];
		const random = createRandom(1);

		return files.flatMap(file => {
			const original = fs.readFileSync(path.join(root, file), 'utf8');

			return Array.from({length: 25}, () => {
				const position = random.integer(0, original.length);
				const piece = random.pick(pieces);
				return original.slice(0, position) + piece + original.slice(random.boolean() ? position : position + random.integer(1, 3));
			});
		});
	}

	/*
	The error that parsing `text` throws, or `undefined` when it is valid.
	*/
	function getError(text: string): unknown {
		try {
			parse(text);
			return undefined;
		} catch (error) {
			return error;
		}
	}

	test('in the errors for mutations of every valid conformance case', () => {
		let checked = 0;

		for (const mutated of createMutations()) {
			const error = getError(mutated);

			if (error === undefined) {
				continue;
			}

			assert.ok(error instanceof ParseError, `${JSON.stringify(mutated)} threw an error that is not a ParseError`);

			for (const document of suggestedDocuments(error.reason)) {
				checked++;
				assert.equal(getError(document), undefined, `The error for ${JSON.stringify(mutated)}, ${JSON.stringify(error.reason)}, suggests ${JSON.stringify(document)}, which is invalid`);
			}
		}

		// The mutations reach the suggestions, so the test checks something.
		assert.ok(checked > 1000, `only ${checked} suggestions were checked`);
	});
});

suite('the position is consistent with the offset', () => {
	const tokens = ['{', '}', '[', ']', ',', ':', '\n', ' ', '\t', '# c\n', '/* c */', '\'', '"', '\\', '1', '-1', '0xFF', 'true', 'null', '2026-01-01T00:00:00Z', 'a.b', '\'k k\'', '😀', '\u{FEFF}', '\u{2028}', '\r', '\u{0}', '+', '.', 'e', String.raw`"\u{41}"`];
	const random = createRandom(17);

	const getError = (text: string): ParseError | undefined => {
		try {
			parse(text);
			return undefined;
		} catch (error) {
			return error instanceof ParseError ? error : undefined;
		}
	};

	/*
	The number of Unicode scalar values in `text`, as the column counts them.
	*/
	const countCodePoints = (text: string): number => {
		let count = 0;

		for (let index = 0; index < text.length; index++) {
			const code = text.charCodeAt(index);

			if (code >= 0xD8_00 && code <= 0xDB_FF) {
				const next = text.charCodeAt(index + 1);

				if (next >= 0xDC_00 && next <= 0xDF_FF) {
					index++;
				}
			}

			count++;
		}

		return count;
	};

	test('line, column, and message are computed from the offset', () => {
		let checked = 0;

		for (let round = 0; round < 2000; round++) {
			const text = Array.from({length: random.integer(1, 16)}, () => random.pick(tokens)).join('');
			const error = getError(text);

			if (error === undefined) {
				continue;
			}

			checked++;
			assert.ok(error.offset >= 0, JSON.stringify(error.offset));
			assert.ok(error.offset <= text.length, JSON.stringify(error.offset));
			let line = 1;
			let lineStart = 0;

			for (let index = text.indexOf('\n'); index !== -1 && index < error.offset; index = text.indexOf('\n', index + 1)) {
				line++;
				lineStart = index + 1;
			}

			assert.equal(error.line, line, JSON.stringify(text));
			assert.equal(error.column, countCodePoints(text.slice(lineStart, error.offset)) + 1, JSON.stringify(text));
			assert.equal(error.message, `${error.reason} at line ${error.line}, column ${error.column}\n\n${error.codeFrame}`, JSON.stringify(text));
		}

		// The token soup reaches the errors, so the test checks something.
		assert.ok(checked > 300, `only ${checked} errors were reached`);
	});
});

suite('Errors that do not mislead', () => {
	test('the value of a Unicode escape with uppercase digits is checked before its spelling, so that lowercasing the digits never gives an escape that is not allowed either', () => {
		for (const [source, reason] of [
			[String.raw`a: "\u{D}"`, String.raw`A carriage return (U+000D) cannot be represented, so \u{D} is not allowed`],
			[String.raw`a: "\u{00D}"`, String.raw`A carriage return (U+000D) cannot be represented, so \u{00D} is not allowed`],
			[String.raw`a: "\u{D800}"`, String.raw`\u{D800} is a surrogate, which is not a Unicode scalar value`],
			[String.raw`a: "\u{dFfF}"`, String.raw`\u{dFfF} is a surrogate, which is not a Unicode scalar value`],
			[String.raw`a: "\u{FFFFFF}"`, String.raw`\u{FFFFFF} is above U+10FFFF, the largest Unicode scalar value`],
			[String.raw`a: "\u{11000F}"`, String.raw`\u{11000F} is above U+10FFFF, the largest Unicode scalar value`],
			['a: """\n\t\\u{D}\n\t"""', String.raw`A carriage return (U+000D) cannot be represented, so \u{D} is not allowed`],
			[String.raw`"\u{D}": 1`, String.raw`A carriage return (U+000D) cannot be represented, so \u{D} is not allowed`],
			[String.raw`a: "\u{E9}"`, 'A Unicode escape uses lowercase hexadecimal digits'],
			[String.raw`a: "\u{1F600}"`, 'A Unicode escape uses lowercase hexadecimal digits'],
			[String.raw`a: "\u{10FFFF}"`, 'A Unicode escape uses lowercase hexadecimal digits'],
			[String.raw`a: "\u{00E9}"`, 'A Unicode escape uses lowercase hexadecimal digits'],
			[String.raw`a: "\u{D7FF}"`, 'A Unicode escape uses lowercase hexadecimal digits'],
			[String.raw`a: "\u{E000}"`, 'A Unicode escape uses lowercase hexadecimal digits'],
			[String.raw`a: "\u{C}"`, 'A Unicode escape uses lowercase hexadecimal digits'],
			[String.raw`a: "\u{FFFFFFF}"`, 'A Unicode escape uses lowercase hexadecimal digits'],
			[String.raw`a: "\u{1234567}"`, 'A Unicode escape has at most six hexadecimal digits'],
		] as const) {
			assert.equal(catchParseError(source).reason, reason, source);
		}
	});

	test('an offset after a space is the offset an instant was meant in, so the instant is not a local time to quote as a string', () => {
		for (const [source, reason] of [
			['a: 2026-09-19T14:00:00 Z', 'An instant\'s offset follows its time directly, without a space, as in 2026-09-19T14:00:00Z'],
			['a: 2026-09-19T14:00:00 +02:00', 'An instant\'s offset follows its time directly, without a space, as in 2026-09-19T14:00:00+02:00'],
			['a: 2026-09-19T14:00:00.5 -07:30', 'An instant\'s offset follows its time directly, without a space, as in 2026-09-19T14:00:00.5-07:30'],
			['a: 2026-09-19T14:00:00\t\tZ # note', 'An instant\'s offset follows its time directly, without a space, as in 2026-09-19T14:00:00Z'],
			['a: [2026-09-19T14:00:00 Z, 1]', 'An instant\'s offset follows its time directly, without a space, as in 2026-09-19T14:00:00Z'],
			['a: {b: 2026-09-19T14:00:00 Z}', 'An instant\'s offset follows its time directly, without a space, as in 2026-09-19T14:00:00Z'],
			['a: [\n\t2026-09-19T14:00:00 Z\n]', 'An instant\'s offset follows its time directly, without a space, as in 2026-09-19T14:00:00Z'],
			['a: 2026-02-30T14:00:00 Z', 'An instant\'s offset follows its time directly, without a space'],
			['a: 0001-01-01T00:00:00 +00:01', 'An instant\'s offset follows its time directly, without a space'],
			['a: 2026-09-19T14:00:00 +24:00', 'An instant\'s offset follows its time directly, without a space'],
			['a: 2026-09-19T14:00:00 +02:00 # é', 'An instant\'s offset follows its time directly, without a space, as in 2026-09-19T14:00:00+02:00'],
			['a: 2026-09-19T14:00:00', 'An instant needs an offset: Z or ±HH:MM. A date and time without an offset is a local time, which is not an instant, so write it as a string, as in \'2026-09-19T14:00:00\', or add the offset it was meant in'],
			['a: 2026-09-19T14:00:00 # Z', 'An instant needs an offset: Z or ±HH:MM. A date and time without an offset is a local time, which is not an instant, so write it as a string, as in \'2026-09-19T14:00:00\', or add the offset it was meant in'],
			['a: 2026-09-19T14:00:00 Zulu', 'An instant needs an offset: Z or ±HH:MM. A date and time without an offset is a local time, which is not an instant, so write it as a string, as in \'2026-09-19T14:00:00\', or add the offset it was meant in'],
			['a: 2026-09-19T14:00:00 +02:00:00', 'An instant needs an offset: Z or ±HH:MM. A date and time without an offset is a local time, which is not an instant, so write it as a string, as in \'2026-09-19T14:00:00\', or add the offset it was meant in'],
			['a: 2026-09-19T14:00:00 +0200', 'An instant needs an offset: Z or ±HH:MM. A date and time without an offset is a local time, which is not an instant, so write it as a string, as in \'2026-09-19T14:00:00\', or add the offset it was meant in'],
			['a: 2026-09-19T14:00:00\nZ: 1', 'An instant needs an offset: Z or ±HH:MM. A date and time without an offset is a local time, which is not an instant, so write it as a string, as in \'2026-09-19T14:00:00\', or add the offset it was meant in'],
			['a: 2026-09-19T14:00 Z', 'Invalid instant “2026-09-19T14:00”. An instant is written as 2026-09-19T14:00:00Z, with an optional fraction of up to nine digits and an offset of Z or ±HH:MM'],
			['a: 2026-09-19T14:00:00Z Z', 'Expected a line break before the next entry, but found “Z”'],
			['a: 2026-09-19T14:00:00 Montréal', 'An instant needs an offset: Z or ±HH:MM. A date and time without an offset is a local time, which is not an instant, so write it as a string, as in \'2026-09-19T14:00:00\', or add the offset it was meant in'],
			['a: 2026-09-19T14:00:00 é', 'An instant needs an offset: Z or ±HH:MM. A date and time without an offset is a local time, which is not an instant, so write it as a string, as in \'2026-09-19T14:00:00\', or add the offset it was meant in'],
			['a: [2026-09-19 😀😀]', '2026-09-19 is a date, not an instant. Write a date as a string, as in \'2026-09-19\'. An instant needs a time and an offset, as in 2026-09-19T00:00:00Z'],
			['a: 2026-09-19 Montréal', '2026-09-19 is a date, not an instant. Write a date as a string, as in \'2026-09-19\'. An instant needs a time and an offset, as in 2026-09-19T00:00:00Z'],
			['a: 2026-09-19T14:00 x日本', 'Invalid instant “2026-09-19T14:00”. An instant is written as 2026-09-19T14:00:00Z, with an optional fraction of up to nine digits and an offset of Z or ±HH:MM'],
			['a: 2026-09-19T14:00:00 Zé', 'An instant needs an offset: Z or ±HH:MM. A date and time without an offset is a local time, which is not an instant, so write it as a string, as in \'2026-09-19T14:00:00\', or add the offset it was meant in'],
			['a: 2026-09-19T14:00:00 +02:0é', 'An instant needs an offset: Z or ±HH:MM. A date and time without an offset is a local time, which is not an instant, so write it as a string, as in \'2026-09-19T14:00:00\', or add the offset it was meant in'],
			['a: 1979-05-27 07:32:00 Z', 'The date and time separator in an instant is an uppercase “T”, not a space, and an instant needs the offset it was meant in, as in 1979-05-27T07:32:00Z for UTC. A date and time without an offset is a local time, which is not an instant, so write it as a string, as in \'1979-05-27 07:32:00\''],
		] as const) {
			assert.equal(catchParseError(source).reason, reason, source);
		}
	});

	test('a value with a “:” that starts with a zero, such as a MAC address, is not a number with a leading zero', () => {
		for (const [source, reason] of [
			['mac: 00:1A:2B:3C:4D:5E', 'Invalid number “00:1A:2B:3C:4D:5E”. A string value must be quoted, as in \'00:1A:2B:3C:4D:5E\''],
			['mac: 01:23:45:67:89:AB', 'Invalid number “01:23:45:67:89:AB”. A string value must be quoted, as in \'01:23:45:67:89:AB\''],
			['a: 0123:abcd::1', 'Invalid number “0123:abcd::1”. A string value must be quoted, as in \'0123:abcd::1\''],
			['a: [00:1A:2B, 1]', 'Invalid number “00:1A:2B”. A string value must be quoted, as in \'00:1A:2B\''],
			['a: -01:30', 'Invalid number “-01:30”'],
			['a: 01', 'Leading zeros are not allowed in a decimal number. Write an octal number, such as a file mode, as 0o1, and an identifier, such as a ZIP code, as a string: \'01\''],
			['a: 01A', 'Leading zeros are not allowed in a decimal number'],
			['a: 00.5', 'Leading zeros are not allowed in a decimal number'],
			['a: 00:11:22:33:44:55', 'Invalid number “00:11:22:33:44:55”. A value that contains “:” must be quoted, as in \'00:11:22:33:44:55\''],
			['a: 08:30', 'A time of day is a string, so it must be quoted'],
			['a: 1:', 'Invalid number “1:”'],
			['a: 2001:db8::1', 'Invalid number “2001:db8::1”. A string value must be quoted, as in \'2001:db8::1\''],
		] as const) {
			assert.equal(catchParseError(source).reason, reason, source);
		}
	});

	test('a duration in years is reported as one, as one in days or weeks is, and a word that only starts with a year unit is a string to quote', () => {
		for (const [source, reason] of [
			['a: 1y', 'Invalid duration 1y: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: [1y, 1]', 'Invalid duration 1y: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: 2years', 'Invalid duration 2years: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: [2years, 1]', 'Invalid duration 2years: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: 1year', 'Invalid duration 1year: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: [1year, 1]', 'Invalid duration 1year: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: 3yr', 'Invalid duration 3yr: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: [3yr, 1]', 'Invalid duration 3yr: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: 3yrs', 'Invalid duration 3yrs: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: [3yrs, 1]', 'Invalid duration 3yrs: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: 1Y', 'Invalid duration 1Y: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: [1Y, 1]', 'Invalid duration 1Y: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: 1YEAR', 'Invalid duration 1YEAR: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: [1YEAR, 1]', 'Invalid duration 1YEAR: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: 1.5y', 'Invalid duration 1.5y: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: [1.5y, 1]', 'Invalid duration 1.5y: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: 1_000y', 'Invalid duration 1_000y: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: [1_000y, 1]', 'Invalid duration 1_000y: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: -1y', 'Invalid duration -1y: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: [-1y, 1]', 'Invalid duration -1y: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: 1y6m', 'Invalid duration 1y6m: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: [1y6m, 1]', 'Invalid duration 1y6m: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: 1h1y', 'Invalid duration 1h1y: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: [1h1y, 1]', 'Invalid duration 1h1y: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: 1y1y', 'Invalid duration 1y1y: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: [1y1y, 1]', 'Invalid duration 1y1y: there is no year unit, because a year is not a fixed length. Write 8760h for a fixed 365 days'],
			['a: 100yen', 'Invalid number “100yen”. A string value must be quoted, as in \'100yen\''],
			['a: 1yard', 'Invalid number “1yard”. A string value must be quoted, as in \'1yard\''],
			['a: 5yo', 'Invalid number “5yo”. A string value must be quoted, as in \'5yo\''],
			['a: 1yrsx', 'Invalid number “1yrsx”. A string value must be quoted, as in \'1yrsx\''],
			['a: 1yearsx', 'Invalid number “1yearsx”. A string value must be quoted, as in \'1yearsx\''],
			['a: 1y.5', 'Invalid number “1y.5”. A string value must be quoted, as in \'1y.5\''],
			['a: 1 y', 'A unit cannot follow a number after a space. Write a duration without the space, as in 10s, and anything else, such as a size, as a string, as in \'1 y\''],
		] as const) {
			assert.equal(catchParseError(source).reason, reason, source);
		}
	});

	test('only a number ends with its exponent marker, so a word that ends with an “e” has no exponent', () => {
		for (const [source, reason] of [
			['a: 7zip-bin-name', 'Invalid number “7zip-bin-name”. A string value must be quoted, as in \'7zip-bin-name\''],
			['a: 1byte', 'Invalid number “1byte”. A string value must be quoted, as in \'1byte\''],
			['a: 3-phase', 'Invalid number “3-phase”. A string value must be quoted, as in \'3-phase\''],
			['a: 1-time', 'Invalid number “1-time”. A string value must be quoted, as in \'1-time\''],
			['a: [100-pre, 1]', 'Invalid number “100-pre”. A string value must be quoted, as in \'100-pre\''],
			['a: 2e-e', 'Invalid number “2e-e”. A string value must be quoted, as in \'2e-e\''],
			['a: -verbose', 'Expected a digit or “infinity” after “-”'],
			['args: [-recursive]', 'Expected a digit or “infinity” after “-”'],
			['a: 1e', 'Expected digits after the exponent marker “e”'],
			['a: 1e-', 'Expected digits after the exponent marker “e”'],
			['a: -1e', 'Expected digits after the exponent marker “e”'],
			['a: 1.5e', 'Expected digits after the exponent marker “e”'],
			['a: 1.5e-', 'Expected digits after the exponent marker “e”'],
			['a: -1_0.5_0e', 'Expected digits after the exponent marker “e”'],
			['a: 0e', 'Expected digits after the exponent marker “e”'],
			['a: 0.0e-', 'Expected digits after the exponent marker “e”'],
		] as const) {
			assert.equal(catchParseError(source).reason, reason, source);
		}
	});

	test('a word after “-” is only NaN or infinity when it is the whole word, as for one without the “-”', () => {
		for (const [source, reason] of [
			['a: -nano', 'Expected a digit or “infinity” after “-”'],
			['a: -nanny', 'Expected a digit or “infinity” after “-”'],
			['a: -info', 'Expected a digit or “infinity” after “-”'],
			['a: -INFO', 'Expected a digit or “infinity” after “-”'],
			['args: [-inform, PEM]', 'Expected a digit or “infinity” after “-”'],
			['a: -infinite', 'Expected a digit or “infinity” after “-”'],
			['a: -infinityx', 'Expected a digit or “infinity” after “-”'],
			['a: nano', 'Unexpected “nano”. A string value must be quoted, as in \'nano\''],
			['a: info', 'Unexpected “info”. A string value must be quoted, as in \'info\''],
			['a: -nan', 'NaN is not representable. Use null for a missing value'],
			['a: -NaN', 'NaN is not representable. Use null for a missing value'],
			['a: -NAN', 'NaN is not representable. Use null for a missing value'],
			['a: -inf', '“-inf” is not a value. Negative infinity is written -infinity'],
			['a: -Inf', '“-Inf” is not a value. Negative infinity is written -infinity'],
			['a: -INF', '“-INF” is not a value. Negative infinity is written -infinity'],
			['a: -Infinity', '“-Infinity” is not a value. Negative infinity is written -infinity'],
			['a: -INFINITY', '“-INFINITY” is not a value. Negative infinity is written -infinity'],
			['a: [-inf, 1]', '“-inf” is not a value. Negative infinity is written -infinity'],
			['a: [-Infinity, 1]', '“-Infinity” is not a value. Negative infinity is written -infinity'],
		] as const) {
			assert.equal(catchParseError(source).reason, reason, source);
		}
	});

	test('a “/” only ends a value for a suggestion when it starts a comment, so a suggestion never leaves out the text after it', () => {
		for (const [source, reason] of [
			['speed: 100 km/h', 'Expected a line break before the next entry, but found “k”'],
			['a: 5 m/s', 'Expected a line break before the next entry, but found “m”'],
			['a: [5 m/s]', 'Expected “,”, a line break, or “]” after an array item, but found “m”'],
			['a: 2026-09-19T14:00:00/2026-09-20T15:00:00', 'An instant needs an offset: Z or ±HH:MM'],
			['a: [2026-09-19T14:00:00/P1D]', 'An instant needs an offset: Z or ±HH:MM'],
			['a: 2026-09-19T14:00:00 Z/x', 'An instant needs an offset: Z or ±HH:MM. A date and time without an offset is a local time, which is not an instant, so write it as a string, as in \'2026-09-19T14:00:00\', or add the offset it was meant in'],
			['a: 5 m /* c */', 'A unit cannot follow a number after a space. Write a duration without the space, as in 5m, and anything else, such as a size, as a string, as in \'5 m\''],
			['a: 5 m/* c */', 'A unit cannot follow a number after a space. Write a duration without the space, as in 5m, and anything else, such as a size, as a string, as in \'5 m\''],
			['a: 2026-09-19T14:00:00/* c */', 'An instant needs an offset: Z or ±HH:MM. A date and time without an offset is a local time, which is not an instant, so write it as a string, as in \'2026-09-19T14:00:00\', or add the offset it was meant in'],
			['a: 2026-09-19T14:00:00 Z/* c */', 'An instant\'s offset follows its time directly, without a space, as in 2026-09-19T14:00:00Z'],
			['a: 2026-09-19T14:00:00 Z /* c */', 'An instant\'s offset follows its time directly, without a space, as in 2026-09-19T14:00:00Z'],
			['timeout: 5 s // seconds', 'A unit cannot follow a number after a space. Write a duration without the space, as in 5s, and anything else, such as a size, as a string, as in \'5 s\''],
			['a: 5 m//c', 'A unit cannot follow a number after a space. Write a duration without the space, as in 5m, and anything else, such as a size, as a string, as in \'5 m\''],
			['a: 2026-09-19T14:00:00 Z//c', 'An instant\'s offset follows its time directly, without a space, as in 2026-09-19T14:00:00Z'],
		] as const) {
			assert.equal(catchParseError(source).reason, reason, source);
		}
	});

	test('an underscore next to a letter is part of a word, not a misplaced separator in a number', () => {
		for (const [source, reason] of [
			['a: 4k_video', 'Invalid number “4k_video”. A string value must be quoted, as in \'4k_video\''],
			['a: 2x_speed', 'Invalid number “2x_speed”. A string value must be quoted, as in \'2x_speed\''],
			['a: [5k_run, 2]', 'Invalid number “5k_run”. A string value must be quoted, as in \'5k_run\''],
			['a: 1_', 'An underscore in a number must be between two digits'],
			['a: 1__0', 'An underscore in a number must be between two digits'],
			['a: 1_.5', 'An underscore in a number must be between two digits'],
			['a: 1._5', 'An underscore in a number must be between two digits'],
			['a: 1_e5', 'An underscore in a number must be between two digits'],
			['a: 1e_5', 'An underscore in a number must be between two digits'],
			['a: 1e5_', 'An underscore in a number must be between two digits'],
			['a: 1.5_', 'An underscore in a number must be between two digits'],
			['a: -1_', 'An underscore in a number must be between two digits'],
			['a: 1_000_', 'An underscore in a number must be between two digits'],
			['a: 1e-_5', 'An underscore in a number must be between two digits'],
		] as const) {
			assert.equal(catchParseError(source).reason, reason, source);
		}
	});

	test('an uppercase “E” is only an exponent marker where one goes, so in a word such as `5EUR` it is not', () => {
		for (const [source, reason] of [
			['price: 5EUR', 'Invalid number “5EUR”. A string value must be quoted, as in \'5EUR\''],
			['disk: 10EB', 'Invalid number “10EB”. A string value must be quoted, as in \'10EB\''],
			['a: 1.5Ex', 'Invalid number “1.5Ex”. A string value must be quoted, as in \'1.5Ex\''],
			['a: [3ED, 1]', 'Invalid number “3ED”. A string value must be quoted, as in \'3ED\''],
			['a: 1E5', 'An exponent marker is a lowercase “e”'],
			['a: 1E10', 'An exponent marker is a lowercase “e”'],
			['a: 1.5E-3', 'An exponent marker is a lowercase “e”'],
			['a: -2E7', 'An exponent marker is a lowercase “e”'],
			['a: 1_0E1_0', 'An exponent marker is a lowercase “e”'],
			['a: 1E', 'An exponent marker is a lowercase “e”'],
			['a: 2E-', 'An exponent marker is a lowercase “e”'],
			['a: 1.5E', 'An exponent marker is a lowercase “e”'],
		] as const) {
			assert.equal(catchParseError(source).reason, reason, source);
		}
	});
});
