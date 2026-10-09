import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import process from 'node:process';
import {
	parse,
	parseTree,
	evaluate,
	applyEdits,
	formatCollectionEdits,
	format,
	formatEdits,
	stringify,
	stringifyValue,
	compareKeys,
	edit,
	parseForEditor,
	getCompletionContext,
} from '../source/index.ts';
import {convertFixture} from '../scripts/update-benchmark-fixtures.ts';
import {hasBlankLine} from '../source/shared.ts';
import {createRandom, durationNanoseconds} from './helpers.ts';

test('parsed prototype keys remain data properties with polluted descriptor fields', () => {
	const script = String.raw`
import assert from 'node:assert/strict';
import {parse, parseTree, evaluate} from ${JSON.stringify(new URL('../source/index.ts', import.meta.url).href)};
const tree = parseTree('__proto__: 1\nconstructor: 2\ntoString: 3');
Object.defineProperty(Object.prototype, 'get', {value() {throw new Error('inherited descriptor getter');}, configurable: true});
try {
	const expected = JSON.parse('{"__proto__":1,"constructor":2,"toString":3}');
	for (const value of [parse('__proto__: 1\nconstructor: 2\ntoString: 3', {integers: 'number'}), evaluate(tree)]) {
		assert.equal(Object.getPrototypeOf(value), Object.prototype);
		assert.deepEqual(Object.keys(value), Object.keys(expected));
		for (const key of Object.keys(expected)) {
			assert.equal(Number(value[key]), expected[key]);
			assert.equal(Object.getOwnPropertyDescriptor(value, key).writable, true);
		}
	}
} finally {
	delete Object.prototype.get;
}
`;
	const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {encoding: 'utf8'});
	assert.equal(result.status, 0, result.stderr);
});

test('edit arrays and ranges cannot obtain missing slots from their prototypes', () => {
	const range = [0, 1] as [number, number];
	Reflect.deleteProperty(range, 0);
	Object.setPrototypeOf(range, {0: 0});
	assert.throws(() => applyEdits('a', [{range, text: 'b'}]), TypeError);
	assert.throws(() => formatCollectionEdits('[1]', range), TypeError);
	const edits: Array<{range: [number, number]; text: string}> = [{range: [0, 1], text: 'b'}];
	Reflect.deleteProperty(edits, 0);
	Object.setPrototypeOf(edits, {0: {range: [0, 1], text: 'b'}});
	assert.throws(() => applyEdits('a', edits), TypeError);
});

test('parsing and evaluation define the same prototype-like keys at every depth', () => {
	const text = '__proto__: [{constructor: 1, toString: 2, hasOwnProperty: 3, \'__defineGetter__\': 4}]';
	assert.deepEqual(evaluate(parseTree(text)), parse(text));
	assert.equal(Object.getPrototypeOf(parse(text)), Object.prototype);
});

test('a range getter cannot replace its other endpoint with an inherited value', () => {
	const range = [0, 1] as [number, number];
	Object.setPrototypeOf(range, {1: 1});
	Object.defineProperty(range, 0, {
		get() {
			Reflect.deleteProperty(range, 1);
			return 0;
		},
	});
	assert.throws(() => applyEdits('a', [{range, text: 'b'}]), TypeError);
	assert.throws(() => formatCollectionEdits('[1]', range), TypeError);
});

test('an edit getter cannot supply a deleted later edit through inheritance', () => {
	const edits = [{range: [0, 1] as const, text: 'A'}, {range: [1, 2] as const, text: 'B'}];
	Object.setPrototypeOf(edits, {1: {range: [1, 2], text: 'inherited'}});
	Object.defineProperty(edits, 0, {
		get() {
			Reflect.deleteProperty(edits, 1);
			return {range: [0, 1], text: 'A'};
		},
	});
	assert.throws(() => applyEdits('ab', edits), TypeError);
});

