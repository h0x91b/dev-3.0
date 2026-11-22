import type { MouseEvent } from "react";
import type { Project } from "../../shared/types";
import type { Route } from "../state";
import { useT } from "../i18n";
import { runMenuItem, type MenuRow } from "../plugins/menu-rows";
import { resolveProjectActions, type ProjectActionEntries, type ProjectActionItem, type ProjectActionScope } from "../project-actions/registry";

interface ProjectActionButtonsProps {
	project: Project;
	/** The slot's items, read once by the dashboard so a row adds no subscription of its own. */
	entries: ProjectActionEntries;
	navigate: (route: Route) => void;
	onRemove?: (projectId: string) => void | Promise<void>;
	/** Opens the space-membership picker anchored to the button. Omitted where
	 *  spaces are not part of the surface (e.g. zero spaces exist). */
	onOpenSpaces?: (project: Project, anchor: HTMLElement) => void;
	className?: string;
}

/** The dashboard row's resting icon cluster: the `row` items of the `projectActions` slot. */
function ProjectActionButtons({
	project,
	entries,
	navigate,
	onRemove,
	onOpenSpaces,
	className = "",
}: ProjectActionButtonsProps) {
	const t = useT();
	const scope: ProjectActionScope = {
		project,
		placement: "row",
		t,
		navigate,
		openSpaces: onOpenSpaces ? (anchor) => onOpenSpaces(project, anchor) : undefined,
		removeProject: onRemove ? () => onRemove(project.id) : undefined,
		anchor: null,
	};
	// Extension actions never rest on the row: a future overflow owns them (decisions/2026/11/22/project-actions-slot.md).
	const { actions, danger } = resolveProjectActions(entries, scope);

	// Hover raises emphasis, it never *creates* the control: the cluster rests at
	// `text-fg-3` — same tone as the reorder buttons at the other end of the row,
	// and the quietest step that still clears 3:1 on the light theme's surface.
	const iconButton =
		"text-fg-3 transition-colors p-2 rounded-lg focus-visible:outline-none focus-visible:text-fg focus-visible:ring-2 focus-visible:ring-accent";
	const neutralButton = `${iconButton} hover:text-fg hover:bg-elevated`;

	function button(row: MenuRow<ProjectActionItem>, className: string) {
		const { item } = row;
		return (
			<button
				key={row.key}
				type="button"
				onClick={(event: MouseEvent<HTMLButtonElement>) => {
					event.stopPropagation();
					runMenuItem("projectActions", item.id, item.run, { ...scope, anchor: event.currentTarget });
				}}
				className={className}
				title={row.label}
				aria-label={row.label}
				data-testid={item.testIdPrefix ? `${item.testIdPrefix}-${project.id}` : undefined}
			>
				<span
					aria-hidden="true"
					className="text-base leading-none"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{item.glyph}
				</span>
			</button>
		);
	}

	return (
		<div className={`flex items-center gap-0.5 ${className}`.trim()}>
			{actions.map((row) => button(row, neutralButton))}
			{danger.map((row) => button(row, `${iconButton} ml-2 hover:text-danger hover:bg-danger/10`))}
		</div>
	);
}

export default ProjectActionButtons;
