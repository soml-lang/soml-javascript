import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	applyEdits,
	compareKeys,
	edit,
	evaluate,
	formatCollectionEdits,
	getNodeAtPath,
	getCompletionContext,
	isBareKey,
	parse,
	parseForEditor,
	parseTree,
	ParseError,
	format,
	formatString,
	stringify,
	stringifyValue,
	visitorKeys,
} from '../source/index.ts';

test('invalid node types produce bounded terminal-safe diagnostics', () => {
	const type = `\u{9B}31m${'x'.repeat(100_000)}`;
	for (const action of [() => evaluate({type}), () => edit('a: 1', {type}, 2n)]) {
		assert.throws(action, error => error instanceof TypeError && !error.message.includes('\u{9B}') && error.message.length < 300);
	}
});

test('unterminated block delimiters cannot inflate diagnostics', () => {
	const delimiter = '\''.repeat(100_000);
	assert.throws(() => parse(`a: ${delimiter}\ntext${delimiter}`), error => error instanceof ParseError && error.reason.startsWith('Unterminated block string') && error.message.length < 600);
});

test('out-of-range bigint diagnostics remain bounded', () => {
	assert.throws(() => stringifyValue(10n ** 100_000n), error => error instanceof RangeError && error.message.length < 300);
});

test('path lookup reads accessor-backed segments once', () => {
	let reads = 0;
	const path = [];
	Object.defineProperty(path, 0, {get: () => ++reads === 1 ? 'a' : 'b'});
	const tree = parseTree('a: 1\nb: 2');
	assert.equal(getNodeAtPath(tree, path).value, 1n);
	assert.equal(reads, 1);
});

test('editing snapshots paths before option getters mutate them', () => {
	const path = ['a'];
	const options = {
		get integers() {
			path[0] = 'b';
			return 'bigint';
		},
	};
	assert.deepEqual(parse(edit('a: 1\nb: 2', path, 3n, options)), {a: 3n, b: 2n});
});

test('applying edits snapshots the list length before getters add edits', () => {
	const edits = [{
		range: [0, 1],
		get text() {
			edits.push({range: [1, 2], text: 'B'});
			return 'A';
		},
	}];
	assert.equal(applyEdits('ab', edits), 'Ab');
});

test('collection formatting reads accessor-backed offsets once', () => {
	let startReads = 0;
	let endReads = 0;
	const range = [];
	Object.defineProperties(range, {
		0: {get: () => ++startReads === 1 ? 0 : 999},
		1: {get: () => ++endReads === 1 ? 6 : 999},
	});
	assert.equal(applyEdits('[1, 2]', formatCollectionEdits('[1, 2]', range, {layout: 'multiline'})), '[\n\t1\n\t2\n]');
	assert.equal(startReads, 1);
	assert.equal(endReads, 1);
});

test('key helpers reject non-string values without invoking methods', () => {
	const value = {
		charCodeAt() {
			assert.fail('User methods must not execute');
		},
	};
	assert.throws(() => isBareKey(value), TypeError);
	assert.throws(() => compareKeys(value, value), TypeError);
});

test('single edits snapshot each accessor exactly once', () => {
	const reads = {
		range: 0, text: 0, start: 0, end: 0,
	};
	const range = [];
	Object.defineProperties(range, {
		0: {
			get() {
				reads.start++;
				return 1;
			},
		},
		1: {
			get() {
				reads.end++;
				return 3;
			},
		},
	});
	const change = {
		get range() {
			reads.range++;
			return range;
		},
		get text() {
			reads.text++;
			return '😀';
		},
	};
	assert.equal(applyEdits('abcd', Object.freeze([Object.freeze(change)])), 'a😀d');
	assert.deepEqual(reads, {
		range: 1, text: 1, start: 1, end: 1,
	});
});

test('multiple edits ignore appended entries and preserve insertion order', () => {
	const edits = [{range: [2, 2], text: 'second'}, {
		range: [0, 1],
		get text() {
			edits.push({range: [3, 3], text: 'ignored'});
			return 'A';
		},
	}, {range: [2, 2], text: 'third'}, {range: [2, 3], text: 'C'}];
	assert.equal(applyEdits('abc', edits), 'AbsecondthirdC');
});

test('path snapshots ignore newly appended segments during navigation', () => {
	const path = [];
	Object.defineProperty(path, 0, {
		get() {
			path.push('missing');
			return 'a';
		},
	});
	assert.equal(getNodeAtPath(parseTree('a: [1]'), path).type, 'Array');
});

test('both ordering modes skip properties made non-enumerable by an earlier getter', () => {
	for (const isCanonical of [false, true]) {
		const value = {
			get a() {
				Object.defineProperty(value, 'b', {enumerable: false});
				return 1n;
			},
			b: 2n,
		};
		assert.equal(stringify(value, {canonical: isCanonical}), 'a: 1\n');
	}
});

test('undefined members and poisoned deleted members share the same serialization path', () => {
	for (const isCanonical of [false, true]) {
		const value = {
			get a() {
				Reflect.deleteProperty(value, 'b');
				return undefined;
			},
			b: 2n,
			c: 3n,
		};
		Object.setPrototypeOf(value, Object.create(null, {
			b: {
				get() {
					assert.fail('An inherited member must remain unread');
					return undefined;
				},
			},
		}));
		assert.equal(stringify(value, {canonical: isCanonical}), 'c: 3\n');
	}
});

