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
	formatKey,
	getCompletionContext,
	getEditorContext,
	getNodeAtPath,
	parse,
	parseForEditor,
	parseTree,
	ParseError,
	stringify,
	type FormatEdit,
	type PathSegment,
} from '../source/index.ts';
import {normalize} from './helpers.ts';

function complete(text: string, offset: number, replacement: string): string {
	const context = getCompletionContext(parseForEditor(text), offset);
	assert.ok(context);
	return applyEdits(text, [{range: context.range, text: replacement}]);
}

function assertEdited(text: string, path: readonly PathSegment[], value: unknown, expected: unknown): string {
	const changes = editEdits(text, path, value);
	assert.ok(changes.length <= 1);
	const changed = applyEdits(text, changes);
	assert.equal(changed, edit(text, path, value));
	assert.deepEqual(normalize(parse(changed)), normalize(expected));
	assert.deepEqual(normalize(evaluate(parseTree(changed))), normalize(expected));
	assert.equal(parseForEditor(changed).diagnostics.length, 0);
	return changed;
}

test('replacement insertion removal and no-op each expose at most one source range', () => {
	const text = 'outer: {items: [1, 2]}\nretained: 0xFF';
	for (const [path, value, expected] of [
		[['outer', 'items', 0], 3n, {outer: {items: [3n, 2n]}, retained: 255n}],
		[['outer', 'items', 2], 3n, {outer: {items: [1n, 2n, 3n]}, retained: 255n}],
		[['outer', 'items', 0], undefined, {outer: {items: [2n]}, retained: 255n}],
		[['missing'], undefined, {outer: {items: [1n, 2n]}, retained: 255n}],
	] as const) {
		assertEdited(text, path, value, expected);
	}
});

test('sparse edit lists reject omitted entries even when neighboring edits are valid', () => {
	const edits: FormatEdit[] = [{range: [0, 0], text: 'a'}];
	edits.length = 2;
	edits.push({range: [1, 1], text: 'b'});
	assert.throws(() => applyEdits('xy', edits), TypeError);
});

test('empty edit lists still validate the source and list types', () => {
	assert.equal(applyEdits('', []), '');
	assert.equal(applyEdits('not SOML', []), 'not SOML');
	assert.throws(() => applyEdits(1 as unknown as string, []), TypeError);
	assert.throws(() => applyEdits('', {} as FormatEdit[]), TypeError);
});

test('unsorted boundary edits place stable insertions before a replacement', () => {
	const edits: FormatEdit[] = [
		{range: [2, 3], text: 'R'},
		{range: [2, 2], text: 'A'},
		{range: [0, 1], text: 'X'},
		{range: [2, 2], text: 'B'},
	];
	const before = structuredClone(edits);
	assert.equal(applyEdits('abcd', edits), 'XbABRd');
	assert.deepEqual(edits, before);
});

test('text edits use original UTF-16 offsets after adjacent astral values', () => {
	const text = 'first: \'😀😃\'\nsecond: \'😄\'';
	const tree = parseTree(text);
	const first = getNodeAtPath(tree, ['first'])!;
	const second = getNodeAtPath(tree, ['second'])!;
	const edits = [{range: second.range, text: '\'after\''}, {range: first.range, text: '\'before\''}];
	assert.deepEqual(parse(applyEdits(text, edits)), {first: 'before', second: 'after'});
});

test('successive edits with fresh nodes survive offset shifts from Unicode insertions', () => {
	let text = 'items: [{value: 1}, {value: 2}]';
	text = edit(text, ['prefix'], '😀'.repeat(200));
	text = edit(text, ['items', 0, 'before'], '😃');
	const tree = parseTree(text);
	const target = getNodeAtPath(tree, ['items', 1, 'value'])!;
	text = applyEdits(text, editEdits(text, target, 3n));
	assert.deepEqual(parse(text), {items: [{value: 1n, before: '😃'}, {value: 3n}], prefix: '😀'.repeat(200)});
});

test('reparsing edited text makes independent snapshots while old contexts retain their owners', () => {
	const text = 'a: [true, false]';
	const original = parseForEditor(text);
	const oldContext = getEditorContext(original, text.indexOf('false'))!;
	const changed = edit(text, ['a', 0], {nested: '😀'});
	const next = parseForEditor(changed);
	assert.equal(original.text, text);
	assert.equal(oldContext.ancestors[0], original.root);
	assert.notEqual(next.root, original.root);
	assert.equal(getEditorContext(next, changed.indexOf('false'))?.slot?.kind, 'array-element');
});

test('removing a singleton collection ignores comments elsewhere in the document', () => {
	const text = '# prefix\nouter: {value: 1}\n# middle\nother: 2 # suffix';
	const changed = assertEdited(text, ['outer', 'value'], undefined, {outer: {}, other: 2n});
	assert.equal(changed, '# prefix\nouter: {}\n# middle\nother: 2 # suffix');
});

