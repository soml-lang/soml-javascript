import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	applyEdits,
	edit,
	editEdits,
	evaluate,
	format,
	formatCollectionEdits,
	formatEdits,
	formatString,
	getCompletionContext,
	getEditorContext,
	getNodeAt,
	getNodeAtPath,
	parse,
	parseForEditor,
	parseTree,
	ParseError,
	stringify,
	type PathSegment,
	type ValueNode,
	type MemberNode,
} from '../source/index.ts';
import {createRandom, normalize} from './helpers.ts';

/*
Count observable sibling reads rather than elapsed time, so logarithmic lookup tests are deterministic even on a busy machine.
*/
function trackIndexReads<Items extends readonly unknown[]>(items: Items) {
	let reads = 0;
	return {
		items: new Proxy(items, {
			get(array, key, receiver) {
				if (typeof key === 'string' && /^\d+$/v.test(key)) {
					reads++;
				}

				return Reflect.get(array, key, receiver) as unknown;
			},
		}),
		get reads() {
			return reads;
		},
	};
}

test('byte decoding recovers after alternating malformed and truncated inputs', () => {
	const encoder = new TextEncoder();
	for (const invalid of [[0xFF], [0xE2, 0x82], [0xED, 0xA0, 0x80], [0xF0, 0x9F, 0x98]]) {
		assert.throws(() => parse(new Uint8Array(invalid)), ParseError);
		assert.deepEqual(parse(encoder.encode('value: \'é😀\'')), {value: 'é😀'});
		assert.throws(() => parse(encoder.encode('\u{FEFF}value: 1')), {reason: /BOM/v});
		assert.deepEqual(parse(encoder.encode('value: 2')), {value: 2n});
	}
});

test('byte decoding does not carry state between adjacent views of one buffer', () => {
	const texts = ['first: \'😀\'', 'second: 1.25', 'third: \'é\'', 'fourth: null'];
	const encoder = new TextEncoder();
	const encoded = texts.map(text => encoder.encode(text));
	const bytes = new Uint8Array(encoded.flatMap(value => [0xFF, ...value]));
	let offset = 0;
	for (const [index, value] of encoded.entries()) {
		const invalid = bytes.subarray(offset, offset + 1);
		assert.throws(() => parse(invalid), ParseError);
		assert.deepEqual(parse(bytes.subarray(offset + 1, offset + 1 + value.length)), parse(texts[index]!));
		offset += value.length + 1;
	}
});

test('strict and editor string scanners remain independent across repeated calls', () => {
	for (let index = 0; index < 20; index++) {
		const text = String.raw`"key\u{1f600}": ["plain", "quote\"", 'literal\\', "tail\\"]`;
		assert.deepEqual(parse(text), {'key😀': ['plain', 'quote"', 'literal\\\\', 'tail\\']});
		assert.deepEqual(parseForEditor(text).diagnostics, []);
		assert.deepEqual(evaluate(parseTree(text)), parse(text));
	}
});

test('long strings containing punctuation and comment openers remain a single editor token', () => {
	const value = '[]{}:#/* not a comment */😀'.repeat(3000);
	const text = `value: ${formatString(value, {style: 'escaped'})}`;
	const snapshot = parseForEditor(text);
	assert.deepEqual(snapshot.diagnostics, []);
	assert.equal(snapshot.tokens.length, 3);
	assert.equal(snapshot.tokens[2]!.kind, 'string');
	assert.equal(snapshot.tokens[2]!.range[1], text.length);
	assert.equal(getCompletionContext(snapshot, text.length - 1), undefined);
	assert.deepEqual(evaluate(parseTree(text)), {value});
});

test('editor recovery stops a dangling escape at LF and keeps the following member', () => {
	const text = 'bad: "dangling\\\ngood: "plain"';
	const snapshot = parseForEditor(text);
	const root = snapshot.root.children.at(0);
	assert.equal(root?.type, 'EditorObject');
	assert.equal(root.members.length, 2);
	const member = root.members[1];
	assert.equal(member?.type, 'EditorMember');
	assert.equal(member.key.type, 'EditorKey');
	assert.equal(member.key.key, 'good');
	assert.equal(member.value.type, 'EditorScalar');
	assert.deepEqual(snapshot.tokens.find(token => token.kind === 'string')?.range, [5, text.indexOf('\n')]);
});

