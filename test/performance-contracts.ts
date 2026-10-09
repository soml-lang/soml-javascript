import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	applyEdits,
	edit,
	evaluate,
	format,
	formatString,
	getNodeAt,
	parse,
	parseForEditor,
	parseTree,
	ParseError,
	stringify,
	stringifyValue,
} from '../source/index.ts';
import {normalize} from './helpers.ts';

test('arrays ignore throwing enumerable named getters through serialization and editing', () => {
	const value = [1n, 2n];
	Object.defineProperty(value, 'metadata', {
		enumerable: true,
		get() {
			throw new Error('array metadata must remain unread');
		},
	});
	assert.deepEqual(parse(stringify(value)), [1n, 2n]);
	assert.deepEqual(parse(stringifyValue(value)), [1n, 2n]);
	assert.deepEqual(parse(edit('value: []', ['value'], value)), {value: [1n, 2n]});
});

test('own getter exceptions propagate unchanged across serialization and editing', () => {
	const failure = new Error('getter failure');
	const value = {
		get entry() {
			throw failure;
		},
	};
	for (const action of [() => stringify(value), () => stringifyValue(value), () => edit('value: {}', ['value'], value)]) {
		assert.throws(action, error => error === failure);
	}
});

test('key snapshots exclude getter-added members until the next serialization', () => {
	const value: Record<string, unknown> = {
		get first() {
			value['added'] = 2n;
			return 1n;
		},
	};
	assert.equal(stringify(value), 'first: 1\n');
	assert.equal(stringify(value), 'first: 1\nadded: 2\n');
	assert.equal(stringify(value, {canonical: true}), 'added: 2\nfirst: 1\n');
});

test('own integer canonical and string style option getters are read once', () => {
	const reads: string[] = [];
	const options = {
		get integers() {
			reads.push('integers');
			return 'number' as const;
		},
		get canonical() {
			reads.push('canonical');
			return false;
		},
		get stringStyle() {
			reads.push('stringStyle');
			return 'escaped' as const;
		},
	};
	assert.equal(edit('value: {}', ['value'], 'text', options), 'value: "text"');
	assert.deepEqual(reads, ['integers', 'canonical', 'stringStyle']);
	let styleReads = 0;
	assert.equal(formatString('text', {
		get style() {
			styleReads++;
			return 'escaped' as const;
		},
	}), '"text"');
	assert.equal(styleReads, 1);
});

test('own undefined options mask throwing inherited getters and choose defaults', () => {
	const prototype = Object.defineProperties({}, Object.fromEntries(['integers', 'canonical', 'style', 'stringStyle'].map(key => [key, {
		get() {
			throw new Error(`inherited ${key}`);
		},
	}])));
	const options = Object.create(prototype, Object.fromEntries(['integers', 'canonical', 'style', 'stringStyle'].map(key => [key, {value: undefined}]))) as Record<string, never>;
	assert.deepEqual(parse('value: 1', options), {value: 1n});
	assert.equal(stringify({value: 1}, options), 'value: 1.0\n');
	assert.equal(formatString('text', options), '\'text\'');
	assert.deepEqual(parse(edit('{}', ['value'], 1, options)), {value: 1});
});

for (const padding of [16_380, 16_381, 16_382]) {
	const number = `0.1250${'_0'.repeat(padding)}`;
	test(`decimal fractions preserve values with a ${number.length}-unit separator token`, () => {
		const text = `value: ${number}`;
		assert.deepEqual(parse(text), {value: 0.125});
		assert.deepEqual(evaluate(parseTree(text)), {value: 0.125});
		assert.deepEqual(parseForEditor(text).diagnostics, []);
		assert.equal(format(text), `${text}\n`);
	});

	const fraction = `1250${'_0'.repeat(padding + 1)}`;
	const durationNumber = `0.${fraction}`;
	test(`duration fractions preserve values with a ${fraction.length}-unit fraction`, () => {
		const text = `value: ${durationNumber}s`;
		const expected = {value: Temporal.Duration.from({milliseconds: 125})};
		assert.deepEqual(normalize(parse(text)), normalize(expected));
		const tree = parseTree(text);
		assert.deepEqual(normalize(evaluate(tree)), normalize(expected));
		assert.equal(tree.body.type, 'Object');
		const duration = tree.body.members[0]!.value;
		assert.equal(duration.type, 'Duration');
		assert.deepEqual(duration.parts, [{number: durationNumber, unit: 's'}]);
		assert.deepEqual(parseForEditor(text).diagnostics, []);
		assert.equal(format(text), `${text}\n`);
	});
}