test('removing a singleton keeps an unowned comment inside its own collection', () => {
	const text = 'outer: {\n# retained\nvalue: 1\n}\nother: 2 # outside';
	const changed = assertEdited(text, ['outer', 'value'], undefined, {outer: {}, other: 2n});
	assert.ok(changed.includes('# retained'));
	assert.ok(changed.endsWith('other: 2 # outside'));
});

test('replacing a block string after a comment remains one edit with valid content', () => {
	const text = 'value: /* keep */ 1\nother: 2';
	const edits = editEdits(text, ['value'], 'line1\nline2', {stringStyle: 'block'});
	assert.equal(edits.length, 1);
	const changed = applyEdits(text, edits);
	assert.deepEqual(parse(changed), {value: 'line1\nline2', other: 2n});
	assert.ok(changed.includes('/* keep */'));
	assert.equal(edit(changed, ['value'], 'line1\nline2', {stringStyle: 'block'}), changed);
});

test('new computed-property parents preserve prototype-like keys at every level', () => {
	const text = assertEdited('retained: true', ['__proto__', 'constructor', 'toString'], 1n, {retained: true, ['__proto__']: {constructor: {toString: 1n}}});
	const value = parse(text) as Record<string, unknown>;
	assert.equal(Object.getPrototypeOf(value), Object.prototype);
	assert.ok(Object.hasOwn(value, '__proto__'));
});

test('deleting a nested array branch is idempotent without recreating missing objects', () => {
	const changed = assertEdited('outer: [{value: 1}]', ['outer', 0], undefined, {outer: []});
	assert.equal(edit(changed, ['outer', 0, 'value'], undefined), changed);
	assert.deepEqual(editEdits(changed, ['outer', 0, 'value'], undefined), []);
});

test('a rejected replacement leaves later editing calls independent', () => {
	const text = 'value: 1';
	assert.throws(() => edit(text, ['value'], NaN), /NaN/v);
	assert.throws(() => edit(text, ['value'], '\r'), /carriage return/v);
	assertEdited(text, ['value'], 2n, {value: 2n});
});

test('canonical replacement sorts only the new subtree and retains outer ordering', () => {
	const text = 'z: 0xFF\nvalue: null\na: 1_000';
	const changed = edit(text, ['value'], {z: 2n, a: 1n}, {canonical: true});
	assert.equal(changed, 'z: 0xFF\nvalue: {\n\ta: 1\n\tz: 2\n}\na: 1_000');
	assert.deepEqual(parse(changed), {z: 255n, value: {a: 1n, z: 2n}, a: 1000n});
});

test('selected multiline parse errors remain relative after astral text outside the range', () => {
	const selected = '[\n1\n, 2]';
	const prefix = '\'😀\': \'😃\'\nvalue: ';
	assert.throws(() => formatCollectionEdits(prefix + selected, [prefix.length, prefix.length + selected.length]), (error: unknown) => {
		assert.ok(error instanceof ParseError);
		assert.equal(error.line, 3);
		assert.equal(error.column, 1);
		assert.equal(error.offset, 4);
		return true;
	});
});

test('changing string styles repeatedly preserves values and neighboring spellings', () => {
	const value = String.raw`a "quote" \ tail`;
	let text = `value: ${stringify({value}).slice(7).trimEnd()}\nother: 0xFF`;
	for (const stringStyle of ['literal', 'escaped', 'block', 'auto'] as const) {
		text = edit(text, ['value'], value, {stringStyle});
		assert.deepEqual(parse(text), {value, other: 255n});
		assert.ok(text.endsWith('other: 0xFF'));
	}
});

test('disjoint data edits from one snapshot compose without shifting later original ranges', () => {
	const text = 'first: 1\nsecond: 2\nthird: 3';
	const edits = [...editEdits(text, ['third'], '😀'), ...editEdits(text, ['first'], [10n, 20n])];
	assert.deepEqual(parse(applyEdits(text, edits)), {first: [10n, 20n], second: 2n, third: '😀'});
});

test('collection formatting at offset zero returns edits that can be reused unchanged', () => {
	const text = '[1,  2]';
	const edits = formatCollectionEdits(text, [0, text.length]);
	const before = structuredClone(edits);
	assert.equal(applyEdits(text, edits), '[1, 2]');
	assert.equal(applyEdits(`${text}\n# suffix`, edits), '[1, 2]\n# suffix');
	assert.deepEqual(edits, before);
});

