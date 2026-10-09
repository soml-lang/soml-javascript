import {test, suite} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
	edit,
	format,
	parse,
	parseTree,
	stringify,
	ParseError,
	type ArrayNode,
	type MemberNode,
	type ObjectNode,
	type PathSegment,
	type Value,
} from '../source/index.ts';
import {
	createRandom,
	normalize,
	randomKey,
	randomValue,
	type Random,
} from './helpers.ts';

function assertEdit(text: string, pathSegments: PathSegment[], value: unknown, expected: string): void {
	assert.equal(edit(text, pathSegments, value), expected);
}

suite('edit', () => {
	test('the examples in the readme', () => {
		assertEdit('name: \'api\' # The service\nport: 8080\n', ['port'], 9090n, 'name: \'api\' # The service\nport: 9090\n');
		assertEdit('postgres: {host: \'db\'}\n', ['postgres', 'port'], 5432n, 'postgres: {host: \'db\', port: 5432}\n');
		assertEdit('a: 1\nb: 2\n', ['a'], undefined, 'b: 2\n');
		assert.equal(edit('port: 8080', ['port'], 9090, {integers: 'number'}), 'port: 9090');
		assert.equal(edit('a: 1\n', ['b'], {y: 1n, x: 2n}, {canonical: true}), 'a: 1\nb: {\n\tx: 2\n\ty: 1\n}\n');
	});

	test('a replaced value is written in canonical form, and the rest keeps its spelling', () => {
		assertEdit('a: 0xFF\nb: 0b11 # Bits\n', ['a'], 255n, 'a: 255\nb: 0b11 # Bits\n');
		assertEdit('a: 1', ['a'], 1, 'a: 1.0');
	});

	test('the members of a new object keep their order, unless the canonical option sorts them', () => {
		assertEdit('a: 1\n', ['b'], {y: 1n, x: {d: 2n, c: 3n}}, 'a: 1\nb: {\n\ty: 1\n\tx: {\n\t\td: 2\n\t\tc: 3\n\t}\n}\n');
		assert.equal(edit('a: 1\n', ['b'], {y: 1n, x: {d: 2n, c: 3n}}, {canonical: true}), 'a: 1\nb: {\n\tx: {\n\t\tc: 3\n\t\td: 2\n\t}\n\ty: 1\n}\n');
	});

	test('a new container is laid out at the indentation of its line', () => {
		assertEdit('a: {\n\tb: 1\n}\n', ['a', 'b'], {c: [1n]}, 'a: {\n\tb: {\n\t\tc: [\n\t\t\t1\n\t\t]\n\t}\n}\n');
	});

	test('a new member goes after the last one, and its comment stays on its line', () => {
		assertEdit('a: {\n\tb: 1 # One\n}\n', ['a', 'c'], 3n, 'a: {\n\tb: 1 # One\n\tc: 3\n}\n');
		assertEdit('a: 1 # One', ['b'], 2n, 'a: 1 # One\nb: 2');
	});

	test('a new member or item on its own line gets no comma, and the commas of the others stay', () => {
		assertEdit('a: {\n\tb: 1\n}\n', ['a', 'c'], 3n, 'a: {\n\tb: 1\n\tc: 3\n}\n');
		assertEdit('a: [\n\t1\n\t2\n]\n', ['a', 2], 3n, 'a: [\n\t1\n\t2\n\t3\n]\n');
		assertEdit('a: {\n\tb: 1, # One\n}\n', ['a', 'c'], 3n, 'a: {\n\tb: 1, # One\n\tc: 3\n}\n');
		assertEdit('a: [\n\t1,\n\t2,\n]\n', ['a', 2], 3n, 'a: [\n\t1,\n\t2,\n\t3\n]\n');
		assertEdit('a: [1 /* x\n*/\n]\n', ['a', 1], 2n, 'a: [1 /* x\n*/\n2\n]\n');
		// The mixed style is valid, and the formatter removes the commas.
		assert.equal(format(edit('a: [\n\t1,\n\t2,\n]\n', ['a', 2], 3n)), 'a: [\n\t1\n\t2\n\t3\n]\n');
	});

	test('a block string that is replaced moves up to the line of its key', () => {
		assertEdit('a:\n\t\'\'\'\n\tx\n\t\'\'\'\nb: 1\n', ['a'], 2n, 'a: 2\nb: 1\n');
		assertEdit('x: {\n\ta:\n\t\t\'\'\'\n\t\tx\n\t\t\'\'\'\n}\n', ['x', 'a'], [1n], 'x: {\n\ta: [\n\t\t1\n\t]\n}\n');
		assertEdit('a: # c\n\t\'\'\'\n\tx\n\t\'\'\'\n', ['a'], 2n, 'a: # c\n\t2\n');
	});

	test('a new member in a one-line object stays on that line', () => {
		assertEdit('a: {b: 1}', ['a', 'c'], 2n, 'a: {b: 1, c: 2}');
		assertEdit('a: {b: 1,}', ['a', 'c'], 2n, 'a: {b: 1, c: 2,}');
		assertEdit('[1, 2]', [2], 3n, '[1, 2, 3]');
		assertEdit('a: [\n\t1\n\t2]', ['a', 2], 3n, 'a: [\n\t1\n\t2, 3]');
	});

	test('a new item in an empty container gets its own line, unless the container is inside a container on one line', () => {
		assertEdit('a: { # None yet\n}', ['a', 'b'], 1n, 'a: { # None yet\n\tb: 1\n}');
		assertEdit('a: [\n]', ['a', 0], 'x', 'a: [\n\t\'x\'\n]');
		assertEdit('a: []', ['a', 0], 'x', 'a: [\n\t\'x\'\n]');
		assertEdit('a: [ ]', ['a', 0], {b: [1n]}, 'a: [\n\t{\n\t\tb: [\n\t\t\t1\n\t\t]\n\t}\n]');
		assertEdit('deps: {}', ['deps', 'a'], '1.0', 'deps: {\n\ta: \'1.0\'\n}');
		assertEdit('{}', ['a'], 1n, '{\n\ta: 1\n}');
		assertEdit('a: [1, []]', ['a', 1, 0], 2n, 'a: [1, [2]]');
		assertEdit('a: {b: 1, c: {}}', ['a', 'c', 'd'], [1n], 'a: {b: 1, c: {d: [1]}}');
		assertEdit('[/* None yet */]', [0], 1n, '[/* None yet */ 1]');
	});

	test('a new value in a container on one line is on one line', () => {
		assertEdit('a: [1, 2]', ['a', 2], {b: 1n, c: [true]}, 'a: [1, 2, {b: 1, c: [true]}]');
		assertEdit('a: {x: 1}', ['a', 'x'], [1n, {y: 2n}], 'a: {x: [1, {y: 2}]}');
		assertEdit('a: {x: 1}', ['a', 'y', 'z'], 2n, 'a: {x: 1, y: {z: 2}}');
		assertEdit('a: 1', ['a'], {b: 1n}, 'a: {\n\tb: 1\n}');
	});

	test('missing objects on the way are created', () => {
		assertEdit('x: 1\n', ['a', 'b', 'c'], true, 'x: 1\na: {\n\tb: {\n\t\tc: true\n\t}\n}\n');
	});

	test('a key that needs quotes is quoted', () => {
		assertEdit('x: 1\n', ['the name'], 'y', 'x: 1\n\'the name\': \'y\'\n');
		assertEdit('x: 1\n', ['a.b'], 'y', 'x: 1\n\'a.b\': \'y\'\n');
		assertEdit('\'a.b\': 1\na: {b: 2}\n', ['a.b'], 3n, '\'a.b\': 3\na: {b: 2}\n');
	});

	test('a key named __proto__ is an ordinary member', () => {
		const edited = edit('x: 1\n', ['__proto__', 'polluted'], true);
		assert.equal(edited, 'x: 1\n__proto__: {\n\tpolluted: true\n}\n');
		assert.ok(Object.hasOwn(parse(edited), '__proto__'));
		assert.ok(!Object.hasOwn(Object.prototype, 'polluted'));
	});

	test('a removed member takes its line, with the comment at its end', () => {
		assertEdit('# Head\na: 1 # One\nb: 2\n', ['a'], undefined, '# Head\nb: 2\n');
		assertEdit('x: [\n\t1,\n\t2, # Two\n\t3,\n]', ['x', 1], undefined, 'x: [\n\t1,\n\t3,\n]');
		// A block comment that runs into the next line takes the comments after it on that line too.
		assertEdit('[\n\t1, /* a\n\t*/ /* b */\n\t2,\n]', [0], undefined, '[\n\t2,\n]');
	});

	test('a removed item that shares its line takes only itself and its comma, or the comma before it when it is last', () => {
		assertEdit('x: [1, 2, 3]', ['x', 1], undefined, 'x: [1, 3]');
		assertEdit('x: [1, 2]', ['x', 1], undefined, 'x: [1]');
		assertEdit('x: {a: 1, b: 2} # c', ['x', 'b'], undefined, 'x: {a: 1} # c');
		assertEdit('x: [1 /* c */, 2]', ['x', 1], undefined, 'x: [1 /* c */]');
		assertEdit('x: [1, 2 # c\n]', ['x', 1], undefined, 'x: [1\n]');
		assertEdit('x: [1, 2 /* c */]', ['x', 1], undefined, 'x: [1]');
		assertEdit('x: [1, /* c */ 2 /* t */]', ['x', 1], undefined, 'x: [1]');
		assertEdit('x: [1 /* a */, 2 /* t */]', ['x', 1], undefined, 'x: [1 /* a */]');
		assertEdit('x: [1 /* a */, 2 /* t */]', ['x', 0], undefined, 'x: [2 /* t */]');
		assertEdit('{x: 1 /* a */, y: 2 /* t */}', ['y'], undefined, '{x: 1 /* a */}');
		assertEdit('x: [1, /* c */ 2]', ['x', 1], undefined, 'x: [1]');
		assertEdit('x: [/* c */ 1, 2]', ['x', 0], undefined, 'x: [2]');
		assertEdit('x: [/* c */ 1]', ['x', 0], undefined, 'x: []');
		assertEdit('{x: 1, a: {b: 1, c: 2}}', ['a'], undefined, '{x: 1}');
		assertEdit('x: [1, 2, 3,]', ['x', 2], undefined, 'x: [1, 2,]');
		assertEdit('x: [\n\t1, 2,\n]', ['x', 1], undefined, 'x: [\n\t1,\n]');
		assertEdit('/* Note */ a: 1\nb: 2', ['a'], undefined, 'b: 2');
		assertEdit('# Note\na: 1\nb: 2', ['a'], undefined, '# Note\nb: 2');
	});

	test('a removed item leaves a separator between its neighbors', () => {
		assertEdit('x: [\n\t1\n\t2\n\t3\n]', ['x', 1], undefined, 'x: [\n\t1\n\t3\n]');
		assertEdit('x: [1, 2\n\t3]', ['x', 1], undefined, 'x: [1,\n\t3]');
		assertEdit('x: [1\n\t2, 3]', ['x', 1], undefined, 'x: [1\n\t3]');
		assertEdit('x: [1, 2\n\t3]', ['x', 0], undefined, 'x: [2\n\t3]');
		assertEdit('x: {a: 1 # One\n\tb: 2}', ['x', 'a'], undefined, 'x: {\n\tb: 2}');
	});

	test('the comments that a removed item owns go with it, as the formatter keeps them with it', () => {
		assertEdit('[1 /* a */ , 2]', [0], undefined, '[2]');
		assertEdit('[1, 2 /* a */ /* b */, # c\n 3]', [1], undefined, '[1,\n 3]');
		assertEdit('[1, /* a */ 2, 3]', [1], undefined, '[1, 3]');
		// The removed member is the last one, so it takes the comma before it too.
		assertEdit('{x: 1, a: 2 /* c */}', ['a'], undefined, '{x: 1}');
		// A comment on a line of its own belongs to no item, so it stays.
		assertEdit('x: [\n\t1\n\t# About 2\n\t2\n]', ['x', 1], undefined, 'x: [\n\t1\n\t# About 2\n]');
	});

	test('a new item goes after the comments that the item before it owns', () => {
		assertEdit('x: [1, 2 /* About 2 */]', ['x', 2], 3n, 'x: [1, 2 /* About 2 */, 3]');
		assertEdit('x: [\n\t1\n\t2 # About 2\n]', ['x', 2], 3n, 'x: [\n\t1\n\t2 # About 2\n\t3\n]');
		assertEdit('x: [\n\t1\n\t# More later\n]', ['x', 1], 2n, 'x: [\n\t1\n\t2\n\t# More later\n]');
		// An item added to a container that holds only a comment owns that comment, so removing it again removes the comment too.
		assertEdit('x: [/* None yet */]', ['x', 0], 1n, 'x: [/* None yet */ 1]');
		assertEdit('x: [/* None yet */ 1]', ['x', 0], undefined, 'x: []');
	});

	test('a removed line does not leave two blank lines, or one directly inside a bracket', () => {
		assertEdit('a: 1\n\nb: 2\n\nc: 3\n', ['b'], undefined, 'a: 1\n\nc: 3\n');
		assertEdit('a: 1\n\nb: 2\n', ['b'], undefined, 'a: 1\n');
		assertEdit('{\n\ta: 1,\n\n\tb: 2,\n}\n', ['a'], undefined, '{\n\tb: 2,\n}\n');
		assertEdit('{\n\ta: 1,\n\n\tb: 2,\n}\n', ['b'], undefined, '{\n\ta: 1,\n}\n');
		assertEdit('# Lead\n\na: 1\n\nb: 2\n', ['a'], undefined, '# Lead\n\nb: 2\n');
		assertEdit('\n\ta: 1\n\t\nb: 2\n', ['a'], undefined, '\t\nb: 2\n');
		assertEdit('x: {\n\ta: {\n\t\tb: 1\n\t},\n\n\tq: 1,\n}\n', ['x', 'a'], undefined, 'x: {\n\tq: 1,\n}\n');
	});

	test('an item after a block comment that starts on an earlier line is indented as that line', () => {
		assertEdit('{\n\t/* a\n b */ x: 1\n}\n', ['y'], 2n, '{\n\t/* a\n b */ x: 1\n\ty: 2\n}\n');
		assertEdit('[\n\t/* a\n b */ \'s\'\n]\n', [1], 1n, '[\n\t/* a\n b */ \'s\'\n\t1\n]\n');
		assertEdit('{\n\t/* a\n b */ x: 1\n}\n', ['x'], {a: 1n}, '{\n\t/* a\n b */ x: {\n\t\ta: 1\n\t}\n}\n');
	});

	test('removing every item of a container closes it up, unless a comment is left inside', () => {
		assertEdit('a: [\n\t1,\n]\n', ['a', 0], undefined, 'a: []\n');
		assertEdit('{\n\ta: 1,\n}\n', ['a'], undefined, '{}\n');
		assertEdit('a: {\n\tp: {x: 1},\n}\n', ['a', 'p'], undefined, 'a: {}\n');
		assertEdit('a: [\n\t# Kept\n\t1,\n]\n', ['a', 0], undefined, 'a: [\n\t# Kept\n]\n');
	});

	test('removing the only member of a document without braces leaves an empty object', () => {
		assertEdit('# Head\na: 1\n', ['a'], undefined, '# Head\n{}\n');
		assertEdit('{a: 1}', ['a'], undefined, '{}');
	});

	test('an object is replaced or removed as one', () => {
		assertEdit('p: {h: 1, k: 3}\nq: 2\n', ['p'], 'gone', 'p: \'gone\'\nq: 2\n');
		assertEdit('p: {\n\th: 1\n\tk: 3\n}\nq: 2\n', ['p'], undefined, 'q: 2\n');
	});

	test('removing a missing value changes nothing', () => {
		assertEdit('a: 1 # One\n', ['b'], undefined, 'a: 1 # One\n');
		assertEdit('a: [1]', ['a', 1], undefined, 'a: [1]');
	});

	test('a block string item before an added or removed item', () => {
		assertEdit('a: [\n\t\'\'\'\n\t\tx\n\t\t\'\'\'\n]\n', ['a', 1], 2n, 'a: [\n\t\'\'\'\n\t\tx\n\t\t\'\'\'\n\t2\n]\n');
		assertEdit('a: [\n\t\'\'\'\n\t\tx\n\t\t\'\'\'\n\t2\n]\n', ['a', 0], undefined, 'a: [\n\t2\n]\n');
	});

	test('items of a top-level array', () => {
		assertEdit('[\n\t1\n\t2\n\t3\n]\n', [1], undefined, '[\n\t1\n\t3\n]\n');
		assertEdit('[\n\t1\n]\n', [0], undefined, '[]\n');
		assertEdit('[\n\t/* x\n\t*/ /* y\n\t*/ 1\n]\n', [1], 2n, '[\n\t/* x\n\t*/ /* y\n\t*/ 1\n\t2\n]\n');
	});

	test('a block string is moved over as a whole', () => {
		assertEdit('s: \'\'\'\n\tx\n\t\'\'\'\n', ['t'], 1n, 's: \'\'\'\n\tx\n\t\'\'\'\nt: 1\n');
		assertEdit('a: {b: \'\'\'\n\tx\n\t\'\'\'}', ['a', 'c'], 1n, 'a: {b: \'\'\'\n\tx\n\t\'\'\', c: 1}');
	});

	test('a long path, or one with characters a terminal acts on, is shown short and escaped in an error', () => {
		assert.throws(() => edit('a: 1', Array.from({length: 1000}, () => 'a'), 1n), (error: Error) => error.message.length < 300 && error.message.includes('a.a.…'));
		assert.throws(() => edit('a: 1', ['a', '\u{9B}2J\u{202E}'], 1n), {message: String.raw`Cannot edit a."\u{9b}2J\u{202e}", because a is not an object or an array`});
	});

	test('a path through a value that is not a container throws a TypeError', () => {
		assert.throws(() => edit('a: 1', ['a', 'b'], 1n), {name: 'TypeError', message: 'Cannot edit a.b, because a is not an object or an array'});
		assert.throws(() => edit('a: [1]', ['a', 'b'], 1n), {name: 'TypeError', message: 'Cannot edit a.b, because a is an array, so it needs an index, not a key'});
		assert.throws(() => edit('a: {}', ['a', 0], 1n), {name: 'TypeError', message: 'Cannot edit a[0], because a is an object, so it needs a key, not an index'});
		assert.throws(() => edit('[1]', ['a'], 1n), {name: 'TypeError', message: 'Cannot edit a, because the document is an array, so it needs an index, not a key'});
		assert.throws(() => edit('a: {b: {c: 1}}', ['a', 'b', 0, 'x'], undefined), {name: 'TypeError', message: 'Cannot edit a.b[0].x, because a.b is an object, so it needs a key, not an index'});
		// A key with a dot is quoted, so that it is not read as two keys.
		assert.throws(() => edit('\'a.b\': 1', ['a.b', 'c'], 1n), {name: 'TypeError', message: 'Cannot edit "a.b".c, because "a.b" is not an object or an array'});
	});

	test('removing what is not there changes nothing, also at an index past the end', () => {
		for (const [text, keys] of [
			['a: [1, 2]', ['a', 2]],
			['a: [1, 2]', ['a', 5]],
			['a: [1, 2]', ['a', 5, 'x']],
			['[1]', [3]],
			['a: 1', ['b']],
			['a: 1', ['b', 'c']],
			['a: 1', ['b', 0]],
		] as Array<[string, PathSegment[]]>) {
			assert.equal(edit(text, keys, undefined), text, JSON.stringify(keys));
		}
	});

	test('setting at an index past the end throws a RangeError', () => {
		assert.throws(() => edit('a: [1]', ['a', 3], 1n), {name: 'RangeError', message: 'Cannot edit a[3], because the array at a has 1 item. Add an item at index 1'});
		assert.throws(() => edit('[1, 2]', [5], 1n), {name: 'RangeError', message: 'Cannot edit [5], because the document has 2 items. Add an item at index 2'});
		assert.throws(() => edit('a: 1', ['b', 0], 1n), {name: 'RangeError', message: 'Cannot edit b[0], because b does not exist, so it has no index 0'});
	});

	test('the arguments are checked', () => {
		// eslint-disable-next-line no-sparse-arrays -- A hole is not a key, and `Array#some()` skips it.
		for (const badPath of [[], [-1], [1.5], [Symbol('a')], [null], ['b', , 'c'], ['b', ,]]) {
			assert.throws(() => edit('a: 1', badPath as PathSegment[], 1n), {name: 'TypeError', message: 'The path must be a non-empty array of keys and array indexes'});
		}

		// A node instead of a path must be a member or a value node from the same document.
		assert.throws(() => edit('a: 1', 'a' as unknown as MemberNode, 1n), {name: 'TypeError', message: /Expected a member or a value node, got a string/v});
		assert.throws(() => edit('a: 1', (parseTree('b: 22').body as ObjectNode).members[0]!.value, 1n), {name: 'TypeError', message: /not a member or a value of the document/v});
		assert.throws(() => edit('a: 1', parseTree('a: 1').body, 1n), {name: 'TypeError', message: /own collection cannot be edited/v});

		assert.throws(() => edit(1 as unknown as string, ['a'], 1n), {name: 'TypeError', message: 'Expected a string, got number'});
		assert.throws(() => edit('a: b', ['a'], 1n), ParseError);
		assert.throws(() => edit('a: 1', ['a'], NaN), {name: 'TypeError'});
		assert.throws(() => edit('a: 1', ['a'], () => 1), {name: 'TypeError'});
		assert.throws(() => edit('a: 1', ['a'], 1n, {integers: 'int' as 'number'}), {name: 'TypeError'});
		assert.throws(() => edit('a: 1', ['a'], undefined, {canonical: 'yes' as unknown as boolean}), {name: 'TypeError', message: 'The `canonical` option must be a boolean, got string'});
	});

	test('the nesting limit counts from where the value goes', () => {
		const deep = `${'a: {'.repeat(98)}a: 1${'}'.repeat(98)}`;
		assert.equal(edit(deep, Array.from({length: 99}, () => 'a'), {}), `${'a: {'.repeat(98)}a: {}${'}'.repeat(98)}`);
		assert.throws(() => edit(deep, Array.from({length: 99}, () => 'a'), {b: {}}), {name: 'RangeError'});
	});
});

