import { useT } from "../../i18n";
import { restoreControl } from "../../hidden-controls";
import { EyeIcon } from "../TaskIcons";
import { barLabelKey, useHiddenHeaderItems } from "./PanelRestoreControl";

/**
 * The touch path to the restore control (bible §5.10, §12.6): the narrow actions sheet
 * lists every item hidden from the desktop header, one 44 px row each; a tap brings it back.
 * Absent when nothing is hidden.
 */
export default function HiddenHeaderItemsSheetSection({ rowClassName }: { rowClassName: string }) {
	const t = useT();
	const groups = useHiddenHeaderItems();
	if (groups.length === 0) return null;
	return (
		<section className="border-t border-edge pt-4" data-testid="task-actions-hidden-items">
			<h3 className="mb-2 text-dense font-semibold uppercase tracking-wider text-fg-muted">{t("taskHeaderLayout.hiddenSection")}</h3>
			<div className="touch-actions flex flex-col gap-2">
				{groups.flatMap(([bar, rows]) => rows.map((row) => {
					const label = t(row.label);
					return (
						<button
							key={row.id}
							type="button"
							onClick={() => void restoreControl(row.id)}
							aria-label={t("infoPanel.restoreOne", { name: label })}
							className={rowClassName}
						>
							<EyeIcon className="h-5 w-5 shrink-0 text-fg-3" />
							<span className="flex-1 text-sm font-medium">{label}</span>
							<span className="text-xs text-fg-muted">{t(barLabelKey(bar))}</span>
						</button>
					);
				}))}
			</div>
		</section>
	);
}