test('compact selected collections preserve the complete invalid surrounding source', () => {
	const selected = '{\na: [\n0xFF\n1_000\n]\n}';
	const prefix = 'broken: @\nvalue: ';
	const text = `${prefix}${selected}\nother:`;
	const edits = formatCollectionEdits(text, [prefix.length, prefix.length + selected.length], {layout: 'compact'})!;
	assert.equal(applyEdits(text, edits), `${prefix}{a: [0xFF, 1_000]}\nother:`);
	assert.deepEqual(parse(applyEdits(selected, edits.map(({range, text: replacement}) => ({range: [range[0] - prefix.length, range[1] - prefix.length], text: replacement})))), {a: [255n, 1000n]});
});

test('selected multiline formatting preserves comments inside string literals', () => {
	const text = '[\'# comment\', \'/* block */\', \'a,b\']';
	const changed = applyEdits(text, formatCollectionEdits(text, [0, text.length], {layout: 'multiline'}));
	assert.deepEqual(parse(changed), ['# comment', '/* block */', 'a,b']);
	assert.equal(parseTree(changed).comments.length, 0);
});

test('Unicode key completion preserves an existing colon and its value', () => {
	const text = '{old: 1, retained: 2}';
	const changed = complete(text, 3, formatKey('😀 key'));
	assert.deepEqual(parse(changed), {'😀 key': 1n, retained: 2n});
	assert.ok(changed.endsWith(': 1, retained: 2}'));
});

test('prototype-like key completion creates an own property without changing the prototype', () => {
	const changed = complete('{old: true}', 4, formatKey('__proto__'));
	const value = parse(changed);
	assert.ok(Object.hasOwn(value, '__proto__'));
	assert.equal(Object.getPrototypeOf(value), Object.prototype);
	assert.equal(Object.getOwnPropertyDescriptor(value, '__proto__')!.value as unknown, true);
});

test('key completion can replace a bare prefix with an escaped newline key', () => {
	const changed = complete('old: 1', 2, formatKey('a\nb'));
	assert.deepEqual(parse(changed), {'a\nb': 1n});
	assert.equal(getNodeAtPath(parseTree(changed), ['a\nb'])?.type, 'Integer');
});

test('completion in the middle of a scalar replaces its full token', () => {
	const text = 'value: 12345\nretained: 0xFF';
	const snapshot = parseForEditor(text);
	const context = getCompletionContext(snapshot, 9)!;
	assert.equal(context.prefix, '12');
	assert.equal(text.slice(...context.range), '12345');
	assert.deepEqual(parse(complete(text, 9, '678')), {value: 678n, retained: 255n});
});

test('instant completion preserves nanoseconds while replacing an incomplete offset', () => {
	const text = 'time: 1970-01-01T00:00:00.000000001';
	const changed = complete(text, text.length, '1970-01-01T00:00:00.000000001Z');
	assert.equal((parse(changed) as {time: Temporal.Instant}).time.epochNanoseconds, 1n);
	assert.equal(parseForEditor(changed).diagnostics.length, 0);
});

test('negative duration completion replaces an unfinished part with an exact total', () => {
	const text = 'wait: -1h30';
	const changed = complete(text, text.length, '-1h30m');
	assert.equal((getNodeAtPath(parseTree(changed), ['wait']) as {nanoseconds: bigint}).nanoseconds, -5_400_000_000_000n);
	assert.equal(parseForEditor(changed).diagnostics.length, 0);
});

test('negative infinity completion leaves adjacent array entries untouched', () => {
	const text = '[1, -inf, 2]';
	const changed = complete(text, text.indexOf('-inf') + 4, '-infinity');
	assert.deepEqual(parse(changed), [1n, -Infinity, 2n]);
});

test('completion uses token boundaries while preserving whitespace before a trailing comment', () => {
	const text = 'enabled: tr \t# keep';
	const changed = complete(text, text.indexOf('tr') + 2, 'true');
	assert.equal(changed, 'enabled: true \t# keep');
	assert.deepEqual(parse(changed), {enabled: true});
});

test('completion after a closed block comment uses only the grammatical value gap', () => {
	const text = 'value: /* : , [ invalid */';
	const changed = complete(text, text.length, ' true');
	assert.deepEqual(parse(changed), {value: true});
	assert.equal(parseTree(changed).comments[0]?.value, ' : , [ invalid ');
});

test('formatting two recovered collections composes despite an unrelated malformed value', () => {
	const text = 'a: [1, 2]\nbroken: @\nb: {x: 3, y: 4}';
	const snapshot = parseForEditor(text);
	const object = snapshot.root.children.at(0)!;
	assert.equal(object.type, 'EditorObject');
	const first = object.members[0]!;
	const last = object.members[2]!;
	assert.equal(first.type, 'EditorMember');
	assert.equal(last.type, 'EditorMember');
	assert.equal(first.value.type, 'EditorArray');
	assert.equal(last.value.type, 'EditorObject');
	const edits = [...formatCollectionEdits(snapshot, last.value, {layout: 'multiline'}), ...formatCollectionEdits(snapshot, first.value, {layout: 'multiline'})];
	const changed = applyEdits(text, edits);
	assert.equal(changed, 'a: [\n\t1\n\t2\n]\nbroken: @\nb: {\n\tx: 3\n\ty: 4\n}');
	assert.equal(parseForEditor(changed).diagnostics[0]?.code, 'invalid-document');
});

