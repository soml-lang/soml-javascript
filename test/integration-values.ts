import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
	applyEdits,
	compareKeys,
	edit,
	editEdits,
	evaluate,
	format,
	formatBlockString,
	formatCollectionEdits,
	formatEdits,
	formatFloat,
	formatKey,
	formatString,
	getNodeAt,
	getNodeAtPath,
	isBareKey,
	parse,
	parseForEditor,
	parseTree,
	stringify,
	stringifyValue,
	type FormatEdit,
} from '../source/index.ts';
import {normalize} from './helpers.ts';

function assertDocument(text: string, expected: unknown): void {
	assert.deepEqual(normalize(parse(text)), normalize(expected));
	assert.deepEqual(normalize(evaluate(parseTree(text))), normalize(expected));
	assert.equal(parseForEditor(text).diagnostics.length, 0);
	const formatted = format(text);
	assert.deepEqual(normalize(parse(formatted)), normalize(expected));
	assert.equal(applyEdits(text, formatEdits(text)), formatted);
	assert.equal(format(formatted), formatted);
}

test('serialization never reads non-enumerable getters', () => {
	const value = Object.defineProperty({visible: 1n}, 'hidden', {
		get() {
			throw new Error('hidden getter');
		},
	});
	assert.equal(stringify(value, {canonical: true}), 'visible: 1\n');
});

test('serialization never reads symbol getters', () => {
	const value = Object.defineProperty({visible: true}, Symbol('hidden'), {
		enumerable: true, get() {
			throw new Error('symbol getter');
		},
	});
	assertDocument(stringify(value), {visible: true});
});

test('serialization reads retained and omitted getters exactly once in canonical order', () => {
	const reads: string[] = [];
	const value = {
		get z() {
			reads.push('z');
			return 2n;
		},
		get omitted() {
			reads.push('omitted');
			return undefined;
		},
		get a() {
			reads.push('a');
			return 1n;
		},
	};
	assert.equal(stringify(value, {canonical: true}), 'a: 1\nz: 2\n');
	assert.deepEqual(reads, ['a', 'omitted', 'z']);
});

test('nested canonical getters run before writing values without being read again', () => {
	let reads = 0;
	const value = {
		outer: {
			get a() {
				reads++;
				return {value: reads};
			},
		},
	};
	assertDocument(stringify(value, {canonical: true}), {outer: {a: {value: 1}}});
	assert.equal(reads, 1);
});

test('undefined members do not force quoted invalid keys to be serialized', () => {
	const value = {'\u{D800}': undefined, valid: 'retained'};
	assert.equal(stringify(value, {canonical: true}), 'valid: \'retained\'\n');
});

test('parent scalars are captured before a nested getter mutates them', () => {
	const value = {
		nested: {
			get trigger() {
				value.later = 9n;
				return 1n;
			},
		},
		later: 2n,
	};
	assertDocument(stringify(value), {nested: {trigger: 1n}, later: 2n});
	assert.equal(value.later, 9n);
});

test('throwing inherited option getters remain unread across value APIs', () => {
	const prototype = Object.fromEntries(['integers', 'canonical', 'style', 'stringStyle'].map(name => [name, {
		get() {
			throw new Error(`inherited ${name} getter`);
		},
	}]));
	const options = Object.create(Object.defineProperties({}, prototype)) as Record<string, never>;
	assert.deepEqual(parse('value: 1', options), {value: 1n});
	assert.equal(stringify({value: 1n}, options), 'value: 1\n');
	assert.equal(formatString('value', options), '\'value\'');
	assertDocument(edit('value: 1', ['value'], 'changed', options), {value: 'changed'});
});

test('equal long keys compare without changing canonical duplicate semantics', () => {
	const key = '😀x'.repeat(10_000);
	assert.equal(compareKeys(key, key), 0);
	assert.equal(compareKeys(key, `${key}a`), -1);
	assertDocument(stringify({[key]: 1n}, {canonical: true}), {[key]: 1n});
});

test('cross-realm null-prototype objects serialize nested prototype-like names safely', () => {
	const value = vm.runInNewContext('Object.assign(Object.create(null), {constructor: 1n, nested: [Object.create(null)]})') as Record<string, unknown>;
	assertDocument(stringify(value), {constructor: 1n, nested: [{}]});
});

