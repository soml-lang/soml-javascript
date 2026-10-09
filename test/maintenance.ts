import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

function prepareBenchmarkUpdater(directory: string) {
	const scripts = path.join(directory, 'package/scripts');
	const source = path.join(directory, 'package/source');
	const benchmark = path.join(directory, 'soml/benchmark');
	for (const folder of [scripts, source, benchmark]) {
		fs.mkdirSync(folder, {recursive: true});
	}

	fs.writeFileSync(path.join(directory, 'package/package.json'), '{"type":"module"}');
	const script = path.join(scripts, 'update-benchmark-fixtures.ts');
	fs.copyFileSync(path.join(import.meta.dirname, '../scripts/update-benchmark-fixtures.ts'), script);
	const parserUrl = pathToFileURL(path.join(import.meta.dirname, '../source/index.ts')).href;
	fs.writeFileSync(path.join(source, 'index.ts'), `export * from ${JSON.stringify(parserUrl)};\n`);
	fs.copyFileSync(path.join(import.meta.dirname, '../source/shared.ts'), path.join(source, 'shared.ts'));
	return {script, benchmark, parserUrl};
}

function runInvalidReasonUpdater(fixtures: Record<string, string>) {
	const temporary = path.join(import.meta.dirname, '../.ai-temporary');
	fs.mkdirSync(temporary, {recursive: true});
	using directory = fs.mkdtempDisposableSync(path.join(temporary, 'invalid-reasons-'));
	const scripts = path.join(directory.path, 'package/scripts');
	const source = path.join(directory.path, 'package/source');
	const conformance = path.join(directory.path, 'soml/conformance');
	const invalid = path.join(conformance, 'invalid');
	for (const folder of [scripts, source, invalid]) {
		fs.mkdirSync(folder, {recursive: true});
	}

	fs.writeFileSync(path.join(directory.path, 'package/package.json'), '{"type":"module"}');
	const script = path.join(scripts, 'update-invalid-reasons.ts');
	fs.copyFileSync(path.join(import.meta.dirname, '../scripts/update-invalid-reasons.ts'), script);
	const parserUrl = pathToFileURL(path.join(import.meta.dirname, '../source/index.ts')).href;
	fs.copyFileSync(path.join(import.meta.dirname, '../source/shared.ts'), path.join(source, 'shared.ts'));
	// Exercise the actual updater and parser, injecting a crash after a normal syntax failure.
	fs.writeFileSync(path.join(source, 'index.ts'), `
import {parse as parseDocument} from ${JSON.stringify(parserUrl)};
export {ParseError} from ${JSON.stringify(parserUrl)};
export function parse(bytes) {
	if (new TextDecoder().decode(bytes) === 'parser crash') {
		throw new RangeError('Unexpected parser crash');
	}

	return parseDocument(bytes);
}
`);
	for (const [name, text] of Object.entries(fixtures)) {
		fs.writeFileSync(path.join(invalid, `${name}.soml`), text);
	}

	const fixture = path.join(conformance, 'invalid-reasons.json');
	const previous = '{"a":{"reason":"Previous reason","line":1,"column":1}}\n';
	fs.writeFileSync(fixture, previous);
	const result = spawnSync(process.execPath, [script], {encoding: 'utf8'});
	return {result, previous, updated: fs.readFileSync(fixture, 'utf8')};
}

test('updating invalid reasons preserves the fixture when the parser crashes', () => {
	const {result, previous, updated} = runInvalidReasonUpdater({a: 'a: nope', z: 'parser crash'});
	assert.equal(updated, previous);
	assert.notEqual(result.status, 0, result.stderr);
	assert.match(result.stderr, /RangeError: Unexpected parser crash/v);
});

test('updating invalid reasons records syntax errors and removes obsolete entries', () => {
	const {result, updated} = runInvalidReasonUpdater({b: 'a: [1'});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(updated), {b: {reason: 'Unterminated array: expected “]”', line: 1, column: 4}});
	assert.match(result.stdout, /Removed: a/v);
});

