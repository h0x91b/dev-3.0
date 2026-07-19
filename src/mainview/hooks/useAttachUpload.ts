import { useCallback, useState } from "react";
import { uploadDroppedFile } from "../utils/uploadDroppedFile";
import { toast } from "../toast";
import { useT } from "../i18n";

/**
 * Upload picked/pasted files into the project's worktree uploads dir
 * (`uploadFileBase64` RPC). Failed uploads surface an error toast and are
 * dropped from the result. Returns raw absolute paths — callers that inject
 * into a shell/PTY line must escape spaces themselves.
 */
export function useAttachUpload(
	projectId: string | undefined,
	taskId?: string,
): { uploading: boolean; attach: (files: File[]) => Promise<string[]> } {
	const t = useT();
	const [uploading, setUploading] = useState(false);

	const attach = useCallback(
		async (files: File[]): Promise<string[]> => {
			if (!projectId || files.length === 0) return [];
			setUploading(true);
			try {
				const paths = await Promise.all(
					files.map(async (f) => {
						try {
							return await uploadDroppedFile(projectId, f);
						} catch (err) {
							toast.error(
								t("fileDrop.uploadFailed", { error: String(err instanceof Error ? err.message : err) }),
								{ taskId },
							);
							return null;
						}
					}),
				);
				return paths.filter((p): p is string => Boolean(p));
			} finally {
				setUploading(false);
			}
		},
		[projectId, taskId, t],
	);

	return { uploading, attach };
}
