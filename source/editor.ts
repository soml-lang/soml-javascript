import {ParseError} from './error.ts';
import {
	Parser,
	Time,
	checkCharacters,
	parseWithTimes,
	type ParsedValue,
} from './parse.ts';
import {
	MAX_DEPTH,
	findBlockStringEnd,
	findLineEnd,
	isBareKey,
	isBareKeyCharacter,
	isSpace,
} from './shared.ts';

/**
Half-open UTF-16 offsets in the original source.
*/
export type EditorRange = readonly [start: number, end: number];

/**
Stable diagnostic categories; messages are intended for people.
*/
export type EditorDiagnosticCode =
	| 'invalid-document'
	| 'invalid-key'
	| 'invalid-value'
	| 'expected-colon'
	| 'expected-value'
	| 'expected-separator'
	| 'unexpected-token'
	| 'missing-close'
	| 'unterminated-string'
	| 'unterminated-comment'
	| 'duplicate-key'
	| 'depth-limit';

/**
An error in editor syntax, optionally referring to an earlier key or opening delimiter.
*/
export type EditorDiagnostic = {
	readonly code: EditorDiagnosticCode;
	readonly message: string;
	readonly range: EditorRange;
	readonly related?: ReadonlyArray<{readonly message: string; readonly range: EditorRange}>;
};

type Located<Type extends string> = {readonly type: Type; readonly range: EditorRange};

/**
A decoded key whose spelling is valid.
*/
export type EditorKey = Located<'EditorKey'> & {readonly key: string};
/**
A value that has not been written; its range is zero-width.
*/
export type EditorMissing = Located<'EditorMissing'> & {readonly expected: 'value'};
/**
Invalid source text, without an invented value.
*/
export type EditorError = Located<'EditorError'>;
/**
A key and its value, including incomplete members.
*/
export type EditorMember = Located<'EditorMember'> & {readonly key: EditorKey | EditorError; readonly value: EditorValue; readonly colonRange?: EditorRange};
/**
An object, retaining duplicate members in source order.
*/
export type EditorObject = Located<'EditorObject'> & {
	readonly braced: boolean;
	readonly members: ReadonlyArray<EditorMember | EditorError>;
	readonly closingRange?: EditorRange;
};
/**
An array. Recovered element positions are syntax positions, not guaranteed semantic indices.
*/
export type EditorArray = Located<'EditorArray'> & {readonly elements: readonly EditorValue[]; readonly closingRange?: EditorRange};
/**
A validated scalar spelling. Values are deliberately not exposed or evaluated.
*/
export type EditorScalar = Located<'EditorScalar'> & {readonly scalarKind: 'string' | 'int' | 'float' | 'bool' | 'null' | 'instant' | 'duration'};
/**
A recovered value, never an evaluable configuration value.
*/
export type EditorValue = EditorObject | EditorArray | EditorScalar | EditorMissing | EditorError;
/**
The entire source, including empty or invalid documents.
*/
export type EditorDocument = Located<'EditorDocument'> & {readonly children: ReadonlyArray<EditorObject | EditorArray | EditorError>};
/**
A node in a recovered tree, intentionally distinct from the strict Node union.
*/
export type EditorNode = EditorDocument | EditorMember | EditorKey | EditorValue;
/**
A lexical region. Whitespace remains available through gaps in the source.
*/
export type EditorToken = {readonly kind: 'punctuation' | 'key' | 'scalar' | 'string' | 'lineComment' | 'blockComment' | 'error'; readonly range: EditorRange};
/**
One editor-analysis snapshot; readonly types do not imply runtime freezing.
*/
export type EditorParseResult = {
	readonly text: string;
	readonly root: EditorDocument;
	readonly tokens: readonly EditorToken[];
	readonly diagnostics: readonly EditorDiagnostic[];
	readonly diagnosticsTruncated: boolean;
};