test('diagnostic truncation does not hide a later valid completion site', () => {
	const text = `${'bad:\n'.repeat(150)}final: tr`;
	const snapshot = parseForEditor(text);
	assert.ok(snapshot.diagnosticsTruncated);
	const context = getCompletionContext(snapshot, text.length)!;
	assert.equal(context.prefix, 'tr');
	assert.equal(context.slot.kind, 'member-value');
	assert.equal(applyEdits(text, [{range: context.range, text: 'true'}]).slice(-11), 'final: true');
});

test('completion inside an empty array can insert a nested collection atomically', () => {
	const changed = complete('items: []', 8, '{value: [1, 2]}');
	assert.deepEqual(parse(changed), {items: [{value: [1n, 2n]}]});
	assert.equal(getEditorContext(parseForEditor(changed), changed.indexOf('2'))?.slot?.kind, 'array-element');
});

test('completion inside an empty object adds key colon and value as one edit', () => {
	const changed = complete('outer: {}', 8, `${formatKey('a b')}: 1`);
	assert.deepEqual(parse(changed), {outer: {'a b': 1n}});
	assert.equal(parseForEditor(changed).diagnostics.length, 0);
});

test('completion in an unfinished array stays queryable until its closer is added', () => {
	const text = 'items: [1, ';
	const changed = complete(text, text.length, 'true');
	const snapshot = parseForEditor(changed);
	assert.equal(getEditorContext(snapshot, changed.length)?.slot?.kind, 'array-element');
	assert.ok(snapshot.diagnostics.some(diagnostic => diagnostic.code === 'missing-close'));
	assert.deepEqual(parse(`${changed}]`), {items: [1n, true]});
});

test('completion fills an array error slot before a comma without dropping the next element', () => {
	const text = '[, false]';
	const changed = complete(text, 1, 'true');
	assert.deepEqual(parse(changed), [true, false]);
	assert.equal(getEditorContext(parseForEditor(changed), changed.indexOf('false'))?.slot?.kind, 'array-element');
});

test('completing a key with comment delimiters does not create actual comments', () => {
	const changed = complete('{old: true}', 3, formatKey('/* # */'));
	assert.deepEqual(parse(changed), {'/* # */': true});
	assert.equal(parseTree(changed).comments.length, 0);
});

test('completing a recovered key can repair its missing colon with the replacement', () => {
	const text = '{partial}';
	const changed = complete(text, 5, `${formatKey('new key')}: true`);
	assert.deepEqual(parse(changed), {'new key': true});
	assert.equal(parseForEditor(changed).diagnostics.length, 0);
});

test('format edits around astral comments change only layout outside their content', () => {
	const text = 'a: [1,/* 😀, : */2,]\n\'😃\': 3';
	const edits = formatEdits(text);
	const tree = parseTree(text);
	for (const change of edits) {
		for (const token of [...tree.comments, ...tree.tokens.filter(token => token.type !== 'Punctuator')]) {
			assert.ok(change.range[1] <= token.range[0] || change.range[0] >= token.range[1]);
		}
	}

	assert.deepEqual(parse(applyEdits(text, edits)), {a: [1n, 2n], '😃': 3n});
	assert.equal(applyEdits(text, edits), format(text));
});

test('fresh numeric-key nodes target source order after quoted Unicode key insertion', () => {
	let text = '20: 20\n3: 3\n100: 100';
	text = edit(text, ['😀'], 'prefix');
	const tree = parseTree(text);
	const target = getNodeAtPath(tree, ['3'])!;
	const changed = applyEdits(text, editEdits(text, target, 4n));
	assert.equal(changed, '20: 20\n3: 4\n100: 100\n\'😀\': \'prefix\'');
});

test('editor first diagnostics agree with strict error offsets after a formatting workflow', () => {
	const text = `${format('\'😀\': [1, 2]')}invalid: 1e`;
	let failure: ParseError | undefined;
	assert.throws(() => parse(text), (error: unknown) => {
		assert.ok(error instanceof ParseError);
		failure = error;
		return true;
	});

	assert.ok(failure);
	const snapshot = parseForEditor(text);
	assert.equal(snapshot.diagnostics[0]?.range[0], failure.offset);
	assert.equal(snapshot.diagnostics[0]?.message, failure.reason);
});