test('a shared frozen collection can be serialized repeatedly without cycle state leaking', () => {
	const shared = Object.freeze([Object.freeze({value: 1n})]);
	const value = Object.freeze({first: shared, second: shared});
	assertDocument(stringify(value), value);
	assert.equal(stringify(value), stringify(value));
});

test('arrays retain their captured length when a getter removes a later element', () => {
	const value = [1n, 2n];
	Object.defineProperty(value, 0, {
		get() {
			value.length = 1;
			return 1n;
		},
	});
	assert.throws(() => stringify(value), {name: 'TypeError', message: 'Cannot serialize undefined in an array, at index 1'});
	assert.equal(value.length, 1);
});

test('arrays snapshot length before an element getter appends data', () => {
	const value: unknown[] = [];
	Object.defineProperty(value, 0, {
		get() {
			value.push(2n);
			return 1n;
		},
	});
	assert.equal(stringify(value), '[\n\t1\n]\n');
	assert.equal(value.length, 2);
});

test('block strings of many spaces avoid expansion while retaining every space', () => {
	const value = ' '.repeat(100_000);
	const block = formatBlockString(value);
	assert.ok(block.length < value.length + 20);
	assertDocument(`value: ${block}`, {value});
});

test('spaces-only blocks remain content after nesting and formatting', () => {
	const value = ' '.repeat(513);
	const text = edit('outer: {value: null}', ['outer', 'value'], value, {stringStyle: 'block'});
	assertDocument(text, {outer: {value}});
	assert.equal((parse(format(text)) as {outer: {value: string}}).outer.value.length, 513);
});

test('escaped block fallback retains trailing spaces after escaped control characters', () => {
	const value = '\u{0}  \t\n tail  ';
	assertDocument(`value: ${formatBlockString(value)}`, {value});
});

test('quote-run block delimiters survive a compact refusal and unrelated edit', () => {
	const value = '\'\'\'\n\'\'\'\'\n body';
	const text = `items: [${formatBlockString(value)}]\nother: 1`;
	const tree = parseTree(text);
	assert.equal(tree.body.type, 'Object');
	const items = tree.body.members[0]!.value;
	assert.equal(items.type, 'Array');
	const block = items.elements[0]!;
	assert.equal(block.type, 'String');
	assert.equal(formatCollectionEdits({text, root: tree}, items, {layout: 'compact'}), undefined);
	assertDocument(edit(text, ['other'], 2n), {items: [value], other: 2n});
	assert.ok(block.block);
});

test('formatString styles preserve grammar-looking text without exposing tokens', () => {
	const value = '/* */ # : [,] " \\';
	for (const style of ['auto', 'literal', 'escaped', 'block'] as const) {
		assertDocument(`value: ${formatString(value, {style})}`, {value});
	}
});

test('explicit escaped output round-trips tabs that automatic quoting escapes', () => {
	const value = 'before\tafter';
	assert.equal(formatString(value), String.raw`"before\tafter"`);
	assert.equal(formatString(value, {style: 'literal'}), `'${value}'`);
	assertDocument(`a: ${formatString(value, {style: 'escaped'})}`, {a: value});
});

test('keys containing escaped line feeds retain literal path identity through editing', () => {
	const key = 'first\nsecond';
	const text = `${formatKey(key)}: 1\nother: 2`;
	assertDocument(edit(text, [key], 3n), {[key]: 3n, other: 2n});
	assert.equal(getNodeAtPath(parseTree(text), ['first', 'second']), undefined);
});

test('all bare-key ASCII characters are retained by strict and recovered scanners', () => {
	const key = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
	const text = `${key}: true`;
	assert.ok(isBareKey(key));
	assertDocument(text, {[key]: true});
	const snapshot = parseForEditor(text);
	assert.equal(snapshot.tokens[0]?.kind, 'key');
	assert.equal(text.slice(...snapshot.tokens[0].range), key);
});

test('bare-key scanning stops before Unicode content instead of swallowing its colon', () => {
	assert.equal(isBareKey('name😀'), false);
	const text = `${formatKey('name😀')}: true`;
	assertDocument(text, {'name😀': true});
	assert.throws(() => parse('name😀: true'), /quoted/v);
});