/**
Analyze possibly incomplete SOML for editor navigation. Malformed text returns diagnostics instead of throwing. This tree cannot be evaluated or used for formatting or editing data; keep using the strict APIs for those operations.

Ranges are half-open UTF-16 offsets in the unchanged input. Missing values have zero-width ranges. Unfinished containers omit `closingRange`. Ordinary unfinished strings stop at LF; unfinished block strings and comments consume through EOF. Recovery never infers nesting from indentation.

The first diagnostic is the strict parser's first failure, with code `invalid-document`. Additional recovery diagnostics follow in discovery order. At most 100 diagnostics are retained; `diagnosticsTruncated` indicates suppressed reports. No diagnostics means the input is strictly valid. This is a full-document parse, works without `Temporal`, and accepts decoded strings only.

@param text - The original document text.
@returns Recovered syntax, tokens, and bounded diagnostics, without evaluated values.
@throws {TypeError} When `text` is not a string.

@example
```
import {parseForEditor} from 'soml-lang';

const result = parseForEditor("host: 'localhost'\nport:\nsecure: true");
result.root.children[0];
//=> An EditorObject retaining host, port (with an EditorMissing value), and secure.
result.diagnostics[0]?.code;
//=> 'invalid-document'
```
*/
export function parseForEditor(text: string): EditorParseResult {
	if (typeof text !== 'string') {
		throw new TypeError('Expected a string');
	}

	const diagnostics: EditorDiagnostic[] = [];
	try {
		parseWithTimes(text);
	} catch (error) {
		if (!(error instanceof ParseError)) {
			throw error;
		}

		const width = (text.codePointAt(error.offset) ?? 0) > 0xFF_FF ? 2 : 1;
		diagnostics.push({code: 'invalid-document', message: error.reason, range: [error.offset, Math.min(text.length, error.offset + width)]});
	}

	return new EditorParser(text, diagnostics).parse();
}

/**
A lightweight internal failure, without constructing a stack or source frame during editor analysis.
*/
class EditorFailure {
	readonly reason: string;

	constructor(reason: string) {
		this.reason = reason;
	}
}

/**
Validate one isolated lexical atom using the same scalar rules as strict parsing.
*/
function readScalar(raw: string): ParsedValue {
	checkCharacters(raw, fail);
	return new Parser(raw, 'bigint', preserveTime, fail).parseScalar();
}

function preserveTime(time: Time): Time {
	return time;
}

function fail(reason: string): never {
	// eslint-disable-next-line @typescript-eslint/only-throw-error -- Private control flow avoids constructing a stack for every invalid editor scalar.
	throw new EditorFailure(reason);
}

class EditorParser {
	#index = 0;
	readonly #source: string;
	readonly #diagnostics: EditorDiagnostic[];
	readonly #tokens: EditorToken[] = [];
	readonly #closers: string[] = [];
	#truncated = false;

	constructor(source: string, diagnostics: EditorDiagnostic[]) {
		this.#source = source;
		this.#diagnostics = diagnostics;
	}

	#report(code: EditorDiagnosticCode, message: string, range: EditorRange, related?: EditorDiagnostic['related']): void {
		if (this.#diagnostics.length >= 100) {
			this.#truncated = true;
			return;
		}

