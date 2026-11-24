import type { SharedImage, Task } from "../shared/types";
import { confirm } from "./confirm";
import type { TFunction } from "./i18n";
import { api } from "./rpc";
import { toast } from "./toast";
import { formatBytes } from "./utils/formatBytes";

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
	if (items.length === 0) return null;
	const mediaIds = items.map((item) => item.id);
	try {
		const { summary: plan } = await api.request.deleteSharedMedia({ projectId, taskId, mediaIds, dryRun: true });
		const size = formatBytes(plan.bytes);
		const freed = formatBytes(plan.freeableBytes);
		const shared = plan.bytes - plan.freeableBytes > 1024 * 1024;
		const message = [t("sharedMedia.confirmMessage", { size, freed }), shared ? t("sharedMedia.confirmSharedNote") : null, t("sharedMedia.confirmKeepsEntry")]
			.filter(Boolean)
			.join(" ");
		const ok = await confirm({
			title: scope === "one" ? t("sharedMedia.confirmOneTitle", { name: items[0].name }) : t.plural("sharedMedia.confirmOlderTitle", plan.count),
			message,
			confirmLabel: t("sharedMedia.confirmButton"),
			danger: true,
		});
		if (!ok) return null;
		const { task, summary } = await api.request.deleteSharedMedia({ projectId, taskId, mediaIds });
		if (summary.failed.length > 0) {
			toast.error(t("sharedMedia.deleteFailed", { error: summary.failed[0].reason }), { taskId });
		}
		if (summary.count > 0) toast.success(t("sharedMedia.deleted", { freed: formatBytes(summary.freeableBytes) }), { taskId });
		return task;
	} catch (err) {
		toast.error(t("sharedMedia.deleteFailed", { error: err instanceof Error ? err.message : String(err) }), { taskId });
		return null;
	}
}
