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

export async function uploadDroppedImage(projectId: string, file: File): Promise<string | null> {
	if (!projectId || !file.type.startsWith("image/")) {
		return null;
	}

	const base64 = await fileToBase64(file);
	const uploaded = await api.request.uploadImageBase64({
		projectId,
		base64,
		filename: file.name,
		mimeType: file.type || undefined,
	});

	return uploaded?.path ?? null;
}