test('long radix number mode distinguishes safe-integer errors from int64 overflow', () => {
	const zeros = '0_'.repeat(20_000);
	assert.deepEqual(parse(`value: 0x${zeros}FF`, {integers: 'number'}), {value: 255});
	assert.throws(() => parse(`value: 0x${zeros}20000000000000`, {integers: 'number'}), {reason: /represented exactly/v});
	assert.throws(() => parse(`value: 0x${zeros}8000000000000000`, {integers: 'number'}), {reason: /64-bit/v});
});

for (const count of [99, 100]) {
	test(`diagnostic truncation accurately reports ${count} invalid scalar members`, () => {
		const text = Array.from({length: count}, (_, index) => `key${index}: nope`).join('\n');
		const snapshot = parseForEditor(text);
		assert.equal(snapshot.diagnostics.length, 100);
		assert.equal(snapshot.diagnosticsTruncated, count === 100);
		assert.equal(snapshot.diagnostics[0]?.code, 'invalid-document');
		assert.equal(snapshot.diagnostics.at(-1)?.code, 'invalid-value');
		const root = snapshot.root.children.at(0);
		assert.equal(root?.type, 'EditorObject');
		assert.equal(root.members.length, count);
	});
}

for (const width of [99, 100, 101]) {
	test(`error frames clip a ${width}-unit line only beyond the width boundary`, () => {
		const text = `value:${' '.repeat(width - 7)}@`;
		assert.equal(text.length, width);
		assert.throws(() => parse(text), error => {
			assert.ok(error instanceof ParseError);
			assert.equal(error.offset, width - 1);
			assert.equal(error.column, width);
			assert.equal(error.codeFrame.includes('…'), width > 100);
			assert.ok(error.codeFrame.includes('@'));
			return true;
		});
	});
}

test('EOF after LF keeps an empty error line and the preceding context', () => {
	assert.throws(() => parse('before: \'😀\'\nmissing:\n'), {
		line: 3,
		column: 1,
		codeFrame: '  1 | before: \'😀\'\n  2 | missing:\n> 3 |\n    | ^',
	});
});

test('text edits accept half-surrogate ranges independently of document validity', () => {
	const changed = applyEdits('😀', [{range: [0, 1], text: 'x'}]);
	assert.equal(changed, 'x\u{DE00}');
	assert.throws(() => parse(`value: '${changed}'`), {reason: /surrogate/v});
	assert.equal(applyEdits('😀', [{range: [1, 2], text: ''}]), '\u{D83D}');
});

test('text edit bounds distinguish safe offsets outside text from unsafe integers', () => {
	assert.throws(() => applyEdits('text', [{range: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], text: ''}]), RangeError);
	assert.throws(() => applyEdits('text', [{range: [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1], text: ''}]), TypeError);
});

test('leaf cursor lookup returns the original node without reading token indexes', () => {
	const text = 'value: 1.5\nname: \'😀\'';
	const tree = parseTree(text);
	assert.equal(tree.body.type, 'Object');
	const {value} = (tree.body.members[0]!);
	let tokenReads = 0;
	const tokens = new Proxy(tree.tokens, {
		get(array, key, receiver) {
			if (typeof key === 'string' && /^\d+$/v.test(key)) {
				tokenReads++;
			}

			return Reflect.get(array, key, receiver) as unknown;
		},
	});
	assert.equal(getNodeAt({...tree, tokens}, value.range[0]), value);
	assert.equal(getNodeAt({...tree, tokens}, value.range[1] - 1), value);
	assert.equal(tokenReads, 0);
	assert.equal(getNodeAt({...tree, tokens}, text.indexOf(':'))?.type, 'Punctuator');
	assert.ok(tokenReads > 0);
});