for (const count of [16_383, 16_384, 16_385, 32_768]) {
	test(`decoding ${count} mixed escapes retains the next sibling and exact string value`, () => {
		const raw = String.raw`a\n\u{1f600}\t`.repeat(count);
		const expected = 'a\n😀\t'.repeat(count);
		for (const string of [`"${raw}"`, `"""\n\t${raw}\n\t"""`]) {
			const text = `first: ${string}\nnext: 42`;
			assert.deepEqual(parse(text), {first: expected, next: 42n});
			assert.deepEqual(evaluate(parseTree(text)), {first: expected, next: 42n});
			assert.deepEqual(parseForEditor(text).diagnostics, []);
			assert.deepEqual(parse(format(text)), {first: expected, next: 42n});
		}
	});
}

test('escape-heavy scalar and block strings decode within a bounded heap', () => {
	const script = String.raw`
import assert from 'node:assert/strict';
import {parse} from ${JSON.stringify(new URL('../source/index.ts', import.meta.url).href)};
const raw = String.raw\`\n\u{1f600}\t\`.repeat(500_000);
const expected = '\n😀\t'.repeat(500_000);
for (const value of ['"' + raw + '"', '"""\n' + raw + '\n"""']) {
	assert.equal(parse('text: ' + value).text, expected);
}
`;
	const result = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '--eval', script.replaceAll('\\`', '`')], {encoding: 'utf8'});
	assert.equal(result.status, 0, result.stderr);
});

test('out-of-range BigInt diagnostics do not include or convert unbounded numeric text', () => {
	const value = 2n ** 1_000_000n;
	for (const integer of [value, -value]) {
		assert.throws(() => stringifyValue(integer), {
			name: 'RangeError',
			message: 'Cannot serialize an integer outside the 64-bit range (-9223372036854775808 to 9223372036854775807)',
		});
	}
});

test('canonical Unicode sorting agrees with an independent scalar-value oracle', () => {
	const random = createRandom(0xFA_37_91);
	const characters = ['a', '-', '0', '\u{D7FF}', '\u{E000}', '\u{FFFF}', '\u{10000}', '😀', '\u{10FFFF}'];
	const keys = Array.from({length: 500}, () => Array.from({length: random.integer(1, 8)}, () => random.pick(characters)).join(''));
	function compare(first: string, second: string): number {
		const left = Array.from(first, character => character.codePointAt(0)!);
		const right = Array.from(second, character => character.codePointAt(0)!);
		// eslint-disable-next-line unicorn/prefer-iterator-zip -- Iterator.zip is not available in Node.js 26.
		for (let index = 0; index < Math.min(left.length, right.length); index++) {
			if (left[index] !== right[index]) {
				return left[index]! - right[index]!;
			}
		}

		return left.length - right.length;
	}

	const expected = [...new Set(keys)].toSorted(compare);
	assert.deepEqual([...new Set(keys)].toSorted(compareKeys), expected);
	const tree = parseTree(stringify(Object.fromEntries(keys.map(key => [key, 1n])), {canonical: true}));
	assert.equal(tree.body.type, 'Object');
	assert.deepEqual(tree.body.members.map(member => member.key.value), expected);
});

test('compacting member snapshots preserves getter order when earlier members are omitted', () => {
	for (const isCanonical of [false, true]) {
		const reads: string[] = [];
		const object = Object.fromEntries(['c', 'b', 'a'].map(key => [key, undefined]));
		for (const key of Object.keys(object)) {
			Object.defineProperty(object, key, {
				enumerable: true,
				get() {
					reads.push(key);
					return key === 'b' ? undefined : key;
				},
			});
		}

		assert.equal(stringify(object, {canonical: isCanonical}), isCanonical ? 'a: \'a\'\nc: \'c\'\n' : 'c: \'c\'\na: \'a\'\n');
		assert.deepEqual(reads, isCanonical ? ['a', 'b', 'c'] : ['c', 'b', 'a']);
	}
});

test('duration decomposition preserves signed nanoseconds across every unit carry', () => {
	for (const size of [1000n, 1_000_000n, 1_000_000_000n, 60_000_000_000n, 3_600_000_000_000n, (2n ** 63n) - 1n]) {
		for (const delta of [-1n, 0n, 1n]) {
			const magnitude = size + delta;
			const nanosecondValues = [magnitude, -magnitude].filter(value => value >= -(2n ** 63n) && value < 2n ** 63n);
			for (const nanoseconds of nanosecondValues) {
				const document = parse(`duration: ${nanoseconds}ns`);
				assert.ok(!Array.isArray(document));
				assert.ok(document['duration'] instanceof Temporal.Duration);
				assert.equal(durationNanoseconds(document['duration']), nanoseconds);
				assert.equal(stringify(document, {canonical: true}), stringify(evaluate(parseTree(`duration: ${nanoseconds}ns`)) as Record<string, unknown>, {canonical: true}));
			}
		}
	}
});

