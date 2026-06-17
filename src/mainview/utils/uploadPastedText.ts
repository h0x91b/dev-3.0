import { uploadDroppedFile } from "./uploadDroppedFile";

// Text pastes longer than this (in characters / Unicode code points) are saved
// to a .txt file in the worktree uploads dir instead of being dumped raw into
// the task / terminal. Counting characters (not UTF-8 bytes) keeps the limit
// language-independent — the same paste size triggers it in English and Cyrillic.
export const LARGE_TEXT_PASTE_THRESHOLD = 8192;

export function textCharLength(text: string): number {
	return [...text].length;
}

export function isLargeTextPaste(text: string): boolean {
	return textCharLength(text) > LARGE_TEXT_PASTE_THRESHOLD;
}

export async function uploadPastedText(projectId: string, text: string): Promise<string | null> {
	const file = new File([text], "pasted-text.txt", { type: "text/plain" });
	return uploadDroppedFile(projectId, file);
}
