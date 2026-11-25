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

/** Tasks with a delete in flight, shared by every surface (viewer, Media section, Library) so a repeat click is ignored. */
const inFlight = new Set<string>();

export interface SharedMediaDeleteGroup {
	projectId: string;
	taskId: string;
	items: SharedImage[];
}

/** "a.mp4, b.mp4, c.mp4 +2": enough to recognise the clips without a wall of names. */
function clipNames(items: readonly SharedImage[]): string {
	const head = items.slice(0, 3).map((item) => item.name).join(", ");
	return items.length > 3 ? `${head} +${items.length - 3}` : head;
}

/** Splits a group by a summary's refused ids: the clips the server takes, and the ones it leaves. */
function splitRefused(items: SharedImage[], refused: readonly { id: string }[]): { accepted: SharedImage[]; refused: SharedImage[] } {
	const ids = new Set(refused.map((entry) => entry.id));
	return { accepted: items.filter((item) => !ids.has(item.id)), refused: items.filter((item) => ids.has(item.id)) };
}

/**
 * Confirm, then delete stored clip files, one server call per task (the delete resolves ids
 * against one task's records). Calls run with `skipRefused`, so one clip that cannot go (shared,
 * already gone) never blocks the rest: the dialog names the skipped clips and states the honest
 * disk gain from the read-only preview (a clone of a live original frees ~0). Returns the tasks
 * the server updated; failures surface as a toast naming the clips.
 */
export async function confirmDeleteSharedMediaGroups(opts: {
	groups: SharedMediaDeleteGroup[];
	t: TFunction;
	/** `one` = a single clip; `older` = the "older large clips" sweep; `many` = a picked selection. */
	scope: "one" | "older" | "many";
}): Promise<{ projectId: string; task: Task }[]> {
	const { t, scope } = opts;
	const groups = opts.groups.filter((group) => group.items.length > 0);
	if (groups.length === 0 || groups.some((group) => inFlight.has(group.taskId))) return [];
	for (const group of groups) inFlight.add(group.taskId);
	const toastOpts = groups.length === 1 ? { taskId: groups[0].taskId } : undefined;
	try {
		const plans = await Promise.all(groups.map(async (group) => {
			const summary = await api.request.previewSharedMediaDelete({ projectId: group.projectId, taskId: group.taskId, mediaIds: group.items.map((item) => item.id), skipRefused: true });
			return { group, summary, ...splitRefused(group.items, summary.skipped) };
		}));
		const refused = plans.flatMap((plan) => plan.refused);
		const accepted = plans.filter((plan) => plan.accepted.length > 0);
		if (accepted.length === 0) {
			toast.error(t.plural("sharedMedia.cannotDelete", refused.length, { names: clipNames(refused) }), toastOpts);
			return [];
		}
		const bytes = accepted.reduce((sum, plan) => sum + plan.summary.bytes, 0);
		const freeable = accepted.reduce((sum, plan) => sum + plan.summary.freeableBytes, 0);
		const count = accepted.reduce((sum, plan) => sum + plan.accepted.length, 0);
		const size = formatBytes(bytes);
		const gain = freeable < MEANINGFUL_BYTES
			? [t("sharedMedia.confirmFreesNothing", { size })]
			: [t("sharedMedia.confirmMessage", { size, freed: formatBytes(freeable) }), bytes - freeable > MEANINGFUL_BYTES ? t("sharedMedia.confirmSharedNote") : null];
		const skips = refused.length > 0 ? t.plural("sharedMedia.confirmSkips", refused.length, { names: clipNames(refused) }) : null;
		const message = [...gain, skips, t("sharedMedia.confirmKeepsEntry")].filter(Boolean).join(" ");
		const title = scope === "one"
			? t("sharedMedia.confirmOneTitle", { name: accepted[0].accepted[0].name })
			: t.plural(scope === "older" ? "sharedMedia.confirmOlderTitle" : "sharedMedia.confirmManyTitle", count);
		const ok = await confirm({ title, message, confirmLabel: t("sharedMedia.confirmButton"), danger: true });
		if (!ok) return [];
		const updated: { projectId: string; task: Task }[] = [];
		const failed: SharedImage[] = [];
		let deleted = 0;
		let freed = 0;
		for (const { group, accepted: items } of accepted) {
			try {
				const { task, summary } = await api.request.deleteSharedMedia({ projectId: group.projectId, taskId: group.taskId, mediaIds: items.map((item) => item.id), skipRefused: true });
				updated.push({ projectId: group.projectId, task });
				deleted += summary.count;
				freed += summary.freeableBytes;
				failed.push(...splitRefused(items, [...summary.failed, ...summary.skipped]).refused);
			} catch {
				failed.push(...items);
			}
		}
		if (failed.length > 0) toast.error(t.plural("sharedMedia.cannotDelete", failed.length, { names: clipNames(failed) }), toastOpts);
		if (deleted > 0) toast.success(t("sharedMedia.deleted", { freed: formatBytes(freed) }), toastOpts);
		return updated;
	} catch (err) {
		toast.error(t("sharedMedia.deleteFailed", { error: err instanceof Error ? err.message : String(err) }), toastOpts);
		return [];
	} finally {
		for (const group of groups) inFlight.delete(group.taskId);
	}
}

/** {@link confirmDeleteSharedMediaGroups} for one task's clips: the updated task, or null. */
export async function confirmDeleteSharedMedia(opts: {
	projectId: string;
	taskId: string;
	items: SharedImage[];
	t: TFunction;
	scope: "one" | "older";
}): Promise<Task | null> {
	const [result] = await confirmDeleteSharedMediaGroups({ groups: [{ projectId: opts.projectId, taskId: opts.taskId, items: opts.items }], t: opts.t, scope: opts.scope });
	return result?.task ?? null;
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
