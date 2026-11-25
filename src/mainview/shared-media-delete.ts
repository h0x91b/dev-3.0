import { useEffect, useMemo, useState } from "react";
import type { SharedImage, Task } from "../shared/types";
import { olderLargeSharedClips } from "../shared/types";
import { confirm } from "./confirm";
import type { TFunction } from "./i18n";
import { api } from "./rpc";
import { toast } from "./toast";
import { formatBytes } from "./utils/formatBytes";

/** Below this a clip deletion frees "almost nothing" and the copy says so. */
const MEANINGFUL_BYTES = 1024 * 1024;

/** Tasks with a delete in flight, shared by every surface (viewer, Media section) so a repeat click is ignored. */
const inFlight = new Set<string>();

/**
 * Confirm, then delete stored clip files. The dialog states the honest disk gain
 * from a server dry run (a clone of a live original frees ~0). Returns the updated
 * task, or null when cancelled or failed — failures surface as a toast.
 */
export async function confirmDeleteSharedMedia(opts: {
	projectId: string;
	taskId: string;
	items: SharedImage[];
	t: TFunction;
	/** `older` = the bulk "older large clips" sweep; `one` = a single clip from the viewer. */
	scope: "one" | "older";
}): Promise<Task | null> {
	const { projectId, taskId, items, t, scope } = opts;
	if (items.length === 0 || inFlight.has(taskId)) return null;
	inFlight.add(taskId);
	const mediaIds = items.map((item) => item.id);
	const skipRefused = scope === "older";
	try {
		const plan = await api.request.previewSharedMediaDelete({ projectId, taskId, mediaIds, skipRefused });
		if (plan.count === 0) {
			toast.error(t("sharedMedia.deleteFailed", { error: plan.skipped[0]?.reason ?? "" }), { taskId });
			return null;
		}
		const size = formatBytes(plan.bytes);
		const freed = formatBytes(plan.freeableBytes);
		const sharedBytes = plan.bytes - plan.freeableBytes;
		const gain = plan.freeableBytes < MEANINGFUL_BYTES
			? [t("sharedMedia.confirmFreesNothing", { size })]
			: [t("sharedMedia.confirmMessage", { size, freed }), sharedBytes > MEANINGFUL_BYTES ? t("sharedMedia.confirmSharedNote") : null];
		const message = [...gain, t("sharedMedia.confirmKeepsEntry")].filter(Boolean).join(" ");
		const ok = await confirm({
			title: scope === "one" ? t("sharedMedia.confirmOneTitle", { name: items[0].name }) : t.plural("sharedMedia.confirmOlderTitle", plan.count),
			message,
			confirmLabel: t("sharedMedia.confirmButton"),
			danger: true,
		});
		if (!ok) return null;
		const { task, summary } = await api.request.deleteSharedMedia({ projectId, taskId, mediaIds, skipRefused });
		if (summary.failed.length > 0) {
			toast.error(t("sharedMedia.deleteFailed", { error: summary.failed[0].reason }), { taskId });
		}
		if (summary.count > 0) toast.success(t("sharedMedia.deleted", { freed: formatBytes(summary.freeableBytes) }), { taskId });
		return task;
	} catch (err) {
		toast.error(t("sharedMedia.deleteFailed", { error: err instanceof Error ? err.message : String(err) }), { taskId });
		return null;
	} finally {
		inFlight.delete(taskId);
	}
}

/**
 * The "delete older clips" sweep for one task: which clips it covers, a label
 * carrying the disk it really frees (server preview, refreshed when the window
 * regains focus since an original may have been deleted meanwhile), and a run.
 */
export function useOlderClipsCleanup(opts: { projectId?: string; taskId?: string; media: SharedImage[]; t: TFunction }) {
	const { projectId, taskId, media, t } = opts;
	const older = useMemo(() => olderLargeSharedClips(media), [media]);
	const key = older.map((item) => item.id).join(",");
	const [freeable, setFreeable] = useState<number | null>(null);
	const [refresh, setRefresh] = useState(0);
	useEffect(() => {
		const bump = () => setRefresh((n) => n + 1);
		window.addEventListener("focus", bump);
		return () => window.removeEventListener("focus", bump);
	}, []);
	useEffect(() => {
		if (!projectId || !taskId || !key) {
			setFreeable(null);
			return;
		}
		let live = true;
		api.request.previewSharedMediaDelete({ projectId, taskId, mediaIds: key.split(","), skipRefused: true })
			.then((summary) => { if (live) setFreeable(summary.freeableBytes); })
			.catch(() => { if (live) setFreeable(null); });
		return () => { live = false; };
	}, [projectId, taskId, key, refresh]);
	const run = async (): Promise<Task | null> => {
		if (!projectId || !taskId) return null;
		return confirmDeleteSharedMedia({ projectId, taskId, items: older, t, scope: "older" });
	};
	const label = freeable !== null && freeable >= MEANINGFUL_BYTES ? t("sharedMedia.freeOlder", { size: formatBytes(freeable) }) : t("sharedMedia.deleteOlder");
	return { older, label, run, available: Boolean(projectId && taskId) && older.length > 0 };
}