suite('edit with a node', () => {
	test('a node edits the same thing as its path', () => {
		const text = 'name: \'api\' # The service\nport: 8080\nlabels: [\'a\', \'b\', \'c\']\n';
		const object = parseTree(text).body as ObjectNode;
		const member = object.members[1]!;
		const array = object.members[2]!.value as ArrayNode;

		assert.equal(edit(text, member, 9090n), edit(text, ['port'], 9090n));
		assert.equal(edit(text, member.value, 9090n), edit(text, ['port'], 9090n));
		assert.equal(edit(text, object.members[0]!, undefined), edit(text, ['name'], undefined));
		assert.equal(edit(text, array.elements[1]!, 'x'), edit(text, ['labels', 1], 'x'));
		assert.equal(edit(text, array.elements[1]!, undefined), edit(text, ['labels', 1], undefined));
	});

	test('a node from a later parse of the same text matches', () => {
		// The node is found by its type and span, not by identity, so the parse inside `edit()` matches.
		const text = 'a: 1\n';
		const member = (parseTree(text).body as ObjectNode).members[0]!;
		assert.equal(edit(text, member, 2n), 'a: 2\n');
	});

	test('an object value is replaced or removed as a whole', () => {
		const text = 'postgres: {host: \'db\'}\n';
		const {members} = parseTree(text).body as ObjectNode;
		const {value} = members[0]!;
		assert.equal(edit(text, value, {port: 5432n}), edit(text, ['postgres'], {port: 5432n}));
		assert.equal(edit(text, value, undefined), edit(text, ['postgres'], undefined));
	});
});

