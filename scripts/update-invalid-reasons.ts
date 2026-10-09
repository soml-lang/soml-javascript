/*
Rewrites `invalid-reasons.json` of the conformance suite from the current parser, and prints every reason that changed, so the change can be reviewed before it is kept. The suite is in the `soml` repository, which must be checked out next to this one. Copy the suite here again afterwards with `../soml/sync-conformance.sh test/conformance`.

	node scripts/update-invalid-reasons.ts
*/
import fs from 'node:fs';
import path from 'node:path';
import {parse, type ParseError} from '../source/index.ts';

type Reason = {reason: string; line: number; column: number};

const suite = path.join(import.meta.dirname, '..', '..', 'soml', 'conformance');
const root = path.join(suite, 'invalid');
const fixture = path.join(suite, 'invalid-reasons.json');
const previous = JSON.parse(fs.readFileSync(fixture, 'utf8')) as Record<string, Reason>;
const reasons: Record<string, Reason> = {};

for (const file of fs.readdirSync(root, {recursive: true, encoding: 'utf8'}).filter(file => file.endsWith('.soml')).toSorted()) {
	const name = file.slice(0, -'.soml'.length);

	const bytes = new Uint8Array(fs.readFileSync(path.join(root, file)));

	try {
		parse(bytes);
		console.log(`Accepted, but it is in the invalid folder: ${name}`);
	} catch (error) {
		const {reason, line, column} = error as ParseError;
		reasons[name] = {reason, line, column};
	}
}

for (const [name, value] of Object.entries(reasons)) {
	const was = previous[name];

	if (JSON.stringify(was) !== JSON.stringify(value)) {
		console.log(`${name}: ${value.line}:${value.column} ${value.reason}${was ? `\n\twas: ${was.reason}` : ' (new)'}`);
	}
}

for (const name of Object.keys(previous)) {
	if (!Object.hasOwn(reasons, name)) {
		console.log(`Removed: ${name}`);
	}
}

fs.writeFileSync(fixture, `${JSON.stringify(reasons, undefined, '\t')}\n`);
