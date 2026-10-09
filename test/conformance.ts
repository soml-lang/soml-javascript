/*
Runs the language-neutral suite in `conformance/`.

- `valid/**\/name.soml` must parse to the tagged value in `name.json`, serialize with `canonical: true` to exactly `name.canonical.soml`, and format to exactly `name.formatted.soml`.
- `invalid/**\/name.soml` must be rejected.
- `edit/name.json` holds a formatted `document`, a `path`, a tagged `value`, which is left out for a removal, and the `expected` document after the change, or `error: true` when the change must fail because its path does not fit the document.

Each file is read as bytes, so the UTF-8 checks run too, and also as a string when the bytes are valid UTF-8.
*/
import {test, suite} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
	edit,
	format,
	parse,
	stringify,
	ParseError,
} from '../source/index.ts';
import {normalize} from './helpers.ts';

const root = path.join(import.meta.dirname, 'conformance');

function listCases(directory: string): string[] {
	return fs.readdirSync(path.join(root, directory), {recursive: true, encoding: 'utf8'})
		.filter(file => file.endsWith('.soml') && !/\.(?:canonical|formatted)\.soml$/v.test(file))
		.map(file => file.slice(0, -'.soml'.length))
		.toSorted();
}

/*
The tagged JSON of the suite: arrays, objects, and `{type, value}` leaves.
*/
type Tagged = Tagged[] | {
	readonly type?: unknown;
	readonly value?: unknown;
	readonly [key: string]: unknown;
};

/*
Turns the tagged JSON of the suite into the values this implementation returns.
*/
function untag(tagged: Tagged): unknown {
	if (Array.isArray(tagged)) {
		return tagged.map(item => untag(item));
	}

	if (typeof tagged.type === 'string' && typeof tagged.value === 'string' && Object.keys(tagged).length === 2) {
		switch (tagged.type) {
			case 'string': {
				return tagged.value;
			}

			case 'int': {
				return BigInt(tagged.value);
			}

			case 'float': {
				const infinities: Partial<Record<string, number>> = {infinity: Infinity, '-infinity': -Infinity};
				return infinities[tagged.value] ?? Number(tagged.value);
			}

			case 'bool': {
				return tagged.value === 'true';
			}

			case 'null': {
				return null;
			}

			case 'instant': {
				return Temporal.Instant.from(tagged.value);
			}

			case 'duration': {
				const nanoseconds = BigInt(tagged.value);
				return Temporal.Duration.from({seconds: Number(nanoseconds / 1_000_000_000n), nanoseconds: Number(nanoseconds % 1_000_000_000n)});
			}

			default: {
				throw new Error(`Unknown tag ${tagged.type}`);
			}
		}
	}

	const object = {};

	for (const [key, value] of Object.entries(tagged)) {
		Object.defineProperty(object, key, {
			value: untag(value as Tagged),
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}

	return object;
}

function isValidUtf8(bytes: Uint8Array): boolean {
	try {
		new TextDecoder('utf-8', {fatal: true}).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

const validCases = listCases('valid');
const invalidCases = listCases('invalid');

test('the suite is not empty', () => {
	assert.ok(validCases.length > 300);
	assert.ok(invalidCases.length > 300);
});

test('the suite checks out on every file system', () => {
	const names = [...validCases.map(name => `valid/${name}`), ...invalidCases.map(name => `invalid/${name}`)];
	const lowercased = new Set(names.map(name => name.toLowerCase()));
	assert.equal(lowercased.size, names.length, 'Two cases differ only in letter case');

	// Windows reserves these device names, with any extension, so a repository or package that has one cannot be unpacked there.
	const reserved = names.flatMap(name => name.split('/')).filter(segment => /^(?:con|prn|aux|nul|com\d|lpt\d)$/iv.test(segment));
	assert.deepEqual(reserved, []);
});

suite('valid', () => {
	for (const name of validCases) {
		test(name, () => {
			const base = path.join(root, 'valid', name);
			const bytes = fs.readFileSync(`${base}.soml`);
			const expected = untag(JSON.parse(fs.readFileSync(`${base}.json`, 'utf8')) as Tagged);
			const canonical = fs.readFileSync(`${base}.canonical.soml`, 'utf8');
			const formatted = fs.readFileSync(`${base}.formatted.soml`, 'utf8');

			const fromBytes = parse(new Uint8Array(bytes));
			assert.deepEqual(normalize(fromBytes), normalize(expected));

			const fromString = parse(bytes.toString('utf8'));
			assert.deepEqual(normalize(fromString), normalize(expected));

			assert.equal(stringify(fromString, {canonical: true}), canonical);

			// Canonical form is a valid document with the same value, and a fixed point.
			assert.deepEqual(normalize(parse(canonical)), normalize(expected));
			assert.equal(stringify(parse(canonical), {canonical: true}), canonical);

			assert.equal(format(bytes.toString('utf8')), formatted);

			// The formatted form is a valid document with the same value, and a fixed point.
			assert.deepEqual(normalize(parse(formatted)), normalize(expected));
			assert.equal(format(formatted), formatted);
		});
	}
});

/*
A change to a document from `edit/`.
*/
type EditCase = {
	readonly document: string;
	readonly path: Array<string | number>;
	readonly value?: Tagged;
	readonly expected?: string;
	readonly error?: true;
};

const editCases = fs.readdirSync(path.join(root, 'edit')).filter(file => file.endsWith('.json')).map(file => file.slice(0, -'.json'.length)).toSorted();

test('the edit cases are not empty', () => {
	assert.ok(editCases.length > 40);
});

suite('edit', () => {
	for (const name of editCases) {
		test(name, () => {
			const {document, path: keys, value, expected, error} = JSON.parse(fs.readFileSync(path.join(root, 'edit', `${name}.json`), 'utf8')) as EditCase;
			assert.equal(format(document), document, 'The document is not formatted.');
			const change = () => edit(document, keys, value === undefined ? undefined : untag(value));

			if (error === true) {
				assert.throws(change, Error);
				return;
			}

			assert.equal(change(), expected);
			assert.equal(format(expected!), expected, 'The result is not formatted.');
		});
	}
});

suite('invalid', () => {
	for (const name of invalidCases) {
		test(name, () => {
			const bytes = fs.readFileSync(path.join(root, 'invalid', `${name}.soml`));
			assert.throws(() => parse(new Uint8Array(bytes)), ParseError);

			if (isValidUtf8(bytes)) {
				assert.throws(() => parse(bytes.toString('utf8')), ParseError);
			}
		});
	}
});