		this.#diagnostics.push({
			code, message, range, ...(related && {related}),
		});
	}

	#token(kind: EditorToken['kind'], start: number): EditorRange {
		const range: EditorRange = [start, this.#index];
		this.#tokens.push({kind, range});
		return range;
	}

	#punctuation(): EditorRange {
		return this.#token('punctuation', this.#index++);
	}

	#trivia(): boolean {
		let isLineBreak = false;
		while (this.#index < this.#source.length) {
			const start = this.#index;
			const character = this.#source[this.#index];
			if (character === '\n' || isSpace(this.#source.charCodeAt(this.#index))) {
				isLineBreak ||= character === '\n';
				this.#index++;
			} else if (character === '#') {
				this.#index = findLineEnd(this.#source, start);
				this.#token('lineComment', start);
			} else if (this.#source.startsWith('/*', start)) {
				const closing = this.#source.indexOf('*/', start + 2);
				this.#index = closing === -1 ? this.#source.length : closing + 2;
				const range = this.#token('blockComment', start);
				if (closing === -1) {
					this.#report('unterminated-comment', 'Expected a closing block comment delimiter', range);
				}
			} else {
				break;
			}
		}

		return isLineBreak;
	}

	#stringEnd(start: number): number {
		const quote = this.#source[start]!;
		let end = start + 1;
		while (end < this.#source.length && this.#source[end] !== '\n') {
			if (this.#source[end] === quote) {
				return end + 1;
			}

			if (quote === '"' && this.#source[end] === '\\' && this.#source[end + 1] !== '\n') {
				end++;
			}

			end++;
		}

		return Math.min(end, this.#source.length);
	}

	#string(): EditorRange {
		const start = this.#index;
		const quote = this.#source[start]!;
		let delimiterLength = 1;
		while (this.#source[start + delimiterLength] === quote) {
			delimiterLength++;
		}

		if (delimiterLength >= 3) {
			const lineEnd = findLineEnd(this.#source, start);
			const closing = findBlockStringEnd(this.#source, lineEnd + 1, quote.charCodeAt(0), delimiterLength);
			this.#index = closing ? closing.delimiterStart + delimiterLength : this.#source.length;
			if (!closing) {
				this.#report('unterminated-string', 'Expected a closing block string delimiter', [start, this.#index]);
			}
		} else {
			this.#index = this.#stringEnd(start);
		}

		return this.#token('string', start);
	}

	#atomEnd(): number {
		let end = this.#index;
		while (end < this.#source.length && !' \t\n,[]{}\'"#'.includes(this.#source[end]!) && !this.#source.startsWith('/*', end)) {
			end++;
		}

		return end;
	}

	#looksLikeMember(): boolean {
		const start = this.#index;
		let end = start;
		if (this.#source[start] === '"' || this.#source[start] === '\'') {
			end = this.#stringEnd(start);
		} else {
			while (isBareKeyCharacter(this.#source.charCodeAt(end))) {
				end++;
			}
		}

		if (end === start || this.#source[end] !== ':') {
			return false;
		}

		// An instant also starts with key characters followed by a colon. Let the shared scalar parser decide.
		const first = this.#source.charCodeAt(start);
		if (first < 0x30 || first > 0x39) {
			return true;
		}

		try {
			return !(readScalar(this.#source.slice(start, this.#atomEnd())) instanceof Time);
		} catch (error) {
			if (!(error instanceof EditorFailure)) {
				throw error;
			}

			return true;
		}
	}

	#key(): EditorKey | EditorError {
		const start = this.#index;
		if (this.#source[start] === '"' || this.#source[start] === '\'') {
			const range = this.#string();
			try {
				const raw = this.#source.slice(...range);
				if (raw.startsWith(raw[0]!.repeat(3))) {
					throw new TypeError('Block strings cannot be keys');
				}

				return {type: 'EditorKey', key: readScalar(raw) as string, range};
			} catch (error) {
				if (!(error instanceof EditorFailure) && !(error instanceof TypeError)) {
					throw error;
				}

				this.#report('invalid-key', 'Invalid quoted key', range);
				return {type: 'EditorError', range};
			}
		}

		while (this.#index < this.#source.length && !': \t\n,[]{}\'"#'.includes(this.#source[this.#index]!) && !this.#source.startsWith('/*', this.#index)) {
			this.#index++;
		}

		const key = this.#source.slice(start, this.#index);
		if (isBareKey(key)) {
			return {type: 'EditorKey', key, range: this.#token('key', start)};
		}

		this.#index = Math.max(start + 1, this.#index);
		const range = this.#token('error', start);
		this.#report('invalid-key', 'Expected a key', range);
		return {type: 'EditorError', range};
	}

	#missing(): EditorMissing {
		const range: EditorRange = [this.#index, this.#index];
		this.#report('expected-value', 'Expected a value', range);
		return {type: 'EditorMissing', expected: 'value', range};
	}

	#member(depth: number, keys: Map<string, EditorRange>): EditorMember {
		const key = this.#key();
		if (key.type === 'EditorKey') {
			const previous = keys.get(key.key);
			if (previous) {
				this.#report('duplicate-key', 'Duplicate key', key.range, [{message: 'First declared here', range: previous}]);
			} else {
				keys.set(key.key, key.range);
			}
		}

		if (this.#source[this.#index] !== ':') {
			this.#report('expected-colon', 'Expected a colon immediately after the key', [this.#index, this.#index]);
			return {
				type: 'EditorMember', key, value: {type: 'EditorMissing', expected: 'value', range: [this.#index, this.#index]}, range: key.range,
			};
		}

		const colonRange = this.#punctuation();
		const isLineBreak = this.#trivia();
		const isMissing = this.#index === this.#source.length || ',]}'.includes(this.#source[this.#index]!) || (isLineBreak && this.#looksLikeMember());
		const value = isMissing ? this.#missing() : this.#value(depth);
		return {
			type: 'EditorMember', key, value, colonRange, range: [key.range[0], value.range[1]],
		};
	}

	#value(depth: number): EditorValue {
		const start = this.#index;
		const character = this.#source[start];
		if (character === '{' || character === '[') {
			return depth >= MAX_DEPTH ? this.#deepRegion() : this.#container(character === '{', depth + 1, true);
		}

		const isQuoted = character === '"' || character === '\'';
		let range: EditorRange;
		if (isQuoted) {
			range = this.#string();
		} else {
			this.#index = Math.max(start + 1, this.#atomEnd());
			range = this.#token('scalar', start);
		}

		try {
			const value = readScalar(this.#source.slice(...range));
			let scalarKind: EditorScalar['scalarKind'];
			if (value instanceof Time) {
				scalarKind = value.type === 'Instant' ? 'instant' : 'duration';
			} else {
				switch (typeof value) {
					case 'string': {
						scalarKind = 'string';
						break;
					}

					case 'bigint': {
						scalarKind = 'int';
						break;
					}

					case 'number': {
						scalarKind = 'float';
						break;
					}

					case 'boolean': {
						scalarKind = 'bool';
						break;
					}

					default: {scalarKind = 'null';}
				}
			}

			return {type: 'EditorScalar', scalarKind, range};
		} catch (error) {
			if (!(error instanceof EditorFailure)) {
				throw error;
			}

			this.#report('invalid-value', error.reason, range);
			return {type: 'EditorError', range};
		}
	}

	// Beyond the language's depth bound, consume balanced syntax iteratively rather than recursing.
	/* eslint-disable unicorn/no-break-in-nested-loop -- Each branch advances the iterative depth scanner. */
	#deepRegion(): EditorError {
		const start = this.#index;
		let depth = 0;
		do {
			const character = this.#source[this.#index];
			switch (character) {
				case '[':
				case '{': {
					depth++;
					this.#punctuation();

					break;
				}

				case ']':
				case '}': {
					depth--;
					this.#punctuation();

					break;
				}

				case '"':
				case '\'': {
					this.#string();

					break;
				}

				default: {
					const before = this.#index;
					this.#trivia();
					if (this.#index === before) {
						this.#index = Math.max(before + 1, this.#atomEnd());
						this.#token('error', before);
					}
				}
			}
		} while (depth > 0 && this.#index < this.#source.length);

		const range: EditorRange = [start, this.#index];
		this.#report('depth-limit', `Nesting exceeds ${MAX_DEPTH} collections`, range);
		return {type: 'EditorError', range};
	}

	/* eslint-enable unicorn/no-break-in-nested-loop */

	#separator(isBraced: boolean, previous: EditorValue): void {
		const isLineBreak = this.#trivia();
		if (this.#source[this.#index] === ',') {
			const range = this.#punctuation();
			if (!isBraced || isLineBreak) {
				this.#report('expected-separator', 'Use a line break without a comma here', range);
			}

			this.#trivia();
		} else if (!isLineBreak && previous.type !== 'EditorMissing' && this.#index < this.#source.length && !(isBraced && ']}'.includes(this.#source[this.#index]!))) {
			this.#report('expected-separator', 'Expected an entry separator', [this.#index, this.#index]);
		}
	}

	#container(isObject: boolean, depth: number, isBraced: boolean): EditorObject | EditorArray {
		const start = this.#index;
		const closer = isObject ? '}' : ']';
		const members: Array<EditorMember | EditorError> = [];
		const elements: EditorValue[] = [];
		const keys = new Map<string, EditorRange>();
		let closingRange: EditorRange | undefined;
		if (isBraced) {
			this.#punctuation();
			this.#closers.push(closer);
		}

		this.#trivia();
		while (this.#index < this.#source.length) {
			const character = this.#source[this.#index]!;
			if (isBraced && character === closer) {
				closingRange = this.#punctuation();
				break;
			}

			if (']}'.includes(character) && this.#closers.includes(character)) {
				break;
			}

			if (',]}'.includes(character)) {
				const range = this.#punctuation();
				this.#report('unexpected-token', 'Unexpected delimiter', range);
				const error: EditorError = {type: 'EditorError', range};
				if (isObject) {
					members.push(error);
				} else {
					elements.push(error);
				}

				this.#trivia();
				continue;
			}

			if (isObject) {
				const member = this.#member(depth, keys);
				members.push(member);
				this.#separator(isBraced, member.value);
			} else {
				const value = this.#value(depth);
				elements.push(value);
				this.#separator(isBraced, value);
			}
		}

		if (isBraced) {
			this.#closers.pop();
			if (!closingRange) {
				this.#report('missing-close', `Expected ${closer}`, [this.#index, this.#index], [{message: 'Opened here', range: [start, start + 1]}]);
			}
		}

		const range: EditorRange = [start, this.#index];
		return isObject
			? {
				type: 'EditorObject', braced: isBraced, members, range, ...(closingRange && {closingRange}),
			}
			: {
				type: 'EditorArray', elements, range, ...(closingRange && {closingRange}),
			};
	}

	parse(): EditorParseResult {
		this.#trivia();
		const children: Array<EditorObject | EditorArray | EditorError> = [];
		if (this.#index < this.#source.length) {
			const character = this.#source[this.#index];
			children.push(this.#container(character !== '[', 1, character === '[' || character === '{'));
			this.#trivia();
			if (this.#index < this.#source.length) {
				const start = this.#index;
				this.#index = this.#source.length;
				const range = this.#token('error', start);
				children.push({type: 'EditorError', range});
				this.#report('unexpected-token', 'Unexpected text after the document', range);
			}
		}

		return {
			text: this.#source, root: {type: 'EditorDocument', range: [0, this.#source.length], children}, tokens: this.#tokens, diagnostics: this.#diagnostics, diagnosticsTruncated: this.#truncated,
		};
	}
}