test('updating benchmark fixtures preserves types, precision, and existing outputs on failure', () => {
	const temporary = path.join(import.meta.dirname, '../.ai-temporary');
	fs.mkdirSync(temporary, {recursive: true});
	using directory = fs.mkdtempDisposableSync(path.join(temporary, 'benchmark-fixtures-'));
	const {script, benchmark} = prepareBenchmarkUpdater(directory.path);
	const fixture = path.join(benchmark, 'sample.soml');
	fs.writeFileSync(fixture, String.raw`# fixture
count: 9_007_199_254_740_993
ratio: 180.0
'group.key': {hex: 0xFF, enabled: true, values: [0o7, 0b10, 1.25]}
time: 2026-09-19T14:00:00.123456789+01:00
duration: 1h2m3s4ms5us6ns
empty: null
nested: {
	label: "line\nquote\""
	rows: [{id: 7}, {id: 2}]
}
`);
	const expected = {
		json: String.raw`{
	"count": 9007199254740993,
	"ratio": 180.0,
	"group.key": {"hex": 255, "enabled": true, "values": [7, 2, 1.25]},
	"time": "2026-09-19T13:00:00.123456789Z",
	"duration": "PT1H2M3.004005006S",
	"empty": null,
	"nested": {
		"label": "line\nquote\"",
		"rows": [{"id": 7}, {"id": 2}]
	}
}
`,
		toml: String.raw`# fixture
count = 9_007_199_254_740_993
ratio = 180.0
'group.key' = { hex = 0xFF, enabled = true, values = [0o7, 0b10, 1.25] }
time = 2026-09-19T14:00:00.123456789+01:00
duration = "PT1H2M3.004005006S"

[nested]
label = "line\nquote\""
rows = [{ id = 7 }, { id = 2 }]
`,
	};
	const result = spawnSync(process.execPath, [script], {encoding: 'utf8'});
	assert.equal(result.status, 0, result.stderr);
	for (const [extension, text] of Object.entries(expected)) {
		assert.equal(fs.readFileSync(path.join(benchmark, `sample.${extension}`), 'utf8'), text);
	}

	fs.writeFileSync(fixture, 'items: [null]\n');
	const failure = spawnSync(process.execPath, [script], {encoding: 'utf8'});
	assert.notEqual(failure.status, 0, failure.stderr);
	assert.match(failure.stderr, /TypeError: TOML cannot hold a null here/v);
	for (const [extension, text] of Object.entries(expected)) {
		assert.equal(fs.readFileSync(path.join(benchmark, `sample.${extension}`), 'utf8'), text);
	}
});

test('benchmark comment attachment scales linearly with the number of entries', () => {
	const temporary = path.join(import.meta.dirname, '../.ai-temporary');
	fs.mkdirSync(temporary, {recursive: true});
	using directory = fs.mkdtempDisposableSync(path.join(temporary, 'benchmark-comments-'));
	const {script, parserUrl} = prepareBenchmarkUpdater(directory.path);
	// Expose the real writer in the isolated copy; fixture reading and disk writes are outside the measurement.
	fs.appendFileSync(script, '\nexport {Writer};\n');
	const code = String.raw`
import assert from 'node:assert/strict';
import {parseTree} from ${JSON.stringify(parserUrl)};
import {Writer} from ${JSON.stringify(pathToFileURL(script).href)};
function prepare(count, shape) {
	let text;
	let expectedLines;
	switch (shape) {
		case 'flat members': {
			text = Array.from({length: count}, (_, index) => 'k' + index + ': 1 # comment ' + index).join('\n');
			expectedLines = count;
			break;
		}
		case 'nested tables': {
			text = Array.from({length: count}, (_, index) => 'k' + index + ': {\na: 1 # comment ' + index + '\n}').join('\n');
			expectedLines = count * 3;
			break;
		}
		case 'array of tables': {
			text = 'a: [\n' + Array.from({length: count}, (_, index) => '{\na: 1 # comment ' + index + '\n}').join('\n') + '\n]';
			expectedLines = count * 3;
			break;
		}
		case 'leading comments': {
			text = Array.from({length: count}, (_, index) => '# comment ' + index).join('\n') + '\na: 1';
			expectedLines = count + 1;
			break;
		}
	}
	return {text, document: parseTree(text), expectedLines};
}
function write(input) {
	const writer = new Writer(input.document, input.text);
	const lines = writer.toml(input.document.body, []);
	assert.equal(lines.length, input.expectedLines);
	assert.equal(writer.writtenComments, input.document.comments.length);
}
function time(input) {
	let fastest = Infinity;
	for (let index = 0; index < 7; index++) {
		const start = process.cpuUsage();
		write(input);
		const elapsed = process.cpuUsage(start);
		fastest = Math.min(fastest, elapsed.user + elapsed.system);
	}
	return fastest;
}
const measurements = [];
for (const shape of ['flat members', 'nested tables', 'array of tables', 'leading comments']) {
	const small = prepare(2_000, shape);
	const large = prepare(16_000, shape);
	for (let index = 0; index < 3; index++) {
		write(small);
		write(large);
	}
	measurements.push([shape, time(large) / time(small)]);
}
assert.ok(measurements.every(([, ratio]) => ratio < 24), '8 times the input used these CPU time ratios: ' + JSON.stringify(measurements));
`;
	const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {encoding: 'utf8'});
	assert.equal(result.status, 0, result.stderr);
});

