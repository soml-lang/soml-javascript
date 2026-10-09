import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
	parse,
	stringify,
	stringifyValue,
	formatString,
	formatBlockString,
	formatFloat,
} from '../source/index.ts';
import {convertFixture} from '../scripts/update-benchmark-fixtures.ts';

test('serialization never reads an inherited member after an earlier getter deletes the own property', () => {
	for (const isCanonical of [false, true]) {
		const prototype = Object.create(null) as Record<string, unknown>;
		let inheritedReads = 0;
		Object.defineProperty(prototype, 'zDeleted', {
			get() {
				inheritedReads++;
				return 'inherited';
			},
		});
		const object = Object.create(prototype) as Record<string, unknown>;
		Object.defineProperties(object, {
			aFirst: {
				enumerable: true,
				get() {
					delete object['zDeleted'];
					return 'own';
				},
			},
			zDeleted: {value: 'own', enumerable: true, configurable: true},
		});
		assert.equal(stringify(object, {canonical: isCanonical}), 'aFirst: \'own\'\n');
		assert.equal(inheritedReads, 0);
	}
});

test('unsupported-value diagnostics do not execute a constructor getter', () => {
	const object = new Map();
	Object.defineProperty(object, 'constructor', {
		get() {
			throw new Error('Unexpected constructor getter');
		},
	});
	assert.throws(() => stringifyValue(object), {name: 'TypeError', message: /Cannot serialize/v});
});

test('unsupported-value diagnostics do not execute a constructor name getter', () => {
	const constructor = function () {
		return undefined;
	};

	Object.defineProperty(constructor, 'name', {
		get() {
			throw new Error('Unexpected constructor name getter');
		},
	});
	const prototype = Object.create(Map.prototype) as Record<string, unknown>;
	Object.defineProperty(prototype, 'constructor', {value: constructor});
	const object = Object.create(prototype) as unknown;
	assert.throws(() => stringifyValue(object), {name: 'TypeError', message: /Cannot serialize/v});
});

test('diagnostics bound long constructor names and escape terminal controls', () => {
	const constructor = function () {
		return undefined;
	};

	Object.defineProperty(constructor, 'name', {value: `\u{1B}[2J${'x'.repeat(10_000)}`});
	const prototype = {constructor};
	Object.setPrototypeOf(prototype, Map.prototype);
	const value = Object.create(prototype) as unknown;
	assert.throws(() => stringifyValue(value), error => error instanceof TypeError && error.message.length < 300 && !error.message.includes('\u{1B}'));
});

test('all escaped control characters preserve their value across chunk boundaries', () => {
	const controls = Array.from({length: 32}, (_, code) => String.fromCharCode(code)).filter(character => character !== '\r').join('') + '\u{7F}';
	const value = `${'x'.repeat(32_760)}${controls.repeat(2000)}😀`;
	assert.deepEqual(parse(`value: ${formatString(value)}`), {value});
});

test('explicit string styles preserve literal-safe astral and non-ASCII text', () => {
	const value = String.raw`😀 β ﬀ \ "`;
	for (const style of ['literal', 'escaped'] as const) {
		assert.deepEqual(parse(`value: ${formatString(value, {style})}`), {value});
	}
});

test('sparse duration fields preserve subsecond precision and negative signs', () => {
	for (const value of [{hours: 12}, {minutes: -2}, {milliseconds: 1}, {microseconds: -1}, {nanoseconds: 1}]) {
		const duration = Temporal.Duration.from(value);
		const written = stringifyValue(duration);
		assert.equal(stringify(parse(`value: ${written}`)), `value: ${written}\n`);
	}
});

test('float formatting normalizes only positive exponents and preserves finite extremes', () => {
	for (const value of [Number.MIN_VALUE, Number.MAX_VALUE, 1e21, 1e-7, 1.5e22, 3.5]) {
		assert.deepEqual(parse(`value: ${formatFloat(value)}`), {value});
	}
});

test('fixture conversion keeps literal and escaped key representations', () => {
	const fixture = convertFixture('\'content type\': \'hello\'\n"quoted key": "it\'s"\n');
	assert.equal(fixture.toml, '\'content type\' = \'hello\'\n"quoted key" = "it\'s"\n');
	assert.deepEqual(JSON.parse(fixture.json), {'content type': 'hello', 'quoted key': 'it\'s'});
});

test('fixture conversion preserves comments attached to the same line and to nested collections', () => {
	const text = '# file\n\nname: \'service\' # trailing\nitems: [\n\t# example\n\t1\n\t# closing\n]\n';
	const fixture = convertFixture(text);
	assert.equal(fixture.writtenComments, 4);
	assert.equal(fixture.commentCount, 4);
	assert.match(fixture.toml, /name = 'service' # trailing/v);
	assert.match(fixture.toml, /# example\n\t1,/v);
	assert.match(fixture.toml, /# closing/v);
});

test('fixture conversion distinguishes file headers from member comments when TOML moves tables', () => {
	const fixture = convertFixture('# file\n\n# table\nservice: {\n\tname: \'api\'\n}\nport: 8080\n');
	assert.ok(fixture.toml.startsWith('# file\n\nport = 8080\n\n# table\n[service]\n'));
	assert.equal(fixture.writtenComments, fixture.commentCount);
});

test('fixture conversion retains exact 64-bit integers and nanosecond instants', () => {
	const fixture = convertFixture('integer: 9223372036854775807\ninstant: 2026-09-19T14:00:00.000000001Z\n');
	assert.match(fixture.json, /9223372036854775807/v);
	assert.match(fixture.toml, /2026-09-19T14:00:00\.000000001Z/v);
});

test('fixture conversion preserves all benchmark fixtures byte for byte', () => {
	for (const name of ['service', 'platform', 'earthquakes']) {
		const read = (extension: string) => fs.readFileSync(new URL(`../bench/fixtures/${name}.${extension}`, import.meta.url), 'utf8');
		const converted = convertFixture(read('soml'));
		assert.equal(converted.json, read('json'));
		assert.equal(converted.toml, read('toml'));
	}
});

test('fixture conversion rejects unsupported JSON and TOML values without writing files', () => {
	assert.throws(() => convertFixture('value: infinity'), {name: 'TypeError', message: /JSON cannot hold/v});
	assert.throws(() => convertFixture('value: [null]'), {name: 'TypeError', message: /TOML cannot hold/v});
	assert.throws(() => convertFixture('[1]'), {name: 'TypeError', message: /object at the top/v});
});

test('block strings preserve leading quote runs and whitespace-only values', () => {
	for (const value of ['\'\'\'\n\'\'\'\'', '  \n\t', '']) {
		assert.deepEqual(parse(`value:\n\t${formatBlockString(value).replaceAll('\n', '\n\t')}`), {value});
	}
});
