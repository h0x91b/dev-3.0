import { uploadDroppedFile } from "./uploadDroppedFile";

// Text pastes larger than this (in UTF-8 bytes) are saved to a .txt file in the
// worktree uploads dir instead of being dumped raw into the task / terminal.
export const LARGE_TEXT_PASTE_THRESHOLD = 4096;

export function textByteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

export function isLargeTextPaste(text: string): boolean {
	return textByteLength(text) > LARGE_TEXT_PASTE_THRESHOLD;
}

export async function uploadPastedText(projectId: string, text: string): Promise<string | null> {
	const file = new File([text], "pasted-text.txt", { type: "text/plain" });
	return uploadDroppedFile(projectId, file);
}
