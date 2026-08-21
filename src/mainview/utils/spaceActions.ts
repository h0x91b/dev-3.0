import type { Space } from "../../shared/types";
import { api } from "../rpc";
import { confirm } from "../confirm";
import { toast } from "../toast";
import type { TranslationKey } from "../i18n";

type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/**
 * The writes behind a space's own menu. Two surfaces carry that menu now — the
 * rail row and the dashboard group header — so the writes live here instead of
 * in whichever component happened to get them first.
 */

export async function renameSpace(space: Space, name: string, t: T) {
	try {
		await api.request.renameSpace({ spaceId: space.id, name });
	} catch (err) {
		toast.error(t("spaces.failedRename", { error: String(err) }));
	}
}

/** Unlinks the space's projects and nothing else — never removes a project. */
export async function deleteSpaceWithConfirm(space: Space, t: T) {
	const confirmed = await confirm({
		title: t("spaces.deleteConfirmTitle"),
		message: t("spaces.deleteConfirmBody", { name: space.name }),
		confirmLabel: t("spaces.deleteConfirmAction"),
		danger: true,
	});
	if (!confirmed) return;
	try {
		await api.request.deleteSpace({ spaceId: space.id });
		toast.info(t("spaces.deleted", { name: space.name }));
	} catch (err) {
		toast.error(t("spaces.failedDelete", { error: String(err) }));
	}
}

/** Step one space by one position. The rail drags; this is the path for a
 *  pointer that cannot drag and for the keyboard. */
export async function moveSpace(space: Space, delta: -1 | 1, spaces: Space[], t: T) {
	const order = spaces.map((s) => s.id);
	const from = order.indexOf(space.id);
	const to = from + delta;
	if (from === -1 || to < 0 || to >= order.length) return;
	[order[from], order[to]] = [order[to], order[from]];
	try {
		await api.request.reorderSpaces({ order });
	} catch (err) {
		toast.error(t("spaces.failedUpdate", { error: String(err) }));
	}
}