test('duration decomposition preserves every sign and int64 boundary exactly', () => {
	const amounts = [0n, 1n, -1n, 1_001_001_001n, -1_001_001_001n, 3_661_001_001_001n, -3_661_001_001_001n, (2n ** 63n) - 1n, -(2n ** 63n)];
	const units = {
		hours: 3_600_000_000_000n, minutes: 60_000_000_000n, seconds: 1_000_000_000n, milliseconds: 1_000_000n, microseconds: 1000n, nanoseconds: 1n,
	};
	for (const nanoseconds of amounts) {
		const duration = parse(`a: ${nanoseconds}ns`).a;
		let actual = 0n;
		for (const [field, size] of Object.entries(units)) {
			actual += BigInt(duration[field]) * size;
			assert.ok(nanoseconds < 0n ? duration[field] <= 0 : duration[field] >= 0);
		}

		assert.equal(actual, nanoseconds);
		assert.equal(getNodeAtPath(parseTree(stringify({a: duration})), ['a']).nanoseconds, nanoseconds);
	}
});

test('shared literal scanning handles EOF and astral characters through all syntax APIs', () => {
	for (const value of ['', '😀', String.raw`\"`, 'a\tb', 'a'.repeat(40_000)]) {
		const source = `a: '${value}'`;
		assert.equal(parse(source).a, value);
		assert.equal(getNodeAtPath(parseTree(source), ['a']).value, value);
		assert.deepEqual(parseForEditor(source).diagnostics, []);
		assert.equal(parse(format(source)).a, value);
	}

	for (const source of ['a: \'', 'a: \'unfinished', 'a: \'unfinished\nb: 1']) {
		assert.throws(() => parse(source), ParseError);
		assert.ok(parseForEditor(source).diagnostics.length > 0);
	}
});

test('numeric keys after missing values remain keys while instants remain values', () => {
	for (const key of ['1', '123', '1234567890123', '2026-09-19T12']) {
		const snapshot = parseForEditor(`a:\n${key}: true`);
		const [first, second] = snapshot.root.children.at(0).members;
		assert.equal(first.value.type, 'EditorMissing');
		assert.equal(second.key.key, key);
	}

	const snapshot = parseForEditor('a:\n2026-09-19T12:00:00Z');
	assert.equal(snapshot.root.children.at(0).members[0].value.scalarKind, 'instant');
	assert.deepEqual(snapshot.diagnostics, []);
});

test('removal finds chains of owned block comments without taking standalone comments', () => {
	const source = '[\n# standalone\n1, /* first */ /* second */ 2 /* trailing */\n]';
	const result = edit(source, [1], undefined);
	assert.deepEqual(parse(result), [1n]);
	assert.ok(result.includes('# standalone'));
	assert.equal(result.includes('first'), false);
	assert.equal(result.includes('second'), false);
	assert.equal(result.includes('trailing'), false);
	assert.equal(edit(source, getNodeAtPath(parseTree(source), [1]), undefined), result);
});

test('every scalar visitor list shares a frozen empty value', () => {
	for (const type of ['Key', 'String', 'Integer', 'Float', 'Boolean', 'Null', 'Instant', 'Duration']) {
		assert.equal(visitorKeys[type], visitorKeys.Key);
		assert.ok(Object.isFrozen(visitorKeys[type]));
		assert.deepEqual(visitorKeys[type], []);
	}
});

test('completion ranges cover whole keys and values at both token boundaries', () => {
	const snapshot = parseForEditor('name: tr');
	for (const [offset, range, prefix, kind] of [[0, [0, 4], '', 'key'], [4, [0, 4], 'name', 'key'], [6, [6, 8], '', 'member-value'], [8, [6, 8], 'tr', 'member-value']]) {
		const context = getCompletionContext(snapshot, offset);
		assert.deepEqual(context.range, range);
		assert.equal(context.prefix, prefix);
		assert.equal(context.slot.kind, kind);
	}
});

test('canonical sorting agrees with code-point order for mixed Unicode prefixes', () => {
	const keys = ['😀x', '😀', '\u{E000}', 'a😀', 'a\u{E000}', 'é', 'a', '𐀀', '𐀀x'];
	const reference = (left, right) => {
		const first = [...left].map(character => character.codePointAt(0));
		const second = [...right].map(character => character.codePointAt(0));
		for (const [index, firstCode] of first.slice(0, second.length).entries()) {
			const secondCode = second[index];
			if (firstCode !== secondCode) {
				return firstCode - secondCode;
			}
		}

		return first.length - second.length;
	};

	assert.deepEqual(keys.toSorted(compareKeys), keys.toSorted(reference));
	const document = stringify(Object.fromEntries(keys.map(key => [key, true])), {canonical: true});
	assert.deepEqual(parseTree(document).body.members.map(member => member.key.value), keys.toSorted(reference));
});

test('block control regex reuse cannot leak state between strings', () => {
	for (const value of ['a\u{0}b', 'plain', '\n', '  ', '\t', 'hello\nworld', '😀']) {
		for (let index = 0; index < 3; index++) {
			assert.equal(parse(`a: ${formatString(value, {style: 'block'})}`).a, value);
		}
	}
});