test('escaped quote runs do not swallow the separator or following key', () => {
	const value = String.raw`"\"\\"`.repeat(1000);
	const text = `{first: ${formatString(value, {style: 'escaped'})}, second: 42}`;
	assert.deepEqual(parse(text), {first: value, second: 42n});
	assert.deepEqual(evaluate(parseTree(text)), parse(text));
	const snapshot = parseForEditor(text);
	assert.deepEqual(snapshot.diagnostics, []);
	assert.equal(getCompletionContext(snapshot, text.indexOf('second') + 3)?.prefix, 'sec');
});

test('escaped block parsing distinguishes raw blank lines from decoded whitespace', () => {
	const text = 'value: """\n \t\n  \\t\n  \n  plain\n  \\u{20}\n  \n  """';
	assert.deepEqual(parse(text), {value: '\t\n\nplain\n '});
	assert.deepEqual(evaluate(parseTree(format(text))), {value: '\t\n\nplain\n '});
});

test('block indentation validation still precedes decoding earlier invalid escapes', () => {
	const text = 'value: """\n  \\q\n wrong\n  """';
	assert.throws(() => parse(text), {reason: /indentation/v, offset: text.indexOf(' wrong')});
	const snapshot = parseForEditor(text);
	assert.match(snapshot.diagnostics[0]!.message, /indentation/v);
});

test('block strings retain non-ASCII whitespace while trimming ASCII blank boundaries', () => {
	const text = 'value: \'\'\'\n  \n  \u{A0}\n  \u{2003}\n  \t\n  \'\'\'';
	const expected = {value: '\u{A0}\n\u{2003}'};
	assert.deepEqual(parse(text), expected);
	assert.deepEqual(evaluate(parseTree(format(text))), expected);
	assert.deepEqual(parseForEditor(text).diagnostics, []);
});

test('bounded thousands-separator diagnostics keep their position near EOF', () => {
	const text = `[111${',111'.repeat(10_000)},000]`;
	assert.throws(() => parse(text, {integers: 'number'}), error => {
		assert.ok(error instanceof ParseError);
		assert.equal(error.offset, text.length - 4);
		assert.match(error.reason, /A comma separates items/v);
		assert.ok(error.message.length < 500);
		assert.ok(!error.reason.includes('Write it as'));
		return true;
	});
});

test('every member and value in a heterogeneous tree edits the same value as its path', () => {
	const text = '{10: {2: [[], {x: 0xFF}]}, \'a.b\': [{c: \'😀\'}, 1.5], empty: {}, last: false}';
	const tree = parseTree(text);
	const targets: Array<{node: ValueNode | MemberNode; path: PathSegment[]}> = [];
	function collect(node: ValueNode, path: PathSegment[]): void {
		if (path.length > 0) {
			targets.push({node, path});
		}

		if (node.type === 'Array') {
			for (const [index, element] of node.elements.entries()) {
				collect(element, [...path, index]);
			}
		} else if (node.type === 'Object') {
			for (const member of node.members) {
				const memberPath = [...path, member.key.value];
				targets.push({node: member, path: memberPath});
				collect(member.value, memberPath);
			}
		}
	}

	collect(tree.body, []);
	assert.equal(targets.length, 18);
	for (const {node, path} of targets) {
		for (const value of [null, {new: [true, 2n]}, undefined]) {
			assert.equal(edit(text, node, value), edit(text, path, value));
			assert.deepEqual(editEdits(text, node, value), editEdits(text, path, value));
		}
	}
});

test('node targeting uses source order for many integer-like object keys', () => {
	const entries = Array.from({length: 2000}, (_, index) => `${2000 - index}: [${index}, {value: ${index}}]`);
	const text = `{${entries.join(',')}}`;
	const tree = parseTree(text);
	const target = getNodeAtPath(tree, ['1', 1, 'value']);
	assert.ok(target);
	const changed = edit(text, target, 99n);
	assert.equal(changed, edit(text, ['1', 1, 'value'], 99n));
	assert.equal(changed.slice(0, text.lastIndexOf('value:')), text.slice(0, text.lastIndexOf('value:')));
});