test('fifteen-digit parser fast-path limits preserve scalar types through formatting', () => {
	const text = '[999999999999999, 999999999999999.0, 1000000000000000, 1000000000000000.0]';
	const expected = [999_999_999_999_999n, 999_999_999_999_999, 1_000_000_000_000_000n, 1_000_000_000_000_000];
	assertDocument(text, expected);
	const tree = parseTree(text);
	assert.equal(tree.body.type, 'Array');
	assert.deepEqual(tree.body.elements.map(node => node.type), ['Integer', 'Float', 'Integer', 'Float']);
});

test('numeric-separator buffer thresholds retain hexadecimal bit patterns', () => {
	for (const padding of [16_381, 16_382, 16_383]) {
		const text = `value: 0x${'0_'.repeat(padding)}FF`;
		assertDocument(text, {value: 255n});
	}
});

test('the numeric-separator decoder does not inherit earlier invalid UTF-8 state', () => {
	assert.throws(() => parse(Uint8Array.of(0xFF)), /UTF-8/v);
	assertDocument(`value: 0b${'0_'.repeat(20_000)}1`, {value: 1n});
	assert.deepEqual(parse(new TextEncoder().encode('a: \'é😀\'')), {a: 'é😀'});
});

test('underflow diagnostics ignore nonzero exponent digits for an exact zero mantissa', () => {
	assertDocument('[0.000e-999, -0.000e-999]', [0, 0]);
	assert.throws(() => parse('[0.001e-999]'), /too small/v);
});

test('several-dot diagnostics stay distinct from malformed one-dot numbers', () => {
	assert.throws(() => parse('version: 1.2.3'), /several dots/v);
	assert.throws(() => parse('value: 1.'), /followed by a digit/v);
	assert.throws(() => parse('value: 1e'), /exponent marker/v);
});

test('formatted positive and negative exponents survive canonical serialization', () => {
	const value = {large: 1e21, small: 1e-7, negative: -1e21};
	assert.equal(formatFloat(1e21), '1e21');
	assert.equal(formatFloat(1e-7), '1e-7');
	assertDocument(stringify(value, {canonical: true}), value);
});

test('negative epoch fractions round-trip around whole-second boundaries', () => {
	const instants = [-1_000_000_001n, -1_000_000_000n, -999_999_999n, -1n, 0n, 1n].map(nanoseconds => new Temporal.Instant(nanoseconds));
	assertDocument(stringify(instants), instants);
	assert.equal(stringifyValue(instants[0]), '1969-12-31T23:59:58.999999999Z');
});

test('unbalanced duration time fields serialize as their exact total after evaluation', () => {
	const duration = Temporal.Duration.from({
		hours: 1, minutes: 90, milliseconds: 1500, microseconds: 1001,
	});
	assertDocument(stringify({duration}), {duration});
	assert.equal(stringifyValue(duration), '2h30m1.501001s');
});

test('duration parts retain separators while evaluation uses exact nanoseconds', () => {
	const text = 'duration: -1_000h2m3.000_001s';
	const node = getNodeAtPath(parseTree(text), ['duration']);
	assert.equal(node?.type, 'Duration');
	assert.deepEqual(node.parts, [{number: '1_000', unit: 'h'}, {number: '2', unit: 'm'}, {number: '3.000_001', unit: 's'}]);
	assertDocument(text, {
		duration: Temporal.Duration.from({
			hours: -1000, minutes: -2, seconds: -3, microseconds: -1,
		}),
	});
});

test('repeated evaluation makes independently mutable object and array containers', () => {
	const tree = parseTree('outer: [{inner: [1]}]');
	const first = evaluate(tree) as {outer: Array<{inner: bigint[]}>};
	first.outer[0]!.inner.push(2n);
	assert.deepEqual(evaluate(tree), {outer: [{inner: [1n]}]});
	assert.equal(getNodeAtPath(tree, ['outer', 0, 'inner'])?.type, 'Array');
});

test('repeated evaluation reuses nested cached temporal values without reusing containers', () => {
	const tree = parseTree('items: [{time: 1970-01-01T00:00:00.000000001Z, wait: 1ns}]');
	const first = evaluate(tree) as {items: Array<{time: Temporal.Instant; wait: Temporal.Duration}>};
	const second = evaluate(tree) as typeof first;
	assert.notEqual(first.items, second.items);
	assert.notEqual(first.items[0], second.items[0]);
	assert.equal(first.items[0]!.time, second.items[0]!.time);
	assert.equal(first.items[0]!.wait, second.items[0]!.wait);
	assert.equal(second.items[0]!.time.epochNanoseconds, 1n);
});

