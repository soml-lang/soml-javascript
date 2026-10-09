import {
	parse,
	parseTree,
	parseForEditor,
	getEditorContext,
	getCompletionContext,
	type EditorContext,
	type EditorCompletionContext,
	evaluate,
	type EditorParseResult,
	type EditorNode,
	visitorKeys,
	format,
	formatEdits,
	edit,
	compareKeys,
	isBareKey,
	stringify,
	stringifyValue,
	formatBlockString,
	ParseError,
	type Document,
	type Value,
	type DocumentNode,
	type ValueNode,
	type Token,
	type Comment,
	type PathSegment,
	type ParseOptions,
	type StringifyOptions,
	type EditOptions,
	type FormatEdit,
	type DurationNode,
	type DurationPart,
} from './source/index.ts';

function expectType<Type>(value: Type): Type {
	return value;
}

expectType<Document>(parse('a: 1'));
expectType<Document>(parse(new Uint8Array()));
expectType<Document>(parse('a: 1', {integers: 'bigint'}));
expectType<Document<number>>(parse('a: 1', {integers: 'number'}));

const options: ParseOptions = {integers: 'number'};
expectType<Document | Document<number>>(parse('a: 1', options));

const document = parse('a: 1');

if (!Array.isArray(document)) {
	const value = document['a'];
	expectType<Value | undefined>(value);

	if (typeof value === 'bigint') {
		expectType<bigint>(value);
	}

	if (value instanceof Temporal.Instant) {
		expectType<Temporal.Instant>(value);
	}

	if (value instanceof Temporal.Duration) {
		expectType<Temporal.Duration>(value);
	}
}

const nullValue: Value = null;
expectType<Value>(nullValue);

// @ts-expect-error: `undefined` is not a value in the format.
const undefinedValue: Value = undefined;
expectType<Value>(undefinedValue);

const numberDocument = parse('a: 1', {integers: 'number'});

if (!Array.isArray(numberDocument)) {
	// @ts-expect-error: There are no bigints in this mode.
	expectType<bigint>(numberDocument.a);
}

// @ts-expect-error: The input must be a string or bytes.
parse(1);

// @ts-expect-error: Unknown mode.
parse('a: 1', {integers: 'string'});

expectType<string>(stringify({a: 1n}));
expectType<string>(stringify([1, 2]));
expectType<string>(stringify({a: 1}, {integers: 'number'}));
expectType<string>(stringify([1n, 2n] as const));
expectType<string>(stringify({a: 1n}, {canonical: true}));
expectType<string>(stringify({a: 1}, {integers: 'number', canonical: false}));

// @ts-expect-error: The canonical option is a boolean.
stringify({a: 1n}, {canonical: 'true'});

const stringifyOptions: StringifyOptions = {integers: 'number', canonical: true};
expectType<string>(stringify({a: 1}, stringifyOptions));

// An interface has no index signature, so this only compiles because `stringify()` takes an `object`.
interface Config { // eslint-disable-line @typescript-eslint/consistent-type-definitions
	name: string;
	port: bigint;
}

const config: Config = {name: 'x', port: 1n};
expectType<string>(stringify(config));

expectType<string>(stringifyValue(1.5));
expectType<string>(stringifyValue(1, {integers: 'number'}));
expectType<string>(stringifyValue({b: 1n, a: 2n}, {canonical: true}));

// @ts-expect-error: A document is a collection.
stringify('a');

// @ts-expect-error: A document is a collection.
stringify(1);

// @ts-expect-error: Only `parse()` creates a `ParseError`.
new ParseError('x'); // eslint-disable-line no-new

try {
	parse('');
} catch (error) {
	if (error instanceof ParseError) {
		expectType<string>(error.reason);
		expectType<number>(error.line);
		expectType<number>(error.column);
		expectType<number>(error.offset);
		expectType<string>(error.codeFrame);
		expectType<SyntaxError>(error);
	}
}

const tree = parseTree('a: 1');
expectType<DocumentNode>(tree);
expectType<readonly Token[]>(tree.tokens);
expectType<readonly Comment[]>(tree.comments);
expectType<readonly [start: number, end: number]>(tree.range);
expectType<number>(tree.loc.start.line);