test('benchmark conversion rejects malformed UTF-8 without overwriting generated fixtures', () => {
	const temporary = path.join(import.meta.dirname, '../.ai-temporary');
	fs.mkdirSync(temporary, {recursive: true});
	using directory = fs.mkdtempDisposableSync(path.join(temporary, 'benchmark-utf8-'));
	const {script, benchmark} = prepareBenchmarkUpdater(directory.path);
	const previous = {json: '{"name":"previous"}\n', toml: 'name = "previous"\n'};
	for (const [extension, text] of Object.entries(previous)) {
		fs.writeFileSync(path.join(benchmark, `sample.${extension}`), text);
	}

	const invalidSources = [
		...[[0xFF], [0xC0, 0xAF], [0xED, 0xA0, 0x80], [0xF0, 0x9F]].map(bytes => Buffer.concat([Buffer.from('name: \''), Buffer.from(bytes), Buffer.from('\'\n')])),
		Buffer.from('\u{FEFF}name: \'value\'\n'),
	];
	for (const source of invalidSources) {
		fs.writeFileSync(path.join(benchmark, 'sample.soml'), source);
		const result = spawnSync(process.execPath, [script], {encoding: 'utf8'});
		assert.notEqual(result.status, 0, result.stderr);
		for (const [extension, text] of Object.entries(previous)) {
			assert.equal(fs.readFileSync(path.join(benchmark, `sample.${extension}`), 'utf8'), text);
		}
	}

	fs.writeFileSync(path.join(benchmark, 'sample.soml'), 'name: \'\u{FFFD}\'\n');
	const result = spawnSync(process.execPath, [script], {encoding: 'utf8'});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(benchmark, 'sample.json'), 'utf8')), {name: '\u{FFFD}'});
	assert.equal(fs.readFileSync(path.join(benchmark, 'sample.toml'), 'utf8'), 'name = \'\u{FFFD}\'\n');
});

test('benchmark arrays of tables retain comments after their closing brackets', () => {
	const temporary = path.join(import.meta.dirname, '../.ai-temporary');
	fs.mkdirSync(temporary, {recursive: true});
	using directory = fs.mkdtempDisposableSync(path.join(temporary, 'benchmark-array-comments-'));
	const {script, benchmark} = prepareBenchmarkUpdater(directory.path);
	for (const [text, expected] of [
		['servers: [\n{name: \'api\'\n}\n] # ABOUT SERVERS\n', '[[servers]]\nname = \'api\'\n# ABOUT SERVERS\n'],
		['servers: [\n{name: \'api\'\n}\n] /* ABOUT\n SERVERS */\n', '[[servers]]\nname = \'api\'\n# ABOUT\n# SERVERS\n'],
		['outer: {\nservers: [\n{name: \'api\'\n}\n] # NESTED SERVERS\n}\n', '[[outer.servers]]\nname = \'api\'\n# NESTED SERVERS\n'],
	] as const) {
		fs.writeFileSync(path.join(benchmark, 'sample.soml'), text);
		const result = spawnSync(process.execPath, [script], {encoding: 'utf8'});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(fs.readFileSync(path.join(benchmark, 'sample.toml'), 'utf8'), expected);
		assert.equal(result.stderr, '');
	}
});

test('benchmark fixtures retain comments between a member colon and its value', () => {
	const temporary = path.join(import.meta.dirname, '../.ai-temporary');
	fs.mkdirSync(temporary, {recursive: true});
	using directory = fs.mkdtempDisposableSync(path.join(temporary, 'benchmark-value-comments-'));
	const {script, benchmark} = prepareBenchmarkUpdater(directory.path);
	for (const [text, expected] of [
		['value: # VALUE COMMENT\n\t1\n', '# VALUE COMMENT\nvalue = 1\n'],
		['value: /* VALUE COMMENT */ 1\n', '# VALUE COMMENT\nvalue = 1\n'],
		['{a: 1, b: /* FOR B */ 2}', 'a = 1\n# FOR B\nb = 2\n'],
		['outer: # TABLE COMMENT\n\t{\nvalue: 1\n}\n', '# TABLE COMMENT\n[outer]\nvalue = 1\n'],
		['servers: # ARRAY COMMENT\n\t[\n{name: \'api\'\n}\n]\n', '# ARRAY COMMENT\n[[servers]]\nname = \'api\'\n'],
		['empty: # OMITTED VALUE COMMENT\n\tnull\nport: 1\n', '# OMITTED VALUE COMMENT\nport = 1\n'],
	] as const) {
		fs.writeFileSync(path.join(benchmark, 'sample.soml'), text);
		const result = spawnSync(process.execPath, [script], {encoding: 'utf8'});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(fs.readFileSync(path.join(benchmark, 'sample.toml'), 'utf8'), expected);
		assert.equal(result.stderr, '');
	}
});

