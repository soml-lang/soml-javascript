# soml

> The reference parser, serializer, and formatter for [SOML](https://soml.sh), a config format for humans

> [!NOTE]
> The format is a draft. See the [specification](https://github.com/soml-lang/soml/blob/main/spec.md).

- Strict: every rule in the specification is enforced, and every error says what is wrong and where
- Exact: an int is a `bigint`, so every 64-bit int survives, and `3` and `3.0` stay different
- Canonical: with `canonical: true`, `stringify()` writes the one canonical form, so equal values give equal bytes
- Lossless: `format()` and `edit()` keep comments, member order, and the spelling of every value they do not change
- Safe: no prototype pollution, no stack overflow on deep input or huge tokens, and linear time on every input shape
- Fast: parses nearly as fast as smol-toml, and about 5 times as fast as json5
- Tested by a language-neutral [conformance suite](test/conformance) of more than 900 cases, plus property tests and fuzzing

## Install

```sh
npm install soml-lang
```

Requires Node.js 22 or later. Instants and durations use `Temporal`, which is built into Node.js 26 and later. On older versions, everything else works, but `parse()` of an instant or a duration throws, and so does reading the `value` of an `Instant` or `Duration` node, also by spreading or serializing it. To use them, load a [`Temporal` polyfill](https://github.com/fullcalendar/temporal-polyfill) first:

```js
import 'temporal-polyfill/global';
import {parse} from 'soml-lang';
```

The types need TypeScript 6 or later for the global `Temporal` types, and load its `esnext.temporal` lib themselves.

## Usage

```js
import {parse, stringify} from 'soml-lang';

const config = parse(`
# The edge service.
name: 'api-gateway'
replicas: 3
timeout: 30.0
grace: 1m30s
deployed-at: 2026-09-19T14:00:00Z
postgres: {host: 'db.internal'}
`);
//=> {
// 	name: 'api-gateway',
// 	replicas: 3n,
// 	timeout: 30,
// 	grace: Temporal.Duration.from('PT1M30S'),
// 	'deployed-at': Temporal.Instant.from('2026-09-19T14:00:00Z'),
// 	postgres: {host: 'db.internal'},
// }

stringify(config);
//=> `name: 'api-gateway'
// replicas: 3
// timeout: 30.0
// grace: 1m30s
// deployed-at: 2026-09-19T14:00:00Z
// postgres: {
// 	host: 'db.internal'
// }
// `
```

> [!IMPORTANT]
> An int is a `bigint` and a float is a `number`, in both directions. So `stringify({port: 8080})` writes `port: 8080.0`, a float. Write `8080n`, or pass `{integers: 'number'}`.

## Types

| SOML | JavaScript | `integers: 'number'` |
|---|---|---|
| string | `string` | |
| int | `bigint` | `number` |
| float | `number` | |
| bool | `boolean` | |
| null | `null` | |
| instant | [`Temporal.Instant`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal/Instant) | |
| duration | [`Temporal.Duration`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal/Duration), in hours and smaller units | |
| array | `Array` | |
| object | plain `Object` | |

The specification requires that `3` and `3.0` stay different and that every 64-bit int is exact. `bigint` for an int and `number` for a float is the one mapping onto JavaScript primitives that does both, so it is the default. With it:

- `parse(stringify(value))` deep-equals `value`, for a value made of the types `parse()` returns. (A `Date` comes back as a `Temporal.Instant`, a `Temporal.Duration` as the same length in hours and smaller units, `-0` as `0`, and an object with a null prototype as a plain object.)
- `stringify(parse(text), {canonical: true})` is the canonical form of `text`, and `stringify(parse(canonical), {canonical: true}) === canonical`. Without the option, only the member order differs: members are in the order of `text`, except that integer-like keys, such as `404`, come first, in numeric order, as JavaScript enumerates them.

## API

### parse(text, options?)

Parse a document. Returns an object or an array, because a document is always a collection.

Throws a [`ParseError`](#parseerror) when `text` is not a valid document, and a `TypeError` when `text` is not a string or a `Uint8Array`, or `options` is not an object or its `integers` is not `'bigint'` or `'number'`.

```js
import {parse} from 'soml-lang';

parse(`
name: 'api-gateway'
replicas: 3
timeout: 30.0
postgres: {host: 'db.internal'}
`);
//=> {name: 'api-gateway', replicas: 3n, timeout: 30, postgres: {host: 'db.internal'}}
```

#### text

Type: `string | Uint8Array`

The document. A `Uint8Array` is decoded as UTF-8, and invalid UTF-8 is reported with its position.

#### options

Type: `object`

##### integers

Type: `'bigint' | 'number'`\
Default: `'bigint'`

How an int is represented.

- `'bigint'`: Every int is a `bigint`, and every float is a `number`, so `3` and `3.0` stay different, and every 64-bit int is exact. This is the only conforming mode.
- `'number'`: Every int is a `number`. An int outside `Number.MIN_SAFE_INTEGER` to `Number.MAX_SAFE_INTEGER` throws a `ParseError` rather than being rounded. `3` and `3.0` both become `3`, so `stringify()` cannot tell them apart afterwards.

```js
parse('port: 8080', {integers: 'number'});
//=> {port: 8080}
```

### parseTree(text)

Parse a document into a syntax tree, for tools such as linters and formatters. Returns a `Document` node, which also holds every token and comment.

Throws the same [`ParseError`](#parseerror) as `parse()`, and a `TypeError` when `text` is not a string.

```js
import {parseTree} from 'soml-lang';

const tree = parseTree('port: 8080 # The default');

tree.body.members[0].value;
//=> {type: 'Integer', value: 8080n, radix: 10, range: [6, 10], loc: {…}}

tree.comments[0];
//=> {type: 'Line', value: ' The default', range: [11, 24], loc: {…}}
```

Every node, token, and comment has a `range`, which is `[start, end]` as UTF-16 offsets into `text`, and a `loc`, which is `{start: {line, column}, end: {line, column}}`, with a 1-based line and a 0-based column in UTF-16 code units, as in [ESTree](https://github.com/estree/estree). A [`ParseError`](#parseerror) counts its column differently, for people to read, so use its `offset` to find the position in the tree. A scalar node or a key shares its `range` and `loc` with its token, and other nodes, except `Document`, share the positions in `loc` with their first and last token, so treat them as read-only.

| Node | Fields |
|---|---|
| `Document` | `body`: an `Object` or an `Array`; `tokens`; `comments` |
| `Object` | `members`; `braced`, which is `false` only for a top-level object without braces |
| `Member` | `key`; `value` |
| `Array` | `elements` |
| `Key` | `value`, decoded; `style`: `'bare'`, `'literal'`, or `'escaped'` |
| `String` | `value`, decoded; `style`: `'literal'` or `'escaped'`; `block` |
| `Integer` | `value`, a `bigint`; `radix`: `2`, `8`, `10`, or `16` |
| `Float` | `value`, including `Infinity` and `-Infinity` |
| `Boolean` | `value` |
| `Null` | |
| `Instant` | `value`, a `Temporal.Instant`, made when it is first read, also by spreading or serializing the node |
| `Duration` | `value`, a `Temporal.Duration`, made when it is first read, also by spreading or serializing the node; `negative`, whether it is written with a `-`; `parts`, each `{number, unit}` as written, so `-1h1.5m` has the parts `{number: '1', unit: 'h'}` and `{number: '1.5', unit: 'm'}` |

A token is `{type, value, range, loc}`, where `type` is `'Punctuator'` (for `{`, `}`, `[`, `]`, `:`, and `,`), `'BareKey'`, `'String'`, `'Integer'`, `'Float'`, `'Keyword'` (for `true`, `false`, and `null`), `'Instant'`, or `'Duration'`, and `value` is its source text. `infinity` and `-infinity` are `'Float'` tokens, and a quoted key is a `'String'` token. A comment is `{type, value, range, loc}`, where `type` is `'Line'` or `'Block'`, and `value` is the text without `#`, or without `/*` and `*/`.

### parseForEditor(text)

Analyze possibly incomplete SOML for editor navigation. Malformed text returns diagnostics instead of throwing. This tree cannot be evaluated or used for formatting or editing data; keep using the strict APIs for those operations.

Ranges are half-open UTF-16 offsets in the unchanged input. Missing values have zero-width ranges. Unfinished containers omit `closingRange`. Ordinary unfinished strings stop at LF; unfinished block strings and comments consume through EOF. Recovery never infers nesting from indentation.

The first diagnostic is the strict parser's first failure, with code `invalid-document`. Additional recovery diagnostics follow in discovery order. At most 100 diagnostics are retained; `diagnosticsTruncated` indicates suppressed reports. No diagnostics means the input is strictly valid. This is a full-document parse, works without `Temporal`, and accepts decoded strings only.

```typescript
import {parseForEditor} from 'soml-lang';

const result = parseForEditor("host: 'localhost'\nport:\nsecure: true");
result.root.children[0];
//=> An EditorObject retaining host, port (with an EditorMissing value), and secure.
result.diagnostics[0]?.code;
//=> 'invalid-document'
```

The result contains `text`, `root`, `tokens`, `diagnostics`, and `diagnosticsTruncated`. Editor nodes use distinct discriminants such as `EditorObject`, `EditorMember`, `EditorScalar`, `EditorMissing`, and `EditorError`. Scalars expose a validated `scalarKind`, not a JavaScript value. Decoded keys appear only on `EditorKey`. Duplicate members remain in source order; their diagnostic refers to the first key. A path through duplicates or ambiguous recovered array elements must not be treated as a reliable data path.

The root spans the entire input. Whitespace remains in the original text between tokens; there is no comment ownership. Node properties and arrays are readonly in TypeScript, without runtime freezing. Recovery is conservative and diagnostic collection is not exhaustive. Incremental parsing is not part of this API. Members expose `colonRange` when a colon is present, including members whose value is missing.

### getEditorContext(document, offset, options?)

Describe syntax at a UTF-16 cursor offset without reparsing. The default affinity is `right`. Left affinity includes token ends and excludes starts; right affinity includes starts and excludes ends. Neither jumps across whitespace. The document is always an ancestor, including at EOF, and unfinished containers remain ancestors at EOF with either affinity. Zero-width missing nodes are represented through slots rather than selected as ancestors.

Nodes and tokens refer to the supplied `parseForEditor()` snapshot. A slot identifies syntactic ownership, including inside comments or before an existing value; it does not promise that insertion is valid. No values are evaluated and no semantic paths are inferred. Returns `undefined` beyond EOF.

Offsets are non-negative safe integer UTF-16 offsets; invalid offsets throw `TypeError`. Invalid affinity also throws `TypeError`.

```js
import {parseForEditor, getEditorContext} from 'soml-lang';

const document = parseForEditor('port: ');
getEditorContext(document, 6)?.slot?.kind;
//=> 'member-value'
```

### getCompletionContext(document, offset)

Find an eligible completion site without reparsing or choosing suggestions. Returns a grammatical slot, ancestors, an optional token, the whole-token replacement range, and the source prefix before the cursor. Empty sites have a zero-width range. Key slots expose an existing member's `colonRange`; replace only the key when that colon exists.

Completion supports unquoted keys and scalar tokens, empty member values and collection entries, and empty documents. It is suppressed inside strings and comments, before existing values separated by whitespace, and at ambiguous or unsupported recovery boundaries. It never adds separators or repairs surrounding syntax. Eligibility does not imply the whole document is valid. Returns `undefined` beyond EOF or when no supported completion applies.

Offsets are non-negative safe integer UTF-16 offsets; invalid offsets throw `TypeError`.

```js
import {parseForEditor, getCompletionContext} from 'soml-lang';

const document = parseForEditor('enabled: tr');
const context = getCompletionContext(document, 11);
context?.prefix;
//=> 'tr'
context?.range;
//=> [9, 11]
```

### evaluate(node)

A node as its value, which is what `parse()` reads for the same text. For a document, the whole document, so `evaluate(parseTree(text))` is the same as `parse(text)`. An object or an array is built from its members and elements, with a key named `__proto__` as an ordinary member, as in `parse()`. An instant or a duration is a `Temporal` object, made when the value is read.

```js
import {evaluate, parseTree} from 'soml-lang';

const tree = parseTree('name: \'api\'\nlimits: {cpu: 1.5, memory: 512}');

evaluate(tree);
//=> {name: 'api', limits: {cpu: 1.5, memory: 512n}}

evaluate(tree.body.members[1].value);
//=> {cpu: 1.5, memory: 512n}
```

### getNodeAt(tree, offset)

The deepest node, token, or comment whose span contains `offset`, such as for an editor that shows what is under the cursor. A span contains its start but not its end. A comment beats the node that holds it, and a token that no node covers, such as `{` or `:`, beats its container. An offset in the whitespace between members or items gives the object or the array, and one before the document's collection or past its end gives `undefined`.

```js
import {getNodeAt, parseTree} from 'soml-lang';

const tree = parseTree('ports: [80, 443] # Comments');

getNodeAt(tree, 12);
//=> The IntegerNode `443`

getNodeAt(tree, 22);
//=> The `# Comments` line comment
```

### getNodeAtPath(tree, path)

The value node at `path`, such as for showing a schema error where the value is written. The path is the same as for [`edit()`](#edittext-pathornode-value-options), and an empty path gives the document's collection. Returns `undefined` when there is no value there, also when the path has a key where an array is, an index where an object is, or leads through a scalar.

```js
import {getNodeAtPath, parseTree} from 'soml-lang';

const tree = parseTree('servers: [{port: 8080}]');

getNodeAtPath(tree, ['servers', 0, 'port']);
//=> {type: 'Integer', value: 8080n, radix: 10, range: [17, 21], loc: {…}}

getNodeAtPath(tree, ['servers', 1]);
//=> undefined
```

### visitorKeys

The properties of each node type that hold its child nodes, in source order, for tools that walk the tree, such as an ESLint language plugin.

```js
import {visitorKeys} from 'soml-lang';

visitorKeys.Member;
//=> ['key', 'value']

visitorKeys.Integer;
//=> []
```

### format(text)

Format a document. Returns the document with its layout normalized, ending with one line feed.

The layout follows the [formatter](https://github.com/soml-lang/soml/blob/main/spec.md#formatting) in the specification: one tab per level, every member and item on its own line with no commas, and no trailing whitespace or runs of blank lines. An object or an array whose brackets are on one line stays on one line, as in `ports: [80, 443]`, with a comma and a space between its members or items. To give a one-line container one member or item per line, put a line break anywhere inside it. Comments, member order, block strings, and the spelling of every value stay as they are, so the value never changes. The one change inside a block comment is the same layout rule: trailing whitespace is removed, and runs of blank lines collapse to one.

Throws the same [`ParseError`](#parseerror) as `parse()`, and a `TypeError` when `text` is not a string.

```js
import {format} from 'soml-lang';

format('pool: {min: 2,   max: 16,} # Connections');
//=> 'pool: {min: 2, max: 16} # Connections\n'

format('pool: {\nmin: 2, max: 16}');
//=> 'pool: {\n\tmin: 2\n\tmax: 16\n}\n'
```

In detail, as the specification states:

- A block comment that a value follows on the same line, as in `1, /* note */ 2`, stays in front of that value when each item goes on its own line.
- One space follows each `:`, as in canonical form.
- A value on the line after its `key:` moves up to that line, unless a comment comes between them. Then it stays on its own line, one level deeper than the key, and the blank lines between them are removed.
- A block string begins on the line after its key, and its delimiters and content have the indentation of that line. Its lines are not otherwise changed.
- There are no blank lines at the start of the file or directly inside brackets.

### formatEdits(text)

The changes that [`format()`](#formattext) makes to a document, as edits of its text: an array of `{range: [start, end], text}`, with UTF-16 offsets into `text`. For an editor or a linter that applies each change in place.

The edits are sorted, do not overlap, and change only spaces, tabs, line feeds, and commas, as `format()` does. Each one is as small as possible, so it leaves out the characters at its ends that stay the same. Applying all of them gives the same text as `format()`, and a document that is already formatted gives no edits.

Throws the same errors as `format()`.

```js
import {formatEdits} from 'soml-lang';

formatEdits('a: [1,\n2]\n');
//=> [{range: [4, 4], text: '\n\t'}, {range: [5, 7], text: '\n\t'}, {range: [8, 8], text: '\n'}]
```

### edit(text, pathOrNode, value, options?)

Change one value in a document, and keep everything else as it is written: comments, member order, layout, and the spelling of every other value. For tools that update a config file, such as a dependency bumper or a `set` command.

The value at `pathOrNode` is replaced, or added when it does not exist yet, and an `undefined` value removes it. Instead of a path, you can pass a member, item, or value node from `parseTree(text)`, such as one that a linter reported. The node and the text must come from the same document. Only the changed part of the text is rewritten, and an edit to a formatted document leaves it formatted.

```js
import {edit, parseTree} from 'soml-lang';

edit('name: \'api\' # The service\nport: 8080\n', ['port'], 9090n);
//=> "name: 'api' # The service\nport: 9090\n"

edit('postgres: {host: \'db\'}\n', ['postgres', 'port'], 5432n);
//=> "postgres: {host: 'db', port: 5432}\n"

edit('a: 1\nb: 2\n', ['a'], undefined);
//=> 'b: 2\n'

const tree = parseTree('name: \'api\'\nport: 8080\n');
edit('name: \'api\'\nport: 8080\n', tree.body.members[1], 9090n);
//=> "name: 'api'\nport: 9090\n"
```

- A new value is written as `stringify()` writes it, at the indentation of its line. So `0xFF` that is replaced by `255n` becomes `255`, and `8080` becomes `8080.0` unless you pass `8080n` or the `integers: 'number'` option. The members of a new object keep their order, unless you pass the `canonical: true` option. In a container that is on one line, it is written on one line too, so `[1, 2]` with a new item `{a: 3n}` becomes `[1, 2, {a: 3}]`.
- A new member goes after the last member of its object. Missing objects on the way are created.
- A new item can be added at the end of an array, with the index that is its length.
- A new member or item goes on its own line without a comma, after the comments that the one before it owns (see below), and the commas of the other members and items stay as they are. When something follows the member or item before it on the same line, such as the closing bracket of the one-line container `{a: 1}`, it goes on that line after a comma, as in `{a: 1, b: 2}`. In an empty `[]` or `{}`, it goes on a line of its own, unless that container is inside a container on one line, so `a: [1, []]` becomes `a: [1, [2]]`.
- A removed member or item takes the comments it owns, which in a formatted document are the ones that `format()` keeps with it: the comments after it on its line, also after its comma when nothing else follows there, and the block comments before it on its line, after the comma or bracket before it. So removing `2` from `[1, /* note */ 2]` gives `[1]`. A comment on a line of its own belongs to no member or item, so it stays. A removed member or item also removes its lines when nothing else is on them. A line that a block comment after it continues onto counts as one of its lines. Removing every item of a container closes it up to `[]` or `{}`, unless a comment is left inside.
- A removed member or item takes its comma with it. When the removed item is the last one and has no comma after it, it takes the comma directly before it instead, when only spaces, tabs, and the comments it owns are between, so `[1, 2]` becomes `[1]`.
- Removing the only member of a document without braces leaves `{}`.

Comments inside a value that is replaced or removed are removed with it. In a layout that `format()` never writes, an edit can leave odd spacing, such as a new item after a closing block string delimiter on its line that is indented differently from its neighbors. The document is always valid and has the right value. Removing a value that does not exist changes nothing and is not an error: a missing member, a missing object or array on the way, or an index at or past the end of its array. So removing the same path twice is safe, and `edit(text, path, undefined) === text` tells whether something was removed.

The result is parsed before it is returned, so a bug in `edit()` throws an `Error` rather than returning a broken document.

Throws the same [`ParseError`](#parseerror) as `parse()` when `text` is not a valid document. Throws a `TypeError` when `text` is not a string, when `path` is not a non-empty array of keys and array indexes, when it leads through a value that is not an object or an array, or when it has a key where an array is or an index where an object is. Throws a `RangeError` when a value is set at an index past the end of its array, or at an index under a value that does not exist, or when the change would nest the document more than 100 levels deep. A `value` that cannot be represented or is out of range, and invalid `options`, throw as they do in `stringify()`.

#### text

Type: `string`

The document.

#### path

Type: `Array<string | number>`

The keys and array indexes that lead to the value, such as `['servers', 0, 'port']`.

#### value

Type: `unknown`

The new value, of the types that [`stringify()`](#stringifyvalue-options) accepts, or `undefined` to remove the value.

#### options

Type: `object`

##### integers

Type: `'bigint' | 'number'`\
Default: `'bigint'`

How an int is represented in `value`, as for [`stringify()`](#stringifyvalue-options).

```js
edit('port: 8080', ['port'], 9090, {integers: 'number'});
//=> 'port: 9090'
```

##### canonical

Type: `boolean`\
Default: `false`

Sort the members of every object in `value` by key, as for [`stringify()`](#stringifyvalue-options).

```js
edit('a: 1\n', ['b'], {y: 1n, x: 2n}, {canonical: true});
//=> 'a: 1\nb: {\n\tx: 2\n\ty: 1\n}\n'
```

### stringify(value, options?)

Serialize an object or an array to SOML. Nesting is written with braces and tabs, and the output ends with one line feed. Comments and block strings are never written.

Members keep the order of `value`, which reads better in a file for people, and every other rule of canonical form is followed. With the [`canonical: true`](#canonical-1) option, members are sorted by key, and the output is canonical form: two equal values produce the same bytes, so it can be hashed, signed, or compared.

JavaScript puts integer-like keys, such as `404` or `10`, before every other key, in numeric order, so their order in `value` cannot be kept.

Besides the types that `parse()` returns, a `Date` is accepted and written as an instant, a `Temporal.Duration` is accepted when it has no years, months, weeks, or days, because those are not a fixed length, and a member whose value is `undefined` is left out, as `JSON.stringify` does.

Throws a `TypeError` for a value that cannot be represented: `NaN`, a function, a symbol value, an object that is neither a plain object nor an array (such as a class instance or a `Map`), `undefined` in an array, a circular reference, a non-collection at the top level, an invalid `Date`, a `Temporal.Duration` with years, months, weeks, or days, an object that only claims to be a `Date`, a `Temporal.Instant`, or a `Temporal.Duration`, and a string or key with a lone surrogate or a carriage return. Also when `options` is not an object, its `integers` is not `'bigint'` or `'number'`, or its `canonical` is not a boolean. Throws a `RangeError` for an int outside the 64-bit range, an instant outside the years 0001 to 9999, a duration outside the 64-bit range of nanoseconds, and nesting deeper than 100 levels.

```js
import {stringify} from 'soml-lang';

stringify({name: 'api-gateway', replicas: 3n, timeout: 30});
//=> "name: 'api-gateway'\nreplicas: 3\ntimeout: 30.0\n"
```

#### value

Type: `object`

A plain object or an array.

#### options

Type: `object`

##### integers

Type: `'bigint' | 'number'`\
Default: `'bigint'`

How an int is represented in `value`.

- `'bigint'`: A `bigint` is written as an int, and a `number` is always written as a float, so `8080` becomes `8080.0`.
- `'number'`: A `number` that is a safe integer is written as an int, and any other `number` as a float. A `bigint` is still written as an int.

```js
stringify({port: 8080});
//=> 'port: 8080.0\n'

stringify({port: 8080}, {integers: 'number'});
//=> 'port: 8080\n'
```

##### canonical

Type: `boolean`\
Default: `false`

Write exact canonical form, with the members of every object sorted by key, for hashing, signing, or comparing.

```js
stringify({name: 'api', description: 'The edge service'});
//=> "name: 'api'\ndescription: 'The edge service'\n"

stringify({name: 'api', description: 'The edge service'}, {canonical: true});
//=> "description: 'The edge service'\nname: 'api'\n"
```

### stringifyValue(value, options?)

Serialize one value as it is written in a document: a scalar on one line, and an object or an array in braces or brackets over several lines, with each level indented by one more tab. There is no line feed at the end.

For showing a value, as in a message, or for writing it into a template. Use [`stringify()`](#stringifyvalue-options) to write a whole document, and [`edit()`](#edittext-pathornode-value-options) to change a value in one.

It takes the same values and [options](#options-2) as `stringify()`, and any of them at the top level, so `1.5` gives `'1.5'` and `'it\'s'` gives `"it's"`. Members keep their order, as in `stringify()`, unless the `canonical: true` option sorts them. It throws as `stringify()` does, and a `TypeError` for `undefined`.

```js
import {stringifyValue} from 'soml-lang';

stringifyValue(0.1 + 0.2);
//=> '0.30000000000000004'

stringifyValue(8080n);
//=> '8080'

stringifyValue({b: 1n, a: [true]});
//=> '{\n\tb: 1\n\ta: [\n\t\ttrue\n\t]\n}'

stringifyValue({b: 1n, a: [true]}, {canonical: true});
//=> '{\n\ta: [\n\t\ttrue\n\t]\n\tb: 1\n}'
```

Canonical form gives equal values the same text, so it also tells whether two values are equal. The order of the keys does not matter, and with the default `integers` option, an int and a float are never equal, as in the spec.

```js
import {stringifyValue} from 'soml-lang';

const isEqual = (first, second) => stringifyValue(first, {canonical: true}) === stringifyValue(second, {canonical: true});

isEqual({b: 1n, a: [true]}, {a: [true], b: 1n});
//=> true

isEqual(3n, 3);
//=> false
```

### compareKeys(left, right)

Compare two keys in canonical order, which is by their Unicode scalar values, as `stringify()` sorts members with the `canonical: true` option. For a sort, such as in a lint rule that keeps the members of an object in canonical order.

The default `Array#sort()` compares UTF-16 code units, which puts U+E000 to U+FFFF after every character above U+FFFF, so it differs from canonical order for keys that hold such characters.

Returns a negative number when `left` comes first, a positive number when `right` comes first, and `0` when they are equal.

```js
import {compareKeys} from 'soml-lang';

['b', 'a', '😀', 'ﬀ'].toSorted(compareKeys);
//=> ['a', 'b', 'ﬀ', '😀']
```

### isBareKey(key)

Whether a key can be written without quotes, as a bare key: one or more ASCII letters, digits, `_`, or `-`, in any order, so `404` and `-x` are bare keys too. `stringify()` writes such a key bare and quotes every other key.

```js
import {isBareKey} from 'soml-lang';

isBareKey('content-type');
//=> true

isBareKey('a.b');
//=> false
```

### formatKey(key)

A key as it must be written in a document: bare when it can be, and otherwise as a `'...'` or `"..."` string. The same choice `stringify()` makes.

```js
import {formatKey} from 'soml-lang';

formatKey('name');
//=> 'name'

formatKey('content type');
//=> "'content type'"
```

### formatFloat(value)

A number as it must be written in a document: the shortest decimal that reads back as the same binary64 value, laid out as ECMAScript `Number::toString` does, which is also RFC 8785's choice, with `infinity` and `-infinity`. A fractional part is added when there is neither one nor an exponent, so that a float never reads back as an int. The same writer `stringifyValue()` uses.

Throws a `TypeError` for `NaN`, which is not representable.

```js
import {formatFloat} from 'soml-lang';

formatFloat(30);
//=> '30.0'

formatFloat(0.1 + 0.2);
//=> '0.30000000000000004'

formatFloat(Infinity);
//=> 'infinity'
```

### formatString(string)

A string as it must be written in a document: a `'...'` literal string when it needs no escapes, and otherwise a `"..."` escaped string. The same choice `stringifyValue()` makes. A block string is never written.

Throws a `TypeError` for a string with a lone surrogate or a carriage return, as for `stringify()`.

```js
import {formatString} from 'soml-lang';

formatString('api-gateway');
//=> "'api-gateway'"

formatString("it's");
//=> '"it\'s"'
```

### formatBlockString(string)

Write a string as a block string without a trailing line feed. Literal blocks use a delimiter longer than any leading quote run in the content. Values whose blank lines or control characters cannot be preserved literally use an escaped block with one encoded content line.

The output is unindented. To nest it, prefix every line after the opening delimiter with the same spaces or tabs, including the closing delimiter. Block strings cannot be used as keys.

Throws `TypeError` for a carriage return or lone surrogate, which SOML cannot represent.

```js
import {formatBlockString} from 'soml-lang';

formatBlockString('hello\nworld');
//=> "'''\nhello\nworld\n'''"
```


### ParseError

Thrown when the input is not a valid document, by `parse()`, `parseTree()`, `format()`, and `edit()`. Extends `SyntaxError`.

The `message` includes the position and a code frame. Use `reason` for the message alone.

```js
import {parse, ParseError} from 'soml-lang';

try {
	parse('name: api-gateway');
} catch (error) {
	if (error instanceof ParseError) {
		console.log(error.message);
	}
}
// Unexpected “api-gateway”. A string value must be quoted, as in 'api-gateway' at line 1, column 7
//
// > 1 | name: api-gateway
//     |       ^
```

#### reason

Type: `string`

What is wrong, without the position.

#### line

Type: `number`

The 1-based line of the error.

#### column

Type: `number`

The 1-based column of the error, counted in Unicode code points.

#### offset

Type: `number`

The 0-based UTF-16 index of the error in the decoded text.

#### codeFrame

Type: `string`

Up to three lines ending at the error, with a caret under the position. A long line is clipped around the position.

## Limits

- **Nesting is limited to 100 levels**, as the spec requires: deeper documents are rejected, `stringify()` refuses a deeper value, and `edit()` refuses a change that would make one. The document's own collection is level 1, so `a: {b: {c: 1}}` has a depth of 3.

## Conformance suite

[`test/conformance`](test/conformance) holds the cases as plain files, so that another implementation can run them:

- `valid/**/name.soml` must parse to the value in `name.json`, and serialize in canonical form, with members sorted by key, to exactly `name.canonical.soml`. An implementation that has a formatter must also format it to exactly `name.formatted.soml`.
- `invalid/**/name.soml` must be rejected.
- `edit/name.json` holds a formatted `document`, a `path`, a tagged `value`, which is left out for a removal, and the `expected` document. An implementation that has an editor must give exactly `expected` when it sets `path` to `value`, or removes it. A case with `error: true` instead of `expected` has a path that does not fit the document, and the change must fail.

The expected values are tagged JSON, as in [toml-test](https://github.com/toml-lang/toml-test): `{"type": "int", "value": "3"}`. The types are `string`, `int`, `float`, `bool`, `null`, `instant`, and `duration`. A float's value is its canonical spelling, including `infinity` and `-infinity`, an instant's is its canonical UTC form, and a duration's is its length in nanoseconds as a decimal int. Case names differ in more than letter case, and none is a name that Windows reserves, such as `nul`, so the suite checks out on every file system.

## Benchmark

```sh
npm run bench
```

The time to read and to write each of the [shared benchmark fixtures](https://github.com/soml-lang/soml/tree/main/benchmark), with the same data in each format, on an Apple M-series machine with Node.js 26. `service` is a 3 KB config, `platform` a 35 KB config with many comments, and `earthquakes` a 733 KB GeoJSON feed. Lower is better.

| | this package | smol-toml | @iarna/toml | json5 | `JSON` |
|---|--:|--:|--:|--:|--:|
| Read `service` | 29 µs | 24 µs | 91 µs | 145 µs | 5.5 µs |
| Read `platform` | 230 µs | 195 µs | 540 µs | 920 µs | 41 µs |
| Read `earthquakes` | 7.7 ms | 6.9 ms | 21 ms | 46 ms | 1.6 ms |
| Write `service` | 19 µs | 17 µs | 49 µs | 51 µs | 4.2 µs |
| Write `platform` | 144 µs | 108 µs | 330 µs | 330 µs | 31 µs |
| Write `earthquakes` | 7.3 ms | 6.5 ms | 15 ms | 15 ms | 1.9 ms |

`JSON` is native code and a much smaller grammar, so it is the ceiling rather than a competitor. `npm run bench` also measures jsonc-parser and toml, which only parse. `parseTree()` and `format()` take several times as long as `parse()`, because the tree has a node and a location for every token.
