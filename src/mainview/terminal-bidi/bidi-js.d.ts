// bidi-js ships no type declarations. This mirrors the subset of its API we use;
// `bidi-engine-contract.test.ts` pins the runtime behaviour these types describe.
declare module "bidi-js" {
	export interface BidiEmbeddingLevels {
		levels: Uint8Array;
		paragraphs: { start: number; end: number; level: number }[];
	}

	export interface BidiApi {
		getEmbeddingLevels(
			text: string,
			direction?: "ltr" | "rtl" | "auto",
		): BidiEmbeddingLevels;
		getReorderSegments(
			text: string,
			embeddingLevels: BidiEmbeddingLevels,
			start?: number,
			end?: number,
		): [number, number][];
		getReorderedIndices(
			text: string,
			embeddingLevels: BidiEmbeddingLevels,
			start?: number,
			end?: number,
		): number[];
		getReorderedString(text: string, embeddingLevels: BidiEmbeddingLevels): string;
		getMirroredCharactersMap(
			text: string,
			levels: Uint8Array,
			start?: number,
			end?: number,
		): Map<number, string>;
		getMirroredCharacter(char: string): string | null;
		getBidiCharTypeName(char: string): string;
	}

	export default function bidiFactory(): BidiApi;
}
