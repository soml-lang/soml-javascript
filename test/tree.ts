import {test, suite} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
	parse,
	parseTree,
	evaluate,
	getNodeAt,
	getNodeAtPath,
	stringify,
	visitorKeys,
	ParseError,
	type ArrayNode,
	type Comment,
	type Document,
	type DocumentNode,
	type DurationNode,
	type FloatNode,
	type InstantNode,
	type IntegerNode,
	type Node,
	type ObjectNode,
	type ObjectValue,
	type PathSegment,
	type StringNode,
	type Token,
	type Value,
	type ValueNode,
} from '../source/index.ts';
import {createRandom} from './helpers.ts';

const root = path.join(import.meta.dirname, 'conformance');

function listCases(directory: string): string[] {
	return fs.readdirSync(path.join(root, directory), {recursive: true, encoding: 'utf8'})
		.filter(file => file.endsWith('.soml') && !/\.(?:canonical|formatted)\.soml$/v.test(file))
		.toSorted();
}

function defineMember(object: ObjectValue, key: string, value: Value): void {
	Object.defineProperty(object, key, {
		value,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}

/*
Rebuilds the value a tree describes, so it can be compared with what `parse()` returns.
*/
function toValue(node: ValueNode): Value {
	switch (node.type) {
		case 'Object': {
			const object: ObjectValue = {};

			for (const {key, value} of node.members) {
				defineMember(object, key.value, toValue(value));
			}

			return object;
		}

		case 'Array': {
			return node.elements.map(element => toValue(element));
		}

		case 'Null': {
			return null;
		}

		default: {
			return node.value;
		}
	}
}

/*
Every property of a node that can hold a child. A scalar's `value` is not a node.
*/
type Children = {
	readonly body?: Node;
	readonly members?: readonly Node[];
	readonly key?: Node;
	readonly value?: unknown;
	readonly elements?: readonly Node[];
};

function * walk(node: Node & Children): Generator<Node> {
	yield node;

	for (const child of [node.body, ...(node.members ?? []), node.key, node.value as Node | undefined, ...(node.elements ?? [])]) {
		if (child?.type !== undefined) {
			yield * walk(child);
		}
	}
}

function locate(text: string, offset: number): {line: number; column: number} {
	const before = text.slice(0, offset).split('\n');
	return {line: before.length, column: before.at(-1)!.length};
}

/*
Tokens and comments are in order, do not overlap, each holds exactly its own text, and only whitespace is left between them.
*/
function assertTokens(text: string, tree: DocumentNode): void {
	const items: Array<Token | Comment> = [...tree.tokens, ...tree.comments].toSorted((first, second) => first.range[0] - second.range[0]);
	let end = 0;

	for (const item of items) {
		assert.match(text.slice(end, item.range[0]), /^[\t\n ]*$/v);
		assert.ok(item.range[0] < item.range[1]);
		end = item.range[1];

		if (item.type === 'Line') {
			assert.equal(`#${item.value}`, text.slice(...item.range));
		} else if (item.type === 'Block') {
			assert.equal(`/*${item.value}*/`, text.slice(...item.range));
		} else {
			assert.equal(item.value, text.slice(...item.range));
		}
	}

	assert.match(text.slice(end), /^[\t\n ]*$/v);
}

function assertLocations(text: string, tree: DocumentNode): void {
	for (const item of [...walk(tree), ...tree.tokens, ...tree.comments]) {
		assert.deepEqual(item.loc, {start: locate(text, item.range[0]), end: locate(text, item.range[1])});
	}
}

/*
The sign and the parts of a duration spell its source text.
*/
function assertDurations(text: string, tree: DocumentNode): void {
	for (const node of walk(tree)) {
		if (node.type === 'Duration') {
			assert.equal((node.negative ? '-' : '') + node.parts.map(part => part.number + part.unit).join(''), text.slice(...node.range));
		}
	}
}

function isNode(value: unknown): boolean {
	return typeof value === 'object' && value !== null && 'type' in value && 'range' in value;
}

/*
`visitorKeys` names exactly the properties that hold child nodes, and following it visits every node in source order.
*/
function assertVisitorKeys(tree: DocumentNode): void {
	const visited: Node[] = [];

	const visit = (node: Node) => {
		visited.push(node);
		const record = node as unknown as Record<string, unknown>;
		// `tokens` and `comments` hold tokens, which are not children.
		const childKeys = Object.keys(record).filter(key => key !== 'tokens' && key !== 'comments' && (Array.isArray(record[key]) ? record[key].every(item => isNode(item)) : isNode(record[key])));
		assert.deepEqual(childKeys.toSorted(), visitorKeys[node.type].toSorted(), node.type);

		for (const key of visitorKeys[node.type]) {
			const child = record[key] as Node | Node[];

			for (const descendant of Array.isArray(child) ? child : [child]) {
				visit(descendant);
			}
		}
	};

	visit(tree);
	assert.equal(visited.length, [...walk(tree)].length);

	for (const [index, node] of visited.entries()) {
		assert.ok(index === 0 || node.range[0] >= visited[index - 1]!.range[0], `${node.type} at ${node.range[0]} is out of source order`);
	}
}

suite('conformance', () => {
	for (const file of listCases('valid')) {
		test(`valid/${file}`, () => {
			const text = fs.readFileSync(path.join(root, 'valid', file), 'utf8');
			const tree = parseTree(text);
			assert.equal(stringify(toValue(tree.body) as Document), stringify(parse(text)));
			assertTokens(text, tree);
			assertLocations(text, tree);
			assertDurations(text, tree);
			assertVisitorKeys(tree);
		});
	}

	for (const file of listCases('invalid')) {
		const bytes = fs.readFileSync(path.join(root, 'invalid', file));
		let text: string;

		try {
			// eslint-disable-next-line @typescript-eslint/naming-convention -- `ignoreBOM` is the name the platform API uses.
			text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
		} catch {
			// Invalid UTF-8 cannot be a string, and `parseTree()` takes only strings.
			continue;
		}

		test(`invalid/${file}`, () => {
			const expected = catchError(() => parse(text));
			assert.ok(expected instanceof ParseError);
			assert.deepEqual(catchError(() => parseTree(text)), expected);
		});
	}
});

function catchError(function_: () => unknown): unknown {
	try {
		function_();
	} catch (error) {
		return error;
	}

	assert.fail('Expected an error');
}

suite('parseTree', () => {
	test('visitorKeys is frozen', () => {
		assert.ok(Object.isFrozen(visitorKeys));
		assert.ok(Object.values(visitorKeys).every(keys => Object.isFrozen(keys)));
	});

	test('only takes a string', () => {
		// @ts-expect-error -- Tests that bytes are rejected.
		assert.throws(() => parseTree(new TextEncoder().encode('a: 1')), {name: 'TypeError', message: 'Expected a string, got object'});
		// @ts-expect-error -- Tests that null is rejected.
		assert.throws(() => parseTree(null), {name: 'TypeError', message: 'Expected a string, got null'});
	});

	test('a brace-less object is not braced, and its range covers its members only', () => {
		const tree = parseTree('# Comment\na: 1\n\nb: 2\n');
		assert.equal(tree.type, 'Document');
		assert.deepEqual(tree.range, [0, 21]);
		assert.equal(tree.body.type, 'Object');
		assert.equal(tree.body.braced, false);
		assert.deepEqual(tree.body.range, [10, 20]);
		assert.deepEqual(tree.body.members.map(member => member.range), [[10, 14], [16, 20]]);
	});

	test('braced collections', () => {
		assert.deepEqual(parseTree('{}').body, {
			type: 'Object',
			members: [],
			braced: true,
			range: [0, 2],
			loc: {start: {line: 1, column: 0}, end: {line: 1, column: 2}},
		});

		const tree = parseTree('[1, [], {a: 2},]');
		assert.equal(tree.body.type, 'Array');
		assert.deepEqual(tree.body.elements.map(element => element.type), ['Integer', 'Array', 'Object']);
		assert.deepEqual(tree.tokens.map(token => token.value), ['[', '1', ',', '[', ']', ',', '{', 'a', ':', '2', '}', ',', ']']);
	});

	test('items separated by line breaks have no comma tokens', () => {
		const tree = parseTree('[\n\t1, 2\n\t{\n\t\ta: 3\n\t\tb: 4\n\t}\n]');
		assert.equal(tree.body.type, 'Array');
		assert.deepEqual(tree.body.elements.map(element => element.type), ['Integer', 'Integer', 'Object']);
		assert.deepEqual((tree.body.elements[2] as ObjectNode).members.map(member => member.key.value), ['a', 'b']);
		assert.deepEqual(tree.tokens.map(token => token.value), ['[', '1', ',', '2', '{', 'a', ':', '3', 'b', ':', '4', '}', ']']);
	});

	test('bare and quoted keys', () => {
		const {members} = parseTree(String.raw`{a: 1, 'b.c': 2, "d\n": 3, 404: 4}`).body as ObjectNode;
		assert.deepEqual(members.map(({key: {type, value, style}}) => ({type, value, style})), [
			{type: 'Key', value: 'a', style: 'bare'},
			{type: 'Key', value: 'b.c', style: 'literal'},
			{type: 'Key', value: 'd\n', style: 'escaped'},
			{type: 'Key', value: '404', style: 'bare'},
		]);
		assert.deepEqual(members[1]!.key.range, [7, 12]);
		assert.deepEqual(members[1]!.key.loc, {start: {line: 1, column: 7}, end: {line: 1, column: 12}});
	});

	test('a dot after a key is a parse error', () => {
		assert.throws(() => parseTree('a.b: 1'), {name: 'ParseError', line: 1, column: 2});
	});

	test('keywords are keys in key position', () => {
		const member = (parseTree('true: null').body as ObjectNode).members[0]!;
		assert.equal(member.key.value, 'true');
		assert.equal(member.value.type, 'Null');
		assert.deepEqual(parseTree('true: null').tokens.map(token => token.type), ['BareKey', 'Punctuator', 'Keyword']);
	});

	test('scalars', () => {
		const {elements} = parseTree(String.raw`['a', "b\t", true, false, null, 0, -5, 0xFF, 0o17, 0b10, 1.5, 1e3, infinity, -infinity, 90m, 2026-09-19T14:00:00+02:00]`).body as ArrayNode;
		const types = elements.map(element => element.type);
		assert.deepEqual(types, ['String', 'String', 'Boolean', 'Boolean', 'Null', 'Integer', 'Integer', 'Integer', 'Integer', 'Integer', 'Float', 'Float', 'Float', 'Float', 'Duration', 'Instant']);
		assert.deepEqual((elements.slice(0, 2) as StringNode[]).map(({value, style, block}) => ({value, style, block})), [
			{value: 'a', style: 'literal', block: false},
			{value: 'b\t', style: 'escaped', block: false},
		]);
		assert.deepEqual((elements.slice(5, 10) as IntegerNode[]).map(({value, radix}) => ({value, radix})), [
			{value: 0n, radix: 10},
			{value: -5n, radix: 10},
			{value: 255n, radix: 16},
			{value: 15n, radix: 8},
			{value: 2n, radix: 2},
		]);
		assert.deepEqual((elements.slice(10, 14) as FloatNode[]).map(element => element.value), [1.5, 1000, Infinity, -Infinity]);
		assert.equal((elements[14] as DurationNode).value.total('minutes'), 90);
		assert.equal((elements[15] as InstantNode).value.toString(), '2026-09-19T12:00:00Z');
	});

	test('a duration has its sign and its parts as written', () => {
		const durations = (parseTree('[-1h1.5m, 1_000ms, 0s]').body as ArrayNode).elements as DurationNode[];
		assert.deepEqual(durations.map(({negative, parts}) => ({negative, parts})), [
			{negative: true, parts: [{number: '1', unit: 'h'}, {number: '1.5', unit: 'm'}]},
			{negative: false, parts: [{number: '1_000', unit: 'ms'}]},
			{negative: false, parts: [{number: '0', unit: 's'}]},
		]);
	});

	test('a block string\'s range ends at its closing delimiter, and its value is dedented', () => {
		const text = 'a: {\n\tb: """\n\t\tone\\t\n\t\t\'\'\'\n\t\t""",\n}';
		const value = ((parseTree(text).body as ObjectNode).members[0]!.value as ObjectNode).members[0]!.value as StringNode;
		assert.deepEqual({value: value.value, style: value.style, block: value.block}, {value: 'one\t\n\'\'\'', style: 'escaped', block: true});
		assert.equal(text.slice(...value.range), '"""\n\t\tone\\t\n\t\t\'\'\'\n\t\t"""');
	});

	test('a longer delimiter holds a line that starts with three quotes', () => {
		const value = (parseTree('a: \'\'\'\'\n\t\'\'\'\n\t\'\'\'\'').body as ObjectNode).members[0]!.value as StringNode;
		assert.equal(value.value, '\'\'\'');
	});

	test('comments', () => {
		const tree = parseTree('# one\na: 1 # two\n/* three\nfour */\nb: [/**/]');
		assert.deepEqual(tree.comments.map(({type, value, range}) => ({type, value, range})), [
			{type: 'Line', value: ' one', range: [0, 5]},
			{type: 'Line', value: ' two', range: [11, 16]},
			{type: 'Block', value: ' three\nfour ', range: [17, 33]},
			{type: 'Block', value: '', range: [38, 42]},
		]);
		assert.deepEqual(tree.comments[2]!.loc, {start: {line: 3, column: 0}, end: {line: 4, column: 7}});
	});

	test('a comment directly after a value', () => {
		const tree = parseTree('a: 1#x\nb: \'c\'/*y*/');
		assert.deepEqual(tree.tokens.map(token => token.value), ['a', ':', '1', 'b', ':', '\'c\'']);
		assert.deepEqual(tree.comments.map(comment => comment.value), ['x', 'y']);
	});

	test('columns count UTF-16 code units', () => {
		const tree = parseTree('a: \'😀\'\nb: 1');
		assert.deepEqual((tree.body as ObjectNode).members[0]!.value.loc, {start: {line: 1, column: 3}, end: {line: 1, column: 7}});
	});

	test('a key named __proto__ is an ordinary key', () => {
		const tree = parseTree('__proto__: 1');
		assert.equal((tree.body as ObjectNode).members[0]!.key.value, '__proto__');
	});
});

suite('evaluate', () => {
	test('a document evaluates to its parse', () => {
		const text = '# c\nname: \'api\'\nlimits: {cpu: 1.5, memory: 512}\nports: [80, 443]\n';
		const tree = parseTree(text);
		assert.deepEqual(evaluate(tree), parse(text));
		assert.deepEqual(evaluate(tree.body), parse(text));
	});

	test('a value node evaluates on its own', () => {
		const tree = parseTree('a: 1.5\nb: [true, null, \'x\']\nc: 8080\nd: 0xFF');
		const object = tree.body as ObjectNode;
		assert.equal(evaluate(object.members[0]!.value), 1.5);
		assert.deepEqual(evaluate(object.members[1]!.value), [true, null, 'x']);
		assert.equal(evaluate(object.members[2]!.value), 8080n);
		assert.equal(evaluate(object.members[3]!.value), 255n);
	});

	test('an instant and a duration evaluate to their Temporal values', () => {
		const object = parseTree('t: 2026-09-19T14:00:00.5Z\nd: 1h30m').body as ObjectNode;
		const instant = evaluate(object.members[0]!.value) as Temporal.Instant;
		const duration = evaluate(object.members[1]!.value) as Temporal.Duration;

		const expected = Temporal.Instant.from('2026-09-19T14:00:00.5Z').epochNanoseconds;
		assert.equal(instant.epochNanoseconds, expected);
		assert.equal(duration.toString(), 'PT1H30M');
	});

	test('only a document or a value node is accepted', () => {
		// @ts-expect-error -- Deliberately not a node.
		assert.throws(() => evaluate('a: 1'), {name: 'TypeError', message: 'Expected a document or a value node, got a string'});
		// @ts-expect-error -- Deliberately not a node.
		assert.throws(() => evaluate(null), {name: 'TypeError', message: 'Expected a document or a value node, got null'});
		// @ts-expect-error -- A key is not a value.
		assert.throws(() => evaluate((parseTree('a: 1').body as ObjectNode).members[0]!.key), {name: 'TypeError', message: 'Expected a document or a value node, got a Key node'});
	});

	test('a key named __proto__ is an ordinary member', () => {
		const value = evaluate(parseTree('__proto__: 1')) as ObjectValue;
		assert.equal(Object.hasOwn(value, '__proto__'), true);
		assert.equal(Object.getOwnPropertyDescriptor(value, '__proto__')?.value, 1n);
		assert.deepEqual(value, {['__proto__']: 1n} as ObjectValue);
	});
});

suite('getNodeAt', () => {
	test('the deepest node, token, or comment at an offset', () => {
		const tree = parseTree('a: [1, 2] # note\n');
		const object = tree.body as ObjectNode;
		const array = object.members[0]!.value as ArrayNode;

		// A key, a scalar, and a `:` token and a `[` token, by identity with the tree's own nodes and tokens.
		assert.equal(getNodeAt(tree, 0), object.members[0]!.key);
		assert.equal(getNodeAt(tree, 1), tree.tokens[1]);
		assert.equal(getNodeAt(tree, 3), tree.tokens[2]);
		assert.equal(getNodeAt(tree, 4), array.elements[0]);
		assert.equal(getNodeAt(tree, 7), array.elements[1]);
		// A space between the `:` and the `[` gives the member, and the closing `]` is a token.
		assert.equal(getNodeAt(tree, 2), object.members[0]);
		assert.equal(getNodeAt(tree, 8), tree.tokens[6]);
		// A comment beats the node that holds it.
		assert.equal(getNodeAt(tree, 10), tree.comments[0]);
	});

	test('offsets outside the document or in its leading trivia give undefined', () => {
		assert.equal(getNodeAt(parseTree('a: 1'), 4), undefined);
		assert.equal(getNodeAt(parseTree('# c\n\na: 1'), 4), undefined);
	});

	test('the offset must be a non-negative integer', () => {
		assert.throws(() => getNodeAt(parseTree('a: 1'), 1.5), {name: 'TypeError', message: 'Expected the offset to be a non-negative integer, got 1.5'});
		// @ts-expect-error -- Deliberately not a number.
		assert.throws(() => getNodeAt(parseTree('a: 1'), 'a'), {name: 'TypeError', message: 'Expected the offset to be a non-negative integer, got string'});
		assert.throws(() => getNodeAt(parseTree('a: 1'), -1), {name: 'TypeError', message: 'Expected the offset to be a non-negative integer, got -1'});
	});
});

suite('getNodeAtPath', () => {
	test('the value node at a path, by identity with the tree\'s own nodes', () => {
		const tree = parseTree('servers: [{port: 8080, \'content type\': "json"}]\n');
		const servers = (tree.body as ObjectNode).members[0]!.value as ArrayNode;
		const server = servers.elements[0] as ObjectNode;

		assert.equal(getNodeAtPath(tree, []), tree.body);
		assert.equal(getNodeAtPath(tree, ['servers']), servers);
		assert.equal(getNodeAtPath(tree, ['servers', 0]), server);
		assert.equal(getNodeAtPath(tree, ['servers', 0, 'port']), server.members[0]!.value);
		// A quoted key is found by its decoded value.
		assert.equal(getNodeAtPath(tree, ['servers', 0, 'content type']), server.members[1]!.value);
	});

	test('a path to no value gives undefined', () => {
		const tree = parseTree('a: [1, {b: 2}]\n');

		assert.equal(getNodeAtPath(tree, ['missing']), undefined);
		assert.equal(getNodeAtPath(tree, ['a', 2]), undefined);
		// A key where an array is, an index where an object is, and a path through a scalar.
		assert.equal(getNodeAtPath(tree, ['a', 'b']), undefined);
		assert.equal(getNodeAtPath(tree, [0]), undefined);
		assert.equal(getNodeAtPath(tree, ['a', 0, 'b']), undefined);
		// A key that `Object.prototype` has is not a member.
		assert.equal(getNodeAtPath(tree, ['toString']), undefined);
	});

	test('a top-level array is indexed', () => {
		const tree = parseTree('[1, 2]\n');
		assert.equal(getNodeAtPath(tree, [1]), (tree.body as ArrayNode).elements[1]);
	});

	test('the path must be an array of keys and array indexes', () => {
		const tree = parseTree('a: 1');
		const message = 'The path must be an array of keys and array indexes';

		// @ts-expect-error -- Deliberately not an array.
		assert.throws(() => getNodeAtPath(tree, 'a'), {name: 'TypeError', message});
		assert.throws(() => getNodeAtPath(tree, [-1]), {name: 'TypeError', message});
		assert.throws(() => getNodeAtPath(tree, [1.5]), {name: 'TypeError', message});
		// eslint-disable-next-line no-sparse-arrays -- A hole is not a key, and `Array#some()` skips it.
		const sparsePath = ['a', , 'b'] as PathSegment[];
		assert.throws(() => getNodeAtPath(tree, sparsePath), {name: 'TypeError', message});
	});
});

suite('ranges and locations fit the source', () => {
	const validRoot = path.join(import.meta.dirname, 'conformance', 'valid');
	const files = fs.readdirSync(validRoot, {recursive: true, encoding: 'utf8'})
		.filter(file => file.endsWith('.soml') && !/\.(?:canonical|formatted)\.soml$/v.test(file));

	/*
	The 1-based line and the 0-based UTF-16 column of `offset`, computed independently of the tree, so that a `range` finding the wrong place cannot also fake its `loc`.
	*/
	const positionOf = (text: string, offset: number): {line: number; column: number} => {
		let line = 1;
		let lineStart = 0;

		for (let index = text.indexOf('\n'); index !== -1 && index < offset; index = text.indexOf('\n', index + 1)) {
			line++;
			lineStart = index + 1;
		}

		return {line, column: offset - lineStart};
	};

	test('every token and comment points at its own text', () => {
		const tokens = ['{', '}', '[', ']', ',', ':', '\n', ' ', '\t', '# c\n', '/* c */', '/*\nc */', '\'', '"', '\\', '1', '0xFF', 'true', 'null', '2026-01-01T00:00:00Z', 'a.b', '\'k k\'', '😀', '\u{FEFF}', '\u{2028}'];
		const random = createRandom(12);

		for (let round = 0; round < 500; round++) {
			const chars = [...fs.readFileSync(path.join(validRoot, random.pick(files)), 'utf8')];
			const mutations = random.integer(0, 3);

			for (let mutation = 0; mutation < mutations; mutation++) {
				const position = random.integer(0, chars.length);
				const operation = random.integer(0, 2);

				if (operation === 0) {
					chars.splice(position, 1);
				} else if (operation === 1) {
					chars.splice(position, 0, random.pick(tokens));
				} else {
					chars[position] = random.pick(tokens);
				}
			}

			const text = chars.join('');
			// A mutated document is valid or throws a `ParseError`, and anything else is a real bug that must not be swallowed.
			let tree: DocumentNode | undefined;

			try {
				tree = parseTree(text);
			} catch (error) {
				if (!(error instanceof ParseError)) {
					throw error;
				}

				continue;
			}

			assert.deepEqual(tree.range, [0, text.length]);
			assert.deepEqual(tree.loc, {start: positionOf(text, 0), end: positionOf(text, text.length)});

			for (const token of tree.tokens) {
				assert.equal(text.slice(...token.range), token.value, token.type);
				assert.deepEqual(token.loc, {start: positionOf(text, token.range[0]), end: positionOf(text, token.range[1])});
			}

			for (const comment of tree.comments) {
				const raw = text.slice(...comment.range);
				assert.equal(raw, comment.type === 'Line' ? `#${comment.value}` : `/*${comment.value}*/`);
				assert.deepEqual(comment.loc, {start: positionOf(text, comment.range[0]), end: positionOf(text, comment.range[1])});
			}
		}
	});
});
