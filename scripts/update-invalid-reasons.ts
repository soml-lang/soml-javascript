/*
Rewrites `invalid-reasons.json` of the conformance suite from the current parser, and prints every reason that changed, so the change can be reviewed before it is kept. The suite is in the `soml` repository, which must be checked out next to this one. Copy the suite here again afterwards with `../soml/sync-conformance.sh test/conformance`.

	node scripts/update-invalid-reasons.ts
*/
import fs from 'node:fs';
import path from 'node:path';
import {parse, ParseError} from '../source/index.ts';
import {describeText} from '../source/shared.ts';

type Reason = {reason: string; line: number; column: number};

const suite = path.join(import.meta.dirname, '..', '..', 'soml', 'conformance');
const root = path.join(suite, 'invalid');
const fixture = path.join(suite, 'invalid-reasons.json');
const previous = JSON.parse(fs.readFileSync(fixture, 'utf8')) as Record<string, Reason>;
const reasons = Object.create(null) as Record<string, Reason>;

// eslint-disable-next-line unicorn/no-array-sort -- The filtered array belongs to this updater; sorting it avoids another copy.
for (const file of fs.readdirSync(root, {recursive: true, encoding: 'utf8'}).filter(file => file.endsWith('.soml')).sort()) {
	const name = file.slice(0, -'.soml'.length);

	const bytes = fs.readFileSync(path.join(root, file));

	try {
		parse(bytes);
		console.log(`Accepted, but it is in the invalid folder: ${describeText(name)}`);
	} catch (error) {
		if (!(error instanceof ParseError)) {
			throw error;
		}

		const {reason, line, column} = error;
		reasons[name] = {reason, line, column};
	}
}

for (const [name, value] of Object.entries(reasons)) {
	const was = Object.hasOwn(previous, name) ? previous[name] : undefined;

	if (was?.line !== value.line || was.column !== value.column || was.reason !== value.reason) {
		console.log(`${describeText(name)}: ${value.line}:${value.column} ${describeText(value.reason)}${was ? `\n\twas: ${describeText(was.reason)}` : ' (new)'}`);
	}
}

for (const name of Object.keys(previous)) {
	if (!Object.hasOwn(reasons, name)) {
		console.log(`Removed: ${describeText(name)}`);
	}
}

fs.writeFileSync(fixture, `${JSON.stringify(reasons, undefined, '\t')}\n`);