test('node targeting reaches the deepest first child without losing empty sibling ranges', () => {
	const text = `[${'['.repeat(90)}{}, []${']'.repeat(90)}, {}]`;
	const path = Array.from({length: 91}, () => 0);
	const node = getNodeAtPath(parseTree(text), path);
	assert.equal(node?.type, 'Object');
	assert.equal(edit(text, node, 7n), edit(text, path, 7n));
});

test('no-op editing still strictly validates a malformed document', () => {
	for (const text of ['a:', '{a: 1, a: 2}', '[1\n,2]', 'value: "unfinished']) {
		assert.throws(() => edit(text, ['missing'], undefined), ParseError);
		assert.throws(() => editEdits(text, ['missing'], undefined), ParseError);
	}
});

test('unchanged temporal edits preserve original spelling and return no text edits', () => {
	const text = 'instant: 2026-09-19T14:00:00Z\nduration: 1h2m3.004005006s';
	const value = parse(text);
	assert.ok(!Array.isArray(value));
	for (const key of ['instant', 'duration']) {
		assert.equal(edit(text, [key], value[key]), text);
		assert.deepEqual(editEdits(text, [key], value[key]), []);
	}
});

test('a sequence of array insertions replacements and removals matches an independent data model', () => {
	const random = createRandom(73);
	const values: bigint[] = [];
	let text = '[]';
	for (let step = 0; step < 80; step++) {
		const index = random.integer(0, values.length);
		const value = random.boolean() ? BigInt(step) : undefined;
		if (value === undefined) {
			values.splice(index, 1);
		} else if (index === values.length) {
			values.push(value);
		} else {
			values[index] = value;
		}

		text = applyEdits(text, editEdits(text, [index], value));
		assert.deepEqual(parse(text), values);
		assert.equal(format(format(text)), format(text));
	}
});

test('created prototype-like parents remain own data properties through serialization and evaluation', () => {
	const path = ['__proto__', 'constructor', 'toString'];
	const text = edit('{}', path, 'safe');
	const parsed = parse(text);
	assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
	assert.deepEqual(evaluate(parseTree(text)), parsed);
	assert.deepEqual(parse(stringify(parsed)), parsed);
	assert.equal(getNodeAtPath(parseTree(text), path)?.type, 'String');
	assert.equal(Object.hasOwn(parsed, '__proto__'), true);
});

test('sparse paths are rejected consistently by lookup and editing', () => {
	const tree = parseTree('a: [{b: 1}]');
	for (const hole of [0, 1, 2]) {
		const path: PathSegment[] = ['a', 0, 'b'];
		Reflect.deleteProperty(path, hole);
		assert.throws(() => getNodeAtPath(tree, path), TypeError);
		assert.throws(() => edit('a: [{b: 1}]', path, 2n), TypeError);
		assert.throws(() => editEdits('a: [{b: 1}]', path, undefined), TypeError);
	}
});

test('independent snapshot collection edits compose without shifting original offsets', () => {
	const text = 'before: \'😀\'\nleft: [1,2]\nright: {a:3,b:[4,5]}\nafter: 0xFF';
	const root = parseTree(text);
	const left = getNodeAtPath(root, ['left']);
	const right = getNodeAtPath(root, ['right']);
	assert.equal(left?.type, 'Array');
	assert.equal(right?.type, 'Object');
	const edits = [
		...formatCollectionEdits({text, root}, right, {layout: 'multiline'}),
		...formatCollectionEdits({text, root}, left, {layout: 'multiline'}),
	];
	const changed = applyEdits(text, edits);
	assert.deepEqual(parse(changed), parse(text));
	assert.ok(changed.startsWith('before: \'😀\'\nleft: [\n\t1\n\t2\n]'));
	assert.ok(changed.endsWith('after: 0xFF'));
});

test('compact and multiline collection conversions preserve all scalar spellings', () => {
	const compact = String.raw`{i: 0xFF, f: 1_0.50, t: -90m, k: "a\u{62}", nested: [0b10, {x: infinity}]}`;
	const multiline = applyEdits(compact, formatCollectionEdits(compact, [0, compact.length], {layout: 'multiline'}));
	const edits = formatCollectionEdits(multiline, [0, multiline.length], {layout: 'compact'});
	assert.ok(edits);
	assert.equal(applyEdits(multiline, edits), compact);
	assert.deepEqual(normalize(parse(multiline)), normalize(parse(compact)));
});

