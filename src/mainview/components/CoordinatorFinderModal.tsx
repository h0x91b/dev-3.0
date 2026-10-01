import { useEffect, useMemo, useState } from "react";
import type { Project, Task } from "../../shared/types";
import { getTaskTitle, projectDisplayName } from "../../shared/types";
import { useT, type TranslationKey } from "../i18n";
import { api } from "../rpc";
import { useProjectPrivacy } from "../sensitive-projects";
import { type CoordinatorCandidate, type CoordinatorState, coordinatorCandidates } from "../utils/coordinatorFinder";
import { PaletteShell } from "./PaletteShell";

interface CoordinatorFinderModalProps {
	projectById: Map<string, Project>;
	currentTaskId: string | null;
	mru: string[];
	/** Navigate to the coordinator. Never launches or wakes anything. */
	onSelect: (task: Task) => void;
	onClose: () => void;
}

const STATE_KEY: Record<CoordinatorState, TranslationKey | null> = {
	current: "coordinatorFinder.state.current",
	live: null,
	disconnected: "coordinatorFinder.state.disconnected",
	hibernated: "coordinatorFinder.state.hibernated",
};

/**
 * "Find coordinator…" picker, opened from the ⇧⌘P action palette. Lists every
 * active coordinator across all projects on the shared palette shell, so the
 * user can reach one without first finding its project.
 */
function CoordinatorFinderModal({ projectById, currentTaskId, mru, onSelect, onClose }: CoordinatorFinderModalProps) {
	const t = useT();
	const privacy = useProjectPrivacy();
	const [tasks, setTasks] = useState<Task[] | null>(null);

	useEffect(() => {
		let cancelled = false;
		api.request
			.getAllProjectTasks()
			.then((results) => {
				if (!cancelled) setTasks(results.flatMap((r) => r.tasks));
			})
			.catch(() => {
				if (!cancelled) setTasks([]);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const items = useMemo(
		() => coordinatorCandidates(tasks ?? [], currentTaskId, mru).filter((c) => projectById.has(c.task.projectId)),
		[tasks, currentTaskId, mru, projectById],
	);

	const projectName = (c: CoordinatorCandidate) => {
		const project = projectById.get(c.task.projectId);
		return project ? projectDisplayName(project, t("ops.boardName")) : "";
	};

	const noResults = tasks === null
		? t("coordinatorFinder.loading")
		: items.length === 0
			? t("coordinatorFinder.empty")
			: t("coordinatorFinder.noResults");

	return (
		<PaletteShell<CoordinatorCandidate>
			items={items}
			getKey={(c) => c.task.id}
			getText={(c) => getTaskTitle(c.task)}
			getSearchText={(c) => `${getTaskTitle(c.task)} ${projectName(c)} #${c.task.seq}`}
			getTextClassName={(c) => {
				const project = projectById.get(c.task.projectId);
				return project ? privacy.maskClass(project) : "";
			}}
			onSelect={(c) => onSelect(c.task)}
			onClose={onClose}
			placeholder={t("coordinatorFinder.placeholder")}
			ariaLabel={t("coordinatorFinder.title")}
			hint={t("projectSwitch.hint")}
			noResults={noResults}
			testId="coordinator-finder"
			renderItemRight={(c) => {
				const project = projectById.get(c.task.projectId);
				const stateKey = STATE_KEY[c.state];
				return (
					<span className="flex items-center gap-2 flex-shrink-0 min-w-0 max-w-[45%] text-xs">
						{project && privacy.isLocked(project) && (
							<span aria-label={t("streamer.projectLocked")} className="text-fg-muted" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
								{"\u{F033E}"}
							</span>
						)}
						<span className={`text-fg-3 truncate ${project ? privacy.maskClass(project) : ""}`}>
							{projectName(c)} · #{c.task.seq}
						</span>
						{c.task.hidden && <span className="text-fg-muted">{t("coordinatorFinder.state.hidden")}</span>}
						{stateKey && (
							<span
								data-testid={`coordinator-state-${c.state}`}
								className={c.state === "current" ? "text-accent font-medium" : "text-fg-muted"}
							>
								{t(stateKey)}
							</span>
						)}
					</span>
				);
			}}
		/>
	);
}

export default CoordinatorFinderModal;