test('keyword-shaped keys do not influence neighboring boolean and null node types', () => {
	const text = 'true: false\nnull: true\nfalse: null\ninfinity: [true, false, null]';
	assertDocument(text, {
		true: false, null: true, false: null, infinity: [true, false, null],
	});
	const tree = parseTree(text);
	assert.deepEqual(tree.tokens.filter(token => token.type === 'Keyword').map(token => token.value), ['false', 'true', 'null', 'true', 'false', 'null']);
});

test('numeric node spelling remains unchanged when another member is edited', () => {
	const text = 'values: [0xFF, 0o77, 0b11, -0.0, 1e3]\nother: false';
	const changed = edit(text, ['other'], true);
	assert.ok(changed.startsWith('values: [0xFF, 0o77, 0b11, -0.0, 1e3]'));
	assertDocument(changed, {values: [255n, 63n, 3n, 0, 1000], other: true});
});

test('mixed object and array nesting accepts the limit in all three readers', () => {
	let text = '1';
	let expected: unknown = 1n;
	for (let depth = 0; depth < 100; depth++) {
		const isArray = depth % 2 === 0;
		text = isArray ? `[${text}]` : `{value: ${text}}`;
		expected = isArray ? [expected] : {value: expected};
	}

	assertDocument(text, expected);
	assert.throws(() => parse(`[${text}]`), /100 levels/v);
	assert.ok(parseForEditor(`[${text}]`).diagnostics.some(diagnostic => diagnostic.code === 'depth-limit'));
});

test('strict node lookup returns comment identity across many comment boundaries', () => {
	const text = Array.from({length: 4096}, (_, index) => `k${index}: ${index} # note${index}`).join('\n');
	const tree = parseTree(text);
	for (const index of [0, 2048, 4095]) {
		const comment = tree.comments[index]!;
		assert.equal(getNodeAt(tree, comment.range[0]), comment);
		assert.equal(getNodeAt(tree, comment.range[1] - 1), comment);
		assert.notEqual(getNodeAt(tree, comment.range[1]), comment);
	}
});

test('node-based editing leaves the supplied tree and target unchanged', () => {
	const text = 'outer: [{value: 1, retained: 0xFF}]';
	const tree = parseTree(text);
	const before = structuredClone(tree);
	const target = getNodeAtPath(tree, ['outer', 0, 'value'])!;
	assertDocument(applyEdits(text, editEdits(text, target, 2n)), {outer: [{value: 2n, retained: 255n}]});
	assert.deepEqual(tree, before);
	assert.equal(getNodeAtPath(tree, ['outer', 0, 'value']), target);
});

test('the maximum collection indentation preserves relative nested indentation', () => {
	const text = '[1, {a: 2}]';
	const edits = formatCollectionEdits(text, [0, text.length], {layout: 'multiline', indentationLevel: 1000});
	const changed = applyEdits(text, edits);
	assert.equal(changed, `[\n${'\t'.repeat(1001)}1\n${'\t'.repeat(1001)}{a: 2}\n${'\t'.repeat(1000)}]`);
	assert.deepEqual(parse(changed), [1n, {a: 2n}]);
});

test('collection formatting ignores inherited options and own undefined overrides', () => {
	const text = '[1,  2]';
	const inherited = Object.create({layout: 'multiline', indentationLevel: 1000}) as {layout?: undefined; indentationLevel?: undefined};
	for (const options of [inherited, Object.assign(Object.create(inherited) as typeof inherited, {layout: undefined, indentationLevel: undefined})]) {
		assert.equal(applyEdits(text, formatCollectionEdits(text, [0, text.length], options)), '[1, 2]');
	}
});

test('frozen sorted edit lists retain insertion order at a shared replacement boundary', () => {
	const edits: readonly FormatEdit[] = Object.freeze([
		Object.freeze({range: Object.freeze([1, 1] as const), text: 'A'}),
		Object.freeze({range: Object.freeze([1, 1] as const), text: 'B'}),
		Object.freeze({range: Object.freeze([1, 2] as const), text: 'C'}),
	]);
	assert.equal(applyEdits('xyz', edits), 'xABCz');
	assert.equal(edits[0]!.text, 'A');
});