test('collection formatting from recovered snapshots preserves unrelated errors and comments', () => {
	const text = 'broken:\nvalid: [1,2] # keep\nother: nope';
	const snapshot = parseForEditor(text);
	const root = snapshot.root.children.at(0);
	assert.equal(root?.type, 'EditorObject');
	const member = root.members[1];
	assert.equal(member?.type, 'EditorMember');
	assert.equal(member.value.type, 'EditorArray');
	const changed = applyEdits(text, formatCollectionEdits(snapshot, member.value, {layout: 'multiline'}));
	assert.equal(changed, 'broken:\nvalid: [\n\t1\n\t2\n] # keep\nother: nope');
	assert.equal(parseForEditor(changed).diagnostics[0]!.code, 'invalid-document');
});

test('collection ownership lookup reads logarithmically many sibling ranges in strict snapshots', () => {
	const text = `{${Array.from({length: 4096}, (_, index) => `k${index}: [1,2]`).join(',')}}`;
	const root = parseTree(text);
	assert.equal(root.body.type, 'Object');
	const target = root.body.members.at(-1)!.value;
	assert.equal(target.type, 'Array');
	const observed = trackIndexReads(root.body.members);
	const members = observed.items;
	const snapshot = {text, root: {...root, body: {...root.body, members}}};
	assert.ok(formatCollectionEdits(snapshot, target, {layout: 'multiline'}).length > 0);
	assert.ok(observed.reads < 30, `${observed.reads} sibling reads`);
});

test('collection ownership lookup reads logarithmically many sibling ranges in recovered snapshots', () => {
	const text = `${Array.from({length: 4096}, (_, index) => `k${index}: [1,2]`).join('\n')}\nbroken:`;
	const snapshot = parseForEditor(text);
	const object = snapshot.root.children.at(0);
	assert.equal(object?.type, 'EditorObject');
	const member = object.members.at(-2);
	assert.equal(member?.type, 'EditorMember');
	assert.equal(member.value.type, 'EditorArray');
	const observed = trackIndexReads(object.members);
	const members = observed.items;
	const root = {...snapshot.root, children: [{...object, members}]};
	assert.ok(formatCollectionEdits({...snapshot, root}, member.value, {layout: 'multiline'}).length > 0);
	assert.ok(observed.reads < 30, `${observed.reads} sibling reads`);
});

test('strict cursor lookup avoids linear scans of wide array siblings', () => {
	const text = `[${'1,'.repeat(4096)}2]`;
	const tree = parseTree(text);
	assert.equal(tree.body.type, 'Array');
	const target = tree.body.elements.at(-1)!;
	const observed = trackIndexReads(tree.body.elements);
	const elements = observed.items;
	assert.equal(getNodeAt({...tree, body: {...tree.body, elements}}, target.range[0]), target);
	assert.ok(observed.reads < 30, `${observed.reads} sibling reads`);
});

test('format edits preserve mixed block and line comment ownership in nested lists', () => {
	const text = 'items: [\n1, /* for two */ 2, # for two too\n/* independent */\n{a:3,b:4}, /* final */\n]\n';
	const expected = 'items: [\n\t1\n\t/* for two */ 2 # for two too\n\t/* independent */\n\t{a: 3, b: 4} /* final */\n]\n';
	assert.equal(format(text), expected);
	assert.equal(applyEdits(text, formatEdits(text)), expected);
	assert.equal(format(expected), expected);
	assert.deepEqual(parse(expected), parse(text));
});

test('formatting whitespace-only comments retains comment contents beyond ASCII spaces', () => {
	const text = 'a: [1, /*\n \t\n \t\n\u{A0} \t\n*/ 2] #\u{A0} \t';
	const changed = applyEdits(text, formatEdits(text));
	assert.equal(format(changed), changed);
	assert.deepEqual(parse(changed), {a: [1n, 2n]});
	assert.ok(changed.includes('\u{A0}\n*/'));
	assert.ok(changed.endsWith('#\u{A0}\n'));
});

