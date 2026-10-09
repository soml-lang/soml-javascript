import {findLineEnd} from './shared.ts';

const CONTEXT_LINES = 2;
const MAX_LINE_WIDTH = 100;

// With the `v` flag, a surrogate in the class matches only when it is unpaired.
const UNPRINTABLE = /[\p{Bidi_Control}\u{D800}-\u{DFFF}[\p{Control}--\t]]/gv;

/**
Thrown when the input is not a valid document, by `parse()`, `parseTree()`, `format()`, and `edit()`. Extends `SyntaxError`.

The `message` includes the position and a code frame. Use `reason` for the message alone.

@example
```
import {parse, ParseError} from 'soml-lang';

try {
	parse('name: api-gateway');
} catch (error) {
	if (error instanceof ParseError) {
		console.log(error.message);
	}
}
// Unexpected "api-gateway". A string value must be quoted, as in 'api-gateway' at line 1, column 7
//
// > 1 | name: api-gateway
//     |       ^
```
*/
export class ParseError extends SyntaxError {
	/**
	For the parser, which cannot call the private constructor.

	@internal
	*/
	static create(reason: string, source: string, offset: number): ParseError {
		return new ParseError(reason, source, offset);
	}

	override readonly name = 'ParseError';

	/**
	What is wrong, without the position.
	*/
	readonly reason: string;

	/**
	The 1-based line of the error.
	*/
	readonly line: number;

	/**
	The 1-based column of the error, counted in Unicode code points.
	*/
	readonly column: number;

	/**
	The 0-based UTF-16 index of the error in the decoded text.
	*/
	readonly offset: number;

	/**
	Up to three lines ending at the error, with a caret under the position. A long line is clipped around the position.
	*/
	readonly codeFrame: string;

	/**
	Only the parser creates a `ParseError`.
	*/
	private constructor(reason: string, source: string, offset: number) {
		const sanitizedReason = sanitize(reason);
		const {line, column} = locate(source, offset);
		const codeFrame = createCodeFrame(source, offset, line);
		super(`${sanitizedReason} at line ${line}, column ${column}\n\n${codeFrame}`);
		this.reason = sanitizedReason;
		this.line = line;
		this.column = column;
		this.offset = offset;
		this.codeFrame = codeFrame;
	}
}

/*
Line and column are 1-based, and the column counts code points, so an emoji is one column.
*/
function locate(source: string, offset: number): {line: number; column: number} {
	let line = 1;
	let lineStart = 0;

	// A line feed at `offset` ends the error's line, so it does not start a new one, the same as in `createCodeFrame()`.
	for (let index = source.indexOf('\n'); index !== -1 && index < offset; index = source.indexOf('\n', index + 1)) {
		line++;
		lineStart = index + 1;
	}

	return {line, column: countCodePoints(source.slice(lineStart, offset)) + 1};
}

function countCodePoints(string: string): number {
	let count = 0;

	for (let index = 0; index < string.length; index++) {
		const code = string.charCodeAt(index);

		// A high surrogate followed by a low one is one code point.
		if (code >= 0xD8_00 && code <= 0xDB_FF) {
			const next = string.charCodeAt(index + 1);

			if (next >= 0xDC_00 && next <= 0xDF_FF) {
				index++;
			}
		}

		count++;
	}

	return count;
}

function createCodeFrame(source: string, offset: number, line: number): string {
	// The error line and up to two lines before it, found by scanning back from the error, so that an error late in a long document does not split the whole document.
	const lineStarts = [offset === 0 ? 0 : source.lastIndexOf('\n', offset - 1) + 1];

	while (lineStarts.length <= CONTEXT_LINES && lineStarts[0]! > 0) {
		// Skip the line feed that ends the line before. `lastIndexOf()` reads a negative index as 0, where it would find that line feed again, so the line before one that starts at 1 starts at 0.
		const searchFrom = lineStarts[0]! - 2;
		lineStarts.unshift(searchFrom < 0 ? 0 : source.lastIndexOf('\n', searchFrom) + 1);
	}

	const firstLine = line - lineStarts.length + 1;
	const gutterWidth = String(line).length;
	const output: string[] = [];

	for (const [index, lineStart] of lineStarts.entries()) {
		const number = firstLine + index;
		const isErrorLine = number === line;
		const lineText = sanitize(source.slice(lineStart, findLineEnd(source, lineStart)));
		const {text, pointerOffset} = clip(lineText, isErrorLine ? offset - lineStart : 0);
		const gutter = `${isErrorLine ? '>' : ' '} ${String(number).padStart(gutterWidth)} |`;
		output.push(text === '' ? gutter : `${gutter} ${text}`);

		if (!isErrorLine) {
			continue;
		}

		// Keep the tabs from the line, so the caret lines up whatever the tab width is. With the `v` flag, a surrogate pair is one match, so the padding counts code points, as the column does.
		const padding = text.slice(0, pointerOffset).replaceAll(/[^\t]/gv, ' ');
		output.push(`  ${' '.repeat(gutterWidth)} | ${padding}^`);
	}

	return output.join('\n');
}

/*
The rejected text can hold characters that a terminal acts on rather than shows: control characters such as an escape or a carriage return, bidirectional controls, and lone surrogates. Each becomes U+FFFD, which is also one code unit, so the caret still lines up. Tabs are kept.
*/
function sanitize(text: string): string {
	return text.replaceAll(UNPRINTABLE, '\u{FFFD}');
}

/*
A long line, such as a minified document, is cut to a window around the pointer. The cut never splits a surrogate pair.
*/
function clip(text: string, pointerOffset: number): {text: string; pointerOffset: number} {
	if (text.length <= MAX_LINE_WIDTH) {
		return {text, pointerOffset};
	}

	let start = Math.max(0, Math.min(pointerOffset - (MAX_LINE_WIDTH / 2), text.length - MAX_LINE_WIDTH));
	let end = start + MAX_LINE_WIDTH;

	if (isLowSurrogate(text.charCodeAt(start))) {
		start++;
	}

	if (isLowSurrogate(text.charCodeAt(end))) {
		end--;
	}

	const prefix = start > 0 ? '…' : '';
	const suffix = end < text.length ? '…' : '';

	return {
		text: `${prefix}${text.slice(start, end)}${suffix}`,
		pointerOffset: pointerOffset - start + prefix.length,
	};
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xDC_00 && code <= 0xDF_FF;
}