if (tree.body.type === 'Object') {
	const member = tree.body.members[0]!;
	expectType<string>(member.key.value);
	const {value} = member;
	expectType<ValueNode>(value);

	if (value.type === 'Integer') {
		expectType<bigint>(value.value);
		expectType<2 | 8 | 10 | 16>(value.radix);
	} else if (value.type === 'String') {
		expectType<boolean>(value.block);
	}

	// @ts-expect-error: A null node has no value.
	expectType<unknown>(value.type === 'Null' && value.value);
} else {
	expectType<readonly ValueNode[]>(tree.body.elements);
}

// @ts-expect-error: The tree is built from a string only.
parseTree(new Uint8Array());

expectType<string>(format('a: 1'));

// @ts-expect-error: Formatting takes a string only.
format(new Uint8Array());

expectType<FormatEdit[]>(formatEdits('a: 1'));
expectType<readonly [start: number, end: number]>(formatEdits('a: 1')[0]!.range);

// @ts-expect-error: Formatting takes a string only.
formatEdits(new Uint8Array());

declare const durationNode: DurationNode;
expectType<boolean>(durationNode.negative);
expectType<readonly DurationPart[]>(durationNode.parts);
expectType<'h' | 'm' | 's' | 'ms' | 'us' | 'ns'>(durationNode.parts[0]!.unit);

expectType<readonly string[]>(visitorKeys.Member);

// @ts-expect-error: Not a node type.
expectType<readonly string[]>(visitorKeys.Unknown);

expectType<string>(edit('a: 1', ['a'], 2n));
expectType<string>(edit('a: [1]', ['a', 0], undefined, {integers: 'number'}));

const editPath: PathSegment[] = ['servers', 0, 'port'];
expectType<string>(edit('servers: [{port: 1}]', editPath, 2n));
expectType<string>(edit('servers: [{port: 1}]', ['servers', 0, 'port'] as const, 2n));

expectType<string>(edit('a: 1', ['b'], {d: 1n, c: 2n}, {canonical: true}));

const editOptions: EditOptions = {integers: 'number', canonical: true};
expectType<string>(edit('a: 1', ['a'], 2, editOptions));

// @ts-expect-error: A path holds keys and indexes only.
edit('a: 1', [true], 2n);

// @ts-expect-error: Editing takes a string only.
edit(new Uint8Array(), ['a'], 2n);

expectType<number>(compareKeys('a', 'b'));
expectType<string[]>(['b', 'a'].toSorted(compareKeys));
expectType<boolean>(isBareKey('a'));

// @ts-expect-error: A key is a string.
isBareKey(1);

const editorResult = parseForEditor('port:');
expectType<EditorParseResult>(editorResult);
expectType<EditorNode>(editorResult.root);
// @ts-expect-error: Editor trees are not validated data trees.
evaluate(editorResult.root);
// @ts-expect-error: Editor nodes cannot be passed to strict data editing.
edit('a: 1', editorResult.root, 2n);
// @ts-expect-error: The editor API accepts decoded strings only.
parseForEditor(new Uint8Array());
// @ts-expect-error: Editor tree arrays are readonly snapshots.
editorResult.root.children.push(editorResult.root);

expectType<EditorContext | undefined>(getEditorContext(editorResult, 0));
expectType<EditorCompletionContext | undefined>(getCompletionContext(editorResult, 0));
// @ts-expect-error: Affinity is explicit.
getEditorContext(editorResult, 0, {side: 'nearest'});
// @ts-expect-error: Queries accept snapshots, not source strings.
getCompletionContext('port:', 5);
const completionContext = getCompletionContext(editorResult, 5);
if (completionContext?.slot.kind === 'member-value') {
	expectType<'EditorMember'>(completionContext.slot.owner.type);
}

if (completionContext) {
	// @ts-expect-error: Replacement ranges are readonly.
	completionContext.range[0] = 0;
	// @ts-expect-error: Ancestors are readonly.
	completionContext.ancestors.push(editorResult.root);
}

expectType<string>(formatBlockString('hello\nworld'));
// @ts-expect-error: Block strings take decoded strings only.
formatBlockString(1);
