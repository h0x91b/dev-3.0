import bidiFactory, { type BidiApi } from "bidi-js";

/**
 * The slice of bidi-js the reorder layer depends on. Tests inject a recording
 * implementation through this seam instead of mocking the node_module.
 */
export type BidiEngine = Pick<
	BidiApi,
	| "getEmbeddingLevels"
	| "getReorderSegments"
	| "getReorderedIndices"
	| "getMirroredCharactersMap"
	| "getBidiCharTypeName"
>;

let cached: BidiEngine | null = null;

/** bidi-js parses its Unicode tables on first use, so the instance is shared. */
export function defaultBidiEngine(): BidiEngine {
	if (!cached) cached = bidiFactory();
	return cached;
}