/*
Sets or removes the value at `path` in a parsed document, as `edit()` should in the text. Missing objects on the way are created.
*/
function applyEdit(document: unknown, pathSegments: PathSegment[], value: unknown): void {
	let target = document as Record<PathSegment, unknown>;

	for (const segment of pathSegments.slice(0, -1)) {
		if (!Object.hasOwn(target, segment)) {
			Object.defineProperty(target, segment, {
				value: {},
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}

		target = target[segment] as Record<PathSegment, unknown>;
	}

	const last = pathSegments.at(-1)!;

	if (Array.isArray(target)) {
		if (value === undefined) {
			target.splice(last as number, 1);
		} else {
			target[last as number] = value;
		}
	} else if (value === undefined) {
		delete target[last]; // eslint-disable-line @typescript-eslint/no-dynamic-delete
	} else {
		Object.defineProperty(target, last, {
			value,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
}

/*
A path into `document`: to an existing value, to a missing key, or to the end of an array, sometimes with more missing keys after it.
*/
function randomPath(random: Random, document: Value): {pathSegments: PathSegment[]; exists: boolean} {
	const pathSegments: PathSegment[] = [];
	let current = document as Value[] | Record<string, Value>;

	for (;;) {
		const keys: PathSegment[] = Array.isArray(current) ? current.map((_item, index) => index) : Object.keys(current);

		if (keys.length === 0 || random.next() < 0.2) {
			pathSegments.push(Array.isArray(current) ? current.length : missingKey(random, current));

			for (let extra = random.integer(-2, 2); extra > 0; extra--) {
				pathSegments.push(randomKey(random));
			}

			return {pathSegments, exists: false};
		}

		const key = random.pick(keys);
		pathSegments.push(key);
		const child = (current as Record<PathSegment, Value>)[key]!;
		const isContainer = typeof child === 'object' && child !== null && (Array.isArray(child) || Object.getPrototypeOf(child) === Object.prototype);

		if (!isContainer || random.next() < 0.4) {
			return {pathSegments, exists: true};
		}

		current = child as Value[] | Record<string, Value>;
	}
}

function missingKey(random: Random, object: Record<string, Value>): string {
	let key = randomKey(random);

	while (Object.hasOwn(object, key)) {
		key = randomKey(random);
	}

	return key;
}

const root = path.join(import.meta.dirname, 'conformance', 'valid');

const files = fs.readdirSync(root, {recursive: true, encoding: 'utf8'})
	.filter(file => file.endsWith('.soml') && !/\.(?:canonical|formatted)\.soml$/v.test(file))
	.toSorted();

const commentTexts = (text: string): string[] => parseTree(text).comments.map(comment => comment.value);

suite('edit changes the value as the same change to the parsed value does', () => {
	for (const [index, file] of files.entries()) {
		test(file, () => {
			const text = fs.readFileSync(path.join(root, file), 'utf8');
			const formattedText = format(text);
			const random = createRandom(index);

			for (let round = 0; round < 5; round++) {
				const expected = parse(text);
				const {pathSegments, exists} = randomPath(random, expected);
				const value = exists && random.next() < 0.3 ? undefined : randomValue(random, 3);
				const label = `${JSON.stringify(pathSegments)} = ${value === undefined ? 'undefined' : stringify([value])}`;
				applyEdit(expected, pathSegments, value);

				let isTooDeep = false;

				try {
					stringify(expected);
				} catch (error) {
					isTooDeep = error instanceof RangeError;
				}

				if (isTooDeep) {
					assert.throws(() => edit(text, pathSegments, value), RangeError, label);
					continue;
				}

				const edited = edit(text, pathSegments, value);
				assert.deepEqual(normalize(parse(edited)), normalize(expected), `${label}\n${edited}`);

				// Only the comments inside a replaced or removed value can go away.
				const before = commentTexts(text);
				const after = commentTexts(edited);
				assert.ok(after.every(comment => before.includes(comment)), `${label}: a comment changed\n${edited}`);

				if (!exists) {
					assert.deepEqual(after, before, `${label}: a comment was lost\n${edited}`);
				}

				// Setting the same value again changes nothing.
				if (value !== undefined) {
					assert.equal(edit(edited, pathSegments, value), edited, label);
				}

				// An edit to a formatted document leaves it formatted. The formatted text has the same value, comments, and blank lines.
				const editedFormatted = edit(formattedText, pathSegments, value);
				assert.equal(format(editedFormatted), editedFormatted, `${label}: not formatted\n${editedFormatted}`);
			}
		});
	}
});