test('benchmark conversion normalizes negative-zero floats while keeping their type', () => {
	const temporary = path.join(import.meta.dirname, '../.ai-temporary');
	fs.mkdirSync(temporary, {recursive: true});
	using directory = fs.mkdtempDisposableSync(path.join(temporary, 'benchmark-negative-zero-'));
	const {script, benchmark} = prepareBenchmarkUpdater(directory.path);
	fs.writeFileSync(path.join(benchmark, 'sample.soml'), 'literal: -0.0\nexponent: -0e5\nfraction: -0.000e-5\nlist: [-0.0e5, 0.0, -1.5]\n');
	const result = spawnSync(process.execPath, [script], {encoding: 'utf8'});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(fs.readFileSync(path.join(benchmark, 'sample.toml'), 'utf8'), 'literal = 0.0\nexponent = 0e5\nfraction = 0.000e-5\nlist = [0.0e5, 0.0, -1.5]\n');
	assert.equal(fs.readFileSync(path.join(benchmark, 'sample.json'), 'utf8'), '{\n\t"literal": 0.0,\n\t"exponent": 0.0,\n\t"fraction": 0.0,\n\t"list": [0.0, 0.0, -1.5]\n}\n');
	assert.equal(result.stderr, '');
});

test('benchmark conversion writes large comments and table bodies without argument limits', () => {
	const temporary = path.join(import.meta.dirname, '../.ai-temporary');
	fs.mkdirSync(temporary, {recursive: true});
	const count = 150_000;
	const comment = `/*\n${'line\n'.repeat(count)}*/`;
	const commentLines = `#\n${'#line\n'.repeat(count)}#\n`;
	const members = Array.from({length: count}, (_, index) => `key${index}: ${index}\n`).join('');
	const values = Array.from({length: count}, (_, index) => `key${index} = ${index}\n`).join('');
	const cases = [
		{source: `${comment}\na: 1\n`, toml: `${commentLines}a = 1\n`},
		{source: `table: {\n${members}}\n`, toml: `[table]\n${values}`},
		{source: `rows: [{\n${members}}]\n`, toml: `[[rows]]\n${values}`},
		{source: `items: [\n${comment}\n1\n]\n`, toml: `items = [\n\t#\n${'\t#line\n'.repeat(count)}\t#\n\t1,\n]\n`},
	];
	for (const {source, toml} of cases) {
		using directory = fs.mkdtempDisposableSync(path.join(temporary, 'benchmark-large-'));
		const {script, benchmark} = prepareBenchmarkUpdater(directory.path);
		fs.writeFileSync(path.join(benchmark, 'sample.soml'), source);
		const result = spawnSync(process.execPath, [script], {encoding: 'utf8'});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(fs.readFileSync(path.join(benchmark, 'sample.toml'), 'utf8'), toml);
		assert.equal(result.stderr, '');
	}
});

test('updating invalid reasons retains fixture names that match prototype properties', () => {
	const names = ['__proto__', 'constructor', 'toString'];
	const {result, updated} = runInvalidReasonUpdater(Object.fromEntries(names.map(name => [name, 'a: [1'])));
	assert.equal(result.status, 0, result.stderr);
	const reason = {reason: 'Unterminated array: expected “]”', line: 1, column: 4};
	assert.deepEqual(JSON.parse(updated), Object.fromEntries(names.map(name => [name, reason])));
	assert.equal(result.stderr, '');
});

test('benchmark conversion scans large literal strings within a bounded memory budget', () => {
	const temporary = path.join(import.meta.dirname, '../.ai-temporary');
	fs.mkdirSync(temporary, {recursive: true});
	using directory = fs.mkdtempDisposableSync(path.join(temporary, 'benchmark-string-memory-'));
	const {script, benchmark} = prepareBenchmarkUpdater(directory.path);
	const value = '😀'.repeat(4_000_000);
	fs.writeFileSync(path.join(benchmark, 'sample.soml'), `a: '${value}'\n`);
	// Leave room for parsing and both output formats, without allocating an array of every character.
	const result = spawnSync(process.execPath, ['--max-old-space-size=128', script], {encoding: 'utf8'});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(fs.readFileSync(path.join(benchmark, 'sample.json'), 'utf8'), `{"a": "${value}"}\n`);
	assert.equal(fs.readFileSync(path.join(benchmark, 'sample.toml'), 'utf8'), `a = '${value}'\n`);
	assert.equal(result.stderr, '');
});