test('scalar completion remains usable after formatting and reparsing a collection', () => {
	const text = 'values: [true,false,null]';
	const changed = applyEdits(text, formatCollectionEdits(text, [8, text.length], {layout: 'multiline'}));
	const snapshot = parseForEditor(changed);
	const offset = changed.indexOf('false') + 3;
	const completion = getCompletionContext(snapshot, offset);
	assert.equal(completion?.prefix, 'fal');
	assert.equal(completion.slot.kind, 'array-element');
	const replaced = applyEdits(changed, [{range: completion.range, text: 'true'}]);
	assert.deepEqual(parse(replaced), {values: [true, true, null]});
});

test('editor contexts after a block string close select the following scalar with either affinity', () => {
	const text = '[\'\'\'\n😀\n\'\'\', 42]';
	const snapshot = parseForEditor(text);
	for (const side of ['left', 'right'] as const) {
		const context = getEditorContext(snapshot, text.indexOf('42') + 1, {side});
		assert.equal(context?.token?.kind, 'scalar');
		assert.equal(context.slot?.kind, 'array-element');
		assert.equal(getCompletionContext(snapshot, text.indexOf('42') + 1)?.prefix, '4');
	}
});

test('cached temporal tree values stay consistent when evaluated through different APIs', () => {
	const text = 'time: 1969-12-31T23:59:59.999999999Z\ndelay: -1h2m3ns';
	const tree = parseTree(text);
	const instant = getNodeAtPath(tree, ['time']);
	const duration = getNodeAtPath(tree, ['delay']);
	assert.equal(instant?.type, 'Instant');
	assert.equal(duration?.type, 'Duration');
	assert.equal(evaluate(instant), instant.value);
	assert.equal(evaluate(duration), duration.value);
	assert.equal(instant.value.epochNanoseconds, -1n);
	assert.equal(duration.nanoseconds, -3_720_000_000_003n);
	assert.deepEqual(normalize(evaluate(tree)), normalize(parse(text)));
});

test('serialized aliases remain independent when one path is edited', () => {
	const shared = {count: 1n, label: '😀'};
	const text = stringify({left: shared, right: shared});
	const changed = edit(text, ['left', 'count'], 2n);
	assert.deepEqual(parse(changed), {left: {...shared, count: 2n}, right: shared});
	assert.deepEqual(shared, {count: 1n, label: '😀'});
});

test('canonical replacements sort nested Unicode keys without reordering surrounding members', () => {
	const text = 'z: 0xFF\nvalue: null\na: 0o7';
	const changed = edit(text, ['value'], {'😀': {b: 2n, a: 1n}, '\u{E000}': true}, {canonical: true});
	assert.ok(changed.startsWith('z: 0xFF\nvalue: {\n'));
	assert.ok(changed.endsWith('\na: 0o7'));
	assert.ok(changed.indexOf('\u{E000}') < changed.indexOf('😀'));
	assert.ok(changed.indexOf('a: 1') < changed.indexOf('b: 2'));
	assert.equal(format(changed), `${changed}\n`);
});

test('large recovered documents retain every member after diagnostics are capped', () => {
	const count = 80_000;
	const text = Array.from({length: count}, (_, index) => `key${index}:`).join('\n');
	const snapshot = parseForEditor(text);
	const object = snapshot.root.children.at(0);
	assert.equal(object?.type, 'EditorObject');
	assert.equal(object.members.length, count);
	assert.equal(snapshot.diagnostics.length, 100);
	assert.equal(snapshot.diagnosticsTruncated, true);
	const last = object.members.at(-1);
	assert.equal(last?.type, 'EditorMember');
	assert.equal(last.key.type, 'EditorKey');
	assert.equal(last.key.key, `key${count - 1}`);
	assert.equal(last.value.type, 'EditorMissing');
	assert.deepEqual(last.value.range, [text.length, text.length]);
	assert.equal(getEditorContext(snapshot, text.length)?.slot?.owner, last);
});

test('large one-line arrays format every item without argument or truncation limits', () => {
	const count = 320_000;
	const text = `[${'1,'.repeat(count)}]`;
	const expected = `[${'1, '.repeat(count - 1)}1]\n`;
	assert.equal(applyEdits(text, formatEdits(text)), expected);
});
