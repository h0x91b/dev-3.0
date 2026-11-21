import ControlMenu, { type ControlMenuEntry } from "../components/ControlMenu";
import { hideControl } from "../hidden-controls";
import type { TaskHeaderItemId } from "../hideable-controls";
import { useT } from "../i18n";
import { isBuiltinItem, type SlotItemMenuRequest } from "../plugins/SlotItems";
import { getTaskHeaderUserLayout, moveItem, saveTaskHeaderLayout, sendToMore, showInBar, swapTaskHeaderItems } from "./layout";
import { getTaskHeaderRegistry, TASK_HEADER_ALWAYS_SHOWN, TASK_HEADER_BUDGET_EXCEPTIONS, TASK_HEADER_MORE_REGIONS } from "./registry";

type Translate = ReturnType<typeof useT>;

/** An item's name for menus; an unregistered id (an extension not loaded) shows as itself. */
export function taskHeaderItemLabel(t: Translate, id: string): string {
	const def = getTaskHeaderRegistry().get(id)?.def;
	return def ? t(def.label) : id;
}

/**
 * The rows of one item's menu (bible §5.10, §5.12). In the bar: move left/right among
 * what is drawn, move to More, use another item of the bar instead, hide. In More: show
 * in the bar (or, an extension item with no room left, take a drawn item's place), hide.
 * An always-shown item only moves.
 */
export function taskHeaderItemMenuEntries(t: Translate, region: string, request: SlotItemMenuRequest, hidden: ReadonlySet<string>): ControlMenuEntry[] {
	const { id, order, drawn, overflow } = request;
	const itemId = id as TaskHeaderItemId;
	const alwaysShown = TASK_HEADER_ALWAYS_SHOWN.has(id);
	const entries: ControlMenuEntry[] = [];
	const swapRow = (candidates: readonly string[], replace: (candidate: string) => void): ControlMenuEntry[] =>
		candidates.length === 0 ? [] : [{
			key: "use-instead",
			label: t("taskHeaderLayout.useInsteadOf"),
			disabled: alwaysShown,
			submenu: candidates.map((candidate) => ({ key: candidate, label: taskHeaderItemLabel(t, candidate), onSelect: () => replace(candidate) })),
		}];

	if (request.placement === "inline") {
		const index = drawn.indexOf(id);
		entries.push(
			{ key: "move-left", label: t("taskHeaderLayout.moveLeft"), disabled: index <= 0, onSelect: () => void saveTaskHeaderLayout(moveItem(getTaskHeaderUserLayout(), region, order, drawn, id, -1)) },
			{ key: "move-right", label: t("taskHeaderLayout.moveRight"), disabled: index < 0 || index >= drawn.length - 1, onSelect: () => void saveTaskHeaderLayout(moveItem(getTaskHeaderUserLayout(), region, order, drawn, id, 1)) },
		);
		if (TASK_HEADER_MORE_REGIONS.has(region)) {
			entries.push({ key: "move-to-more", label: t("taskHeaderLayout.moveToMore"), disabled: alwaysShown, onSelect: () => void saveTaskHeaderLayout(sendToMore(getTaskHeaderUserLayout(), id)) });
		}
		const candidates = [...overflow, ...order.filter((candidate) => hidden.has(candidate) && getTaskHeaderRegistry().get(candidate))];
		entries.push(...swapRow(candidates.filter((candidate) => candidate !== id), (candidate) => void swapTaskHeaderItems(region, order, itemId, candidate as TaskHeaderItemId)));
	} else if (isBuiltinItem(id) || request.room > 0) {
		entries.push({ key: "show-in-bar", label: t("taskHeaderLayout.showInBar"), onSelect: () => void saveTaskHeaderLayout(showInBar(getTaskHeaderUserLayout(), id)) });
	} else {
		// Only an item that spends the budget frees room for the extension when it goes.
		const replaceable = drawn.filter((candidate) => !TASK_HEADER_ALWAYS_SHOWN.has(candidate) && !TASK_HEADER_BUDGET_EXCEPTIONS.has(candidate));
		entries.push(...swapRow(replaceable, (candidate) => void swapTaskHeaderItems(region, order, candidate as TaskHeaderItemId, itemId)));
	}
	entries.push({ key: "hide", label: t("hideableControls.hide"), separated: entries.length > 0, disabled: alwaysShown, onSelect: () => void hideControl(itemId) });
	return entries;
}

export function TaskHeaderItemMenu({ region, request, hidden, onClose }: {
	region: string;
	request: SlotItemMenuRequest;
	hidden: ReadonlySet<string>;
	onClose: () => void;
}) {
	const t = useT();
	return (
		<ControlMenu
			pos={request.at}
			label={taskHeaderItemLabel(t, request.id)}
			entries={taskHeaderItemMenuEntries(t, region, request, hidden)}
			onClose={onClose}
		/>
	);
}
