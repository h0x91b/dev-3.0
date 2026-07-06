import { useT } from "../i18n";

/** Dashboard render mode: the project-grouped list, or the unified cross-project board. */
export type DashboardView = "projects" | "board";

export const LS_DASHBOARD_VIEW = "dev3-dashboard-view";

export function readDashboardView(): DashboardView {
	try {
		return localStorage.getItem(LS_DASHBOARD_VIEW) === "board" ? "board" : "projects";
	} catch {
		return "projects";
	}
}

export function writeDashboardView(view: DashboardView) {
	try {
		localStorage.setItem(LS_DASHBOARD_VIEW, view);
	} catch {
		/* ignore */
	}
}

/**
 * Segmented control that flips the Dashboard between the project-grouped list
 * ("By Project") and the unified cross-project Kanban ("Board"). A view-mode
 * control, not a navigation destination — it stays on the `dashboard` screen
 * (see UX_DECISIONS 2026-07-06).
 */
function DashboardViewToggle({
	view,
	onViewChange,
}: {
	view: DashboardView;
	onViewChange: (view: DashboardView) => void;
}) {
	const t = useT();
	const options: { id: DashboardView; label: string; glyph: string; testId: string }[] = [
		// Nerd Font: fa-list (U+F03A) / fa-columns (U+F0DB)
		{ id: "projects", label: t("dashboard.viewByProject"), glyph: "", testId: "dashboard-view-projects" },
		{ id: "board", label: t("dashboard.viewBoard"), glyph: "", testId: "dashboard-view-board" },
	];
	return (
		<div
			role="group"
			aria-label={t("dashboard.viewToggleLabel")}
			className="inline-flex items-center rounded-lg border border-edge bg-raised p-0.5 flex-shrink-0"
		>
			{options.map((opt) => {
				const active = view === opt.id;
				return (
					<button
						key={opt.id}
						type="button"
						onClick={() => onViewChange(opt.id)}
						aria-pressed={active}
						title={opt.label}
						data-testid={opt.testId}
						className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-2 md:py-1 min-h-[40px] md:min-h-0 text-xs font-medium transition-colors ${
							active ? "bg-accent/15 text-accent" : "text-fg-3 hover:text-fg hover:bg-raised-hover"
						}`}
					>
						<span
							className="text-sm leading-none"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							aria-hidden
						>
							{opt.glyph}
						</span>
						<span className="hidden sm:inline">{opt.label}</span>
					</button>
				);
			})}
		</div>
	);
}

export default DashboardViewToggle;
