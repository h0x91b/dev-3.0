import { confirm } from "../confirm";
import type { CustomColumn, Task } from "../../shared/types";
import type { TFunction } from "../i18n";

/**
 * Ask before deleting a custom column. The message names how many tasks go
 * back to To Do, so the board and Project Settings warn the same way.
 */
export function confirmCustomColumnDelete(column: CustomColumn, tasks: Task[], t: TFunction): Promise<boolean> {
	const parked = tasks.filter((task) => task.customColumnId === column.id).length;
	return confirm({
		title: t("customColumns.deleteConfirmTitle"),
		message: parked > 0
			? t.plural("customColumns.deleteConfirmMessage", parked, { name: column.name })
			: t("customColumns.deleteConfirmMessageEmpty", { name: column.name }),
		confirmLabel: t("customColumns.deleteColumn"),
		danger: true,
	});
}