test('bounded duration normalization preserves diagnostics and exact accepted fractions', () => {
	const huge = '1_'.repeat(100_000) + '1';
	assert.throws(() => parse(`duration: ${huge}ns`), {reason: /outside the 64-bit range/v});
	assert.throws(() => parse(`duration: ${huge}ns1y`), {reason: /no year unit/v});
	assert.throws(() => parse(`duration: 0.${huge}s`), {reason: /whole number of nanoseconds/v});
	assert.throws(() => parse(`duration: 0.${huge}s1ns`), {reason: /only the last part may have a fraction/v});
	for (const fraction of ['0000000000025', '0_0_0_0_0_0_0_0_0_0_0_2_5']) {
		const value = parse(`duration: 0.${fraction}h`);
		assert.ok(!Array.isArray(value));
		assert.ok(value['duration'] instanceof Temporal.Duration);
		assert.equal(durationNanoseconds(value['duration']), 9n);
	}
});

test('comma lookup distinguishes nested punctuation from comma-rich comment and string text', () => {
	const text = `{
	first: [1, /* ,,, [{ */ {key: ',,:{}[]', nested: [2, 3,]},],
	second: {a: [4, /* , } ] */ 5], b: ',,'}, # ,,,
	last: [6, 7],
}`;
	const expected = {
		first: [1n, {key: ',,:{}[]', nested: [2n, 3n]}],
		second: {a: [4n, 5n], b: ',,'},
		last: [6n, 7n],
	};
	const formatted = format(text);
	assert.deepEqual(parse(formatted), expected);
	assert.equal(applyEdits(text, formatEdits(text)), formatted);
	assert.equal(format(formatted), formatted);
	assert.match(formatted, /\/\* ,,, \[\{ \*\//v);
	assert.match(formatted, /# ,,,/v);
});

test('blank-line scanning respects range boundaries and is stack-safe on a huge single gap', () => {
	const text = `\n${' '.repeat(2_000_000)}\n`;
	assert.equal(hasBlankLine(text, 0, text.length), true);
	assert.equal(hasBlankLine(text, 0, text.length - 1), false);
	assert.equal(hasBlankLine(text, 1, text.length), false);
	assert.equal(format(`[1\n${' '.repeat(2_000_000)}2]`), '[\n\t1\n\t2\n]\n');
});

test('fixture conversion keeps a huge gap between comments without regex stack growth', () => {
	const text = `# header\n${' '.repeat(2_000_000)}\n# value\nnumber: 1\n`;
	const converted = convertFixture(text);
	assert.equal(converted.json, '{"number": 1}\n');
	assert.equal(converted.toml, '# header\n\n# value\nnumber = 1\n');
	assert.equal(converted.writtenComments, 2);
});

test('removing a value with many owned comments keeps only standalone comments', () => {
	const text = `items: [\n# keep\n1\n${'/* owned */ '.repeat(10_000)}2\n3\n]`;
	const result = edit(text, ['items', 1], undefined);
	assert.deepEqual(parse(result), {items: [1n, 3n]});
	assert.match(result, /# keep/v);
	assert.equal(result.includes('owned'), false);
});

test('completion token replacement preserves snapshot identity and produces a valid value', () => {
	const snapshot = parseForEditor('enabled: tr');
	const context = getCompletionContext(snapshot, snapshot.text.length);
	assert.ok(context);
	assert.equal(context.ancestors[0], snapshot.root);
	assert.equal(context.slot.kind, 'member-value');
	assert.equal(context.prefix, 'tr');
	assert.deepEqual(context.range, [9, 11]);
	const updated = applyEdits(snapshot.text, [{range: context.range, text: 'true'}]);
	assert.deepEqual(parse(updated), {enabled: true});
	assert.equal(snapshot.text, 'enabled: tr');
});
