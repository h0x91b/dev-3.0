/**
 * The opaque identity of one capture producer, and the ONE canonical form every
 * consumer must use. A path segment built from unvalidated input is a directory
 * traversal, and two code paths hashing different normalizations of the same
 * producer write to a path neither will ever read.
 */

import { createHash } from "node:crypto";

/** Bound on the strings that enter the identity. */
export const CAPTURE_SIGNATURE_MAX = 128;

/** A validated full-length hex digest, constructed only through this module. */
export type CaptureProducerDigest = string & { readonly __captureDigest: unique symbol };

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface CaptureProducer {
	hostPid: number;
	hostStartSignature: string;
	shellPid: number;
	shellStartSignature: string;
}

export class InvalidProducerDigestError extends Error {
	constructor(readonly received: string) {
		super(`capture producer digest ${JSON.stringify(received)} is not 64 lowercase hex characters`);
		this.name = "InvalidProducerDigestError";
	}
}

/** Validate a digest that came from outside — a path, an argument, a record. */
export function asProducerDigest(value: string): CaptureProducerDigest {
	if (!DIGEST_PATTERN.test(value)) throw new InvalidProducerDigestError(value);
	return value as CaptureProducerDigest;
}

/** A producer whose identity inputs are outside the accepted bounds. */
export class InvalidProducerError extends Error {
	constructor(reason: string) {
		super(`capture producer identity is unusable: ${reason}`);
		this.name = "InvalidProducerError";
	}
}

/**
 * The single canonical producer. Over-limit inputs are REJECTED, never truncated:
 * truncating loses information before hashing, so two distinct signatures sharing a
 * prefix would deliberately collide and no digest width could repair it.
 */
export function canonicalProducer(producer: CaptureProducer): CaptureProducer {
	for (const [field, value] of [
		["hostStartSignature", producer.hostStartSignature],
		["shellStartSignature", producer.shellStartSignature],
	] as const) {
		if (typeof value !== "string") throw new InvalidProducerError(`${field} is not a string`);
		if (value.length > CAPTURE_SIGNATURE_MAX) {
			throw new InvalidProducerError(`${field} is ${value.length} characters, over ${CAPTURE_SIGNATURE_MAX}`);
		}
	}
	for (const [field, value] of [
		["hostPid", producer.hostPid],
		["shellPid", producer.shellPid],
	] as const) {
		if (!Number.isInteger(value) || value < 1) throw new InvalidProducerError(`${field} is not a live pid`);
	}
	return {
		hostPid: producer.hostPid,
		hostStartSignature: producer.hostStartSignature,
		shellPid: producer.shellPid,
		shellStartSignature: producer.shellStartSignature,
	};
}

/**
 * The canonical BYTES of a producer identity: a JSON array, which is injective for
 * any string content. A delimiter-joined tuple is not — an embedded delimiter lets
 * two different tuples encode identically, whatever the hash width.
 */
export function canonicalProducerBytes(producer: CaptureProducer): string {
	const canonical = canonicalProducer(producer);
	return JSON.stringify([
		canonical.hostPid,
		canonical.hostStartSignature,
		canonical.shellPid,
		canonical.shellStartSignature,
	]);
}

/** Full SHA-256 over the injective encoding. */
export function captureProducerDigest(producer: CaptureProducer): CaptureProducerDigest {
	return createHash("sha256").update(canonicalProducerBytes(producer)).digest("hex") as CaptureProducerDigest;
}
