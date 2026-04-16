import { api } from "../rpc";

async function fileToBase64(file: File): Promise<string> {
	const buffer = await file.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	const chunks: string[] = [];
	const CHUNK_SIZE = 0x8000;

	for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
		chunks.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE)));
	}

	return btoa(chunks.join(""));
}

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

export async function uploadDroppedFile(projectId: string, file: File): Promise<string | null> {
	if (!projectId) {
		return null;
	}

	if (file.size > MAX_FILE_SIZE) {
		throw new Error(`File too large (max 100 MB)`);
	}

	const base64 = await fileToBase64(file);
	const uploaded = await api.request.uploadFileBase64({
		projectId,
		base64,
		filename: file.name,
		mimeType: file.type || undefined,
	});

	return uploaded?.path ?? null;
}
