// The types use the global `Temporal` types, which TypeScript has in the `esnext.temporal` lib, so a consumer whose `lib` is older gets them too.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- A lib can only be loaded with a directive, and `preserve` keeps it in the emitted types.
/// <reference lib="esnext.temporal" preserve="true" />
export {
	parse,
	type Value,
	type ObjectValue,
	type Document,
	type ParseOptions,
} from './parse.ts';
export {
	parseTree,
	evaluate,
	getNodeAt,
	getNodeAtPath,
	visitorKeys,
	type Position,
	type SourceLocation,
	type Token,
	type Comment,
	type DocumentNode,
	type ObjectNode,
	type MemberNode,
	type ArrayNode,
	type KeyNode,
	type StringNode,
	type IntegerNode,
	type FloatNode,
	type BooleanNode,
	type NullNode,
	type InstantNode,
	type DurationNode,
	type DurationPart,
	type ValueNode,
	type Node,
	type PathSegment,
} from './tree.ts';
export {format, formatEdits, type FormatEdit} from './format.ts';
export {edit, type EditOptions} from './edit.ts';
export {
	stringify,
	stringifyValue,
	formatKey,
	formatFloat,
	formatString,
	formatBlockString,
	compareKeys,
	type StringifyOptions,
} from './stringify.ts';
export {isBareKey} from './shared.ts';
export {ParseError} from './error.ts';
export {
	parseForEditor,
	type EditorRange,
	type EditorDiagnosticCode,
	type EditorDiagnostic,
	type EditorKey,
	type EditorMissing,
	type EditorError,
	type EditorMember,
	type EditorObject,
	type EditorArray,
	type EditorScalar,
	type EditorValue,
	type EditorDocument,
	type EditorNode,
	type EditorToken,
	type EditorParseResult,
} from './editor.ts';
export {
	getEditorContext,
	getCompletionContext,
	type EditorSlot,
	type EditorContext,
	type EditorContextOptions,
	type EditorCompletionContext,
} from './editor-context.ts';
