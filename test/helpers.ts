import type {Document, ObjectValue, Value} from '../source/index.ts';

/*
Makes a parsed value comparable with `assert.deepEqual`, which sees no own properties on a `Temporal.Instant` or a `Temporal.Duration` and would call any two of them equal. A duration becomes its exact length in nanoseconds, so `PT90M` and `PT1H30M` are equal.
*/
export function normalize(value: unknown): unknown {
	if (value instanceof Temporal.Instant) {
		return {instant: value.toString()};
	}

	if (value instanceof Temporal.Duration) {
		return {duration: durationNanoseconds(value)};
	}

	if (Array.isArray(value)) {
		return value.map(item => normalize(item));
	}

	if (value !== null && typeof value === 'object') {
		const object: Record<string, unknown> = {};

		for (const [key, member] of Object.entries(value)) {
			Object.defineProperty(object, key, {
				value: normalize(member),
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}

		return object;
	}

	return value;
}

export function durationNanoseconds(duration: Temporal.Duration): bigint {
	return (BigInt(duration.hours) * 3_600_000_000_000n) + (BigInt(duration.minutes) * 60_000_000_000n) + (BigInt(duration.seconds) * 1_000_000_000n) + (BigInt(duration.milliseconds) * 1_000_000n) + (BigInt(duration.microseconds) * 1000n) + BigInt(duration.nanoseconds);
}

/*
A seeded pseudo-random number generator (mulberry32), so a failing property test can be reproduced from its seed.
*/
export type Random = {
	next: () => number;
	integer: (minimum: number, maximum: number) => number;
	pick: <Item>(items: readonly Item[]) => Item;
	boolean: () => boolean;
};

/* eslint-disable no-bitwise -- mulberry32 is defined with 32-bit integer operations. */
export function createRandom(seed: number): Random {
	let state = seed >>> 0;

	const next = () => {
		state = (state + 0x6D_2B_79_F5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};

	return {
		next,
		integer: (minimum: number, maximum: number) => minimum + Math.floor(next() * (maximum - minimum + 1)),
		pick: <Item>(items: readonly Item[]) => items[Math.floor(next() * items.length)]!,
		boolean: () => next() < 0.5,
	};
}
/* eslint-enable no-bitwise */

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = (2n ** 63n) - 1n;
const MIN_NANOSECONDS = Temporal.Instant.from('0001-01-01T00:00:00Z').epochNanoseconds;
const MAX_NANOSECONDS = Temporal.Instant.from('9999-12-31T23:59:59.999999999Z').epochNanoseconds;

/*
Characters chosen to hit every branch of string and key serialization.
*/
const INTERESTING_CHARACTERS = [
	'a',
	'Z',
	'0',
	'_',
	'-',
	'.',
	' ',
	'\'',
	'"',
	'\\',
	'\n',
	'\t',
	'\u{0}',
	'\u{1}',
	'\u{1F}',
	'\u{7F}',
	'\u{80}',
	'\u{A0}',
	'é',
	'\u{2028}',
	'\u{D7FF}',
	'\u{E000}',
	'\u{FEFF}',
	'\u{FFFD}',
	'\u{FFFF}',
	'😀',
	'\u{10000}',
	'\u{10FFFF}',
	'#',
	'/*',
	'*/',
	'/-',
	'\'\'\'',
	'"""',
	':',
	',',
	'{',
	']',
];

export function randomString(random: Random, maximumLength = 12): string {
	const length = random.integer(0, maximumLength);
	let string = '';

	for (let index = 0; index < length; index++) {
		string += random.next() < 0.7 ? random.pick(INTERESTING_CHARACTERS) : String.fromCodePoint(randomScalar(random));
	}

	return string;
}

/*
Any Unicode scalar value except U+000D, which is not representable.
*/
function randomScalar(random: Random): number {
	for (;;) {
		const codePoint = random.next() < 0.5 ? random.integer(0, 0x7F) : random.integer(0, 0x10_FF_FF);

		if (codePoint !== 0x0D && (codePoint < 0xD8_00 || codePoint > 0xDF_FF)) {
			return codePoint;
		}
	}
}

export function randomKey(random: Random): string {
	if (random.next() < 0.6) {
		const characters = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'];
		return Array.from({length: random.integer(1, 8)}, () => random.pick(characters)).join('');
	}

	// A quoted key may hold any string a value may, including a line break.
	return randomString(random, 6);
}

export function randomInteger(random: Random): bigint {
	switch (random.integer(0, 3)) {
		case 0: {
			return BigInt(random.integer(-1000, 1000));
		}

		case 1: {
			return random.pick([INT64_MIN, INT64_MAX, 0n, -1n, 2n ** 53n, (2n ** 53n) + 1n, -(2n ** 53n) - 1n]);
		}

		default: {
			// A uniformly random 64-bit pattern, read as signed.
			const high = BigInt(random.integer(0, 0xFF_FF_FF_FF));
			const low = BigInt(random.integer(0, 0xFF_FF_FF_FF));
			return BigInt.asIntN(64, (high * (2n ** 32n)) + low);
		}
	}
}

export function randomFloat(random: Random): number {
	switch (random.integer(0, 4)) {
		case 0: {
			return random.pick([0, 1, -1, 0.1, 0.5, 1.5, 1e21, 1e-7, 1e20, 1e-6, Number.MAX_VALUE, Number.MIN_VALUE, -Number.MAX_VALUE, Number.EPSILON, Infinity, -Infinity, 2 ** 53, Math.PI]);
		}

		case 1: {
			return random.integer(-1_000_000, 1_000_000) / random.pick([1, 10, 100, 1000, 3, 7]);
		}

		default: {
			// A uniformly random bit pattern, so every exponent and every subnormal is reachable.
			const view = new DataView(new ArrayBuffer(8));
			view.setUint32(0, random.integer(0, 0xFF_FF_FF_FF));
			view.setUint32(4, random.integer(0, 0xFF_FF_FF_FF));
			const value = view.getFloat64(0);
			return Number.isNaN(value) || Object.is(value, -0) ? 0 : value;
		}
	}
}

export function randomInstant(random: Random): Temporal.Instant {
	const span = MAX_NANOSECONDS - MIN_NANOSECONDS;
	const fraction = BigInt(random.integer(0, 0xFF_FF_FF_FF)) * BigInt(random.integer(0, 0xFF_FF_FF_FF));
	let nanoseconds = MIN_NANOSECONDS + (fraction % (span + 1n));

	// Round some to whole seconds or milliseconds, so the fraction-trimming paths are hit.
	if (random.boolean()) {
		nanoseconds -= nanoseconds % random.pick([1_000_000_000n, 1_000_000n, 1000n]);

		if (nanoseconds < MIN_NANOSECONDS) {
			nanoseconds = MIN_NANOSECONDS;
		}
	}

	return new Temporal.Instant(nanoseconds);
}

export function randomDuration(random: Random): Temporal.Duration {
	// A random bit length first, so that short durations, including zero, are as likely as long ones.
	const magnitude = (BigInt(random.integer(0, 0xFF_FF_FF_FF)) * BigInt(random.integer(0, 0xFF_FF_FF_FF))) % (2n ** BigInt(random.integer(0, 63)));
	// Round some to a whole unit, so that the paths that leave out zero parts are hit.
	const nanoseconds = magnitude - (random.boolean() ? magnitude % random.pick([3_600_000_000_000n, 60_000_000_000n, 1_000_000_000n, 1_000_000n]) : 0n);
	// Unbalanced fields sometimes, so that every field is summed.
	const duration = random.boolean()
		? Temporal.Duration.from({seconds: Number(nanoseconds / 1_000_000_000n), nanoseconds: Number(nanoseconds % 1_000_000_000n)})
		: Temporal.Duration.from({
			minutes: Number(nanoseconds / 60_000_000_000n),
			milliseconds: Number((nanoseconds % 60_000_000_000n) / 1_000_000n),
			microseconds: Number((nanoseconds % 1_000_000n) / 1000n),
			nanoseconds: Number(nanoseconds % 1000n),
		});
	return random.boolean() ? duration.negated() : duration;
}

export function randomValue(random: Random, depth: number): Value {
	const kind = random.integer(0, depth > 4 ? 6 : 8);

	switch (kind) {
		case 0: {
			return randomString(random);
		}

		case 1: {
			return randomInteger(random);
		}

		case 2: {
			return randomFloat(random);
		}

		case 3: {
			return random.boolean();
		}

		case 4: {
			return null;
		}

		case 5:
		case 6: {
			return random.pick([randomInstant, randomDuration, randomString])(random, 3);
		}

		case 7: {
			return Array.from({length: random.integer(0, 4)}, () => randomValue(random, depth + 1));
		}

		default: {
			return randomObject(random, depth + 1);
		}
	}
}

function randomObject(random: Random, depth: number): ObjectValue {
	const object: ObjectValue = {};

	for (let index = random.integer(0, 5); index > 0; index--) {
		Object.defineProperty(object, randomKey(random), {
			value: randomValue(random, depth),
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}

	return object;
}

export function randomDocument(random: Random): Document {
	return random.next() < 0.75 ? randomObject(random, 1) : Array.from({length: random.integer(0, 5)}, () => randomValue(random, 2));
}
