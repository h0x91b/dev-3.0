import { useEffect, useMemo, useRef, useState, type Dispatch } from "react";
import { toast } from "../toast";
import type { Project, Space } from "../../shared/types";
import { isBuiltinOpsProject, isSpaceSensitive, orderProjectsForDisplay } from "../../shared/types";
import { HOME_GROUP_ID } from "../utils/spaceGroups";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { confirm } from "../confirm";
import { useT } from "../i18n";
import { trackEvent } from "../analytics";
import { useSpaces } from "../useSpaces";
import { useContainerWidth } from "../hooks/useContainerWidth";
import { deleteSpaceWithConfirm, moveSpace, renameSpace, toggleSpaceSensitive } from "../utils/spaceActions";
import ActivityOverview from "./ActivityOverview";
import SpacesRail, { SPACES_RAIL_MIN_WIDTH } from "./SpacesRail";
import NewSpaceModal from "./NewSpaceModal";
import SpaceProjectsModal from "./SpaceProjectsModal";
import SpaceFilterSheet from "./SpaceFilterSheet";

interface DashboardProps {
	projects: Project[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
	onOpenAddProject: (spaceIds?: string[]) => void;
}

function Dashboard({
	projects,
	dispatch,
	navigate,
	bellCounts,
	onOpenAddProject,
}: DashboardProps) {
	const t = useT();
	const { spaces } = useSpaces();
	const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
	const [showNewSpace, setShowNewSpace] = useState(false);
	const [editSpace, setEditSpace] = useState<Space | null>(null);

	// The rail exists or it does not — one measurement, no CSS breakpoint that
	// could disagree with it. The ref goes on the row holding BOTH panels, whose
	// width does not change when the rail appears; measuring the rail's own
	// sibling would make showing it shrink the number that decides it.
	// Width 0 means "not measured yet", never "narrow" — the window stands in for
	// the one frame before the observer reports.
	const containerRef = useRef<HTMLDivElement>(null);
	const containerWidth = useContainerWidth(containerRef);
	const railHidden = (containerWidth || window.innerWidth) < SPACES_RAIL_MIN_WIDTH;

	// Narrowing the window does NOT drop the filter: the sheet below carries the
	// same choice, so the selection stays reachable and what is on screen keeps
	// matching what the user picked. Only a space that stopped existing clears it
	// — otherwise the dashboard would filter by an id nothing can select again.
	const [showSpaceFilter, setShowSpaceFilter] = useState(false);
	useEffect(() => {
		if (!selectedSpaceId || selectedSpaceId === HOME_GROUP_ID) return;
		if (!spaces.some((s) => s.id === selectedSpaceId)) setSelectedSpaceId(null);
	}, [spaces, selectedSpaceId]);

	// The rail only exists once a space does: with zero spaces the dashboard
	// stays exactly the screen it was.
	const hasSpaces = spaces.length > 0;
	// Where `New space` has to live: the rail owns it, so the overview header
	// only carries a fallback while the rail is not on screen. One expression
	// for both, so the two can never disagree about which is showing.
	const railOnScreen = hasSpaces && projects.length > 0 && !railHidden;

	// No cross-project task fetch here any more: it existed solely to feed the
	// rail's amber/blue dots, and a number whose legend lived in another column
	// is not worth loading every task in every project for.

	const railCounts = useMemo(() => {
		const ordinary = projects.filter((p) => !p.deleted && !isBuiltinOpsProject(p));
		const known = new Set(ordinary.map((p) => p.id));
		const perSpace = new Map<string, number>();
		const associated = new Set<string>();
		for (const space of spaces) {
			const members = space.projectIds.filter((id) => known.has(id));
			perSpace.set(space.id, members.length);
			for (const id of members) associated.add(id);
		}
		return {
			perSpace,
			// `All projects` shows the pinned Operations board too, so its count
			// includes it — and thereby always agrees with the overview heading.
			total: projects.filter((p) => !p.deleted).length,
			home: ordinary.filter((p) => !associated.has(p.id)).length,
		};
	}, [projects, spaces]);

	const maskedSpaceIds = useMemo(() => {
		const sensitive = new Set(projects.filter((p) => p.sensitive).map((p) => p.id));
		return new Set(spaces.filter((s) => isSpaceSensitive(s, sensitive)).map((s) => s.id));
	}, [projects, spaces]);

	async function handleReorderSpaces(order: string[]) {
		try {
			await api.request.reorderSpaces({ order });
		} catch (err) {
			toast.error(t("spaces.failedUpdate", { error: String(err) }), { source: "dashboard" });
		}
	}

	async function handleRemoveProject(projectId: string) {
		const confirmed = await confirm({
			title: t("dashboard.confirmRemoveTitle"),
			message: t("dashboard.confirmRemove"),
			confirmLabel: t("dashboard.confirmRemoveAction"),
			danger: true,
		});
		if (!confirmed) return;
		try {
			await api.request.removeProject({ projectId });
			dispatch({ type: "removeProject", projectId });
			trackEvent("project_removed", { project_id: projectId });
		} catch (err) {
			toast.error(t("dashboard.failedRemove", { error: String(err) }), { projectId });
		}
	}

	async function handleReorderProjects(projectIds: string[]) {
		const previousProjects = projects;
		dispatch({ type: "reorderProjects", projectIds });
		try {
			const reordered = await api.request.reorderProjects({ projectIds });
			// reorderProjects only operates on git projects.json — re-merge virtual
			// boards (Operations) so they are not wiped from state on confirmation.
			const virtuals = previousProjects.filter((p) => p.kind === "virtual");
			dispatch({ type: "setProjects", projects: orderProjectsForDisplay([...reordered, ...virtuals]) });
			trackEvent("projects_reordered", { project_count: projectIds.length });
		} catch (err) {
			dispatch({ type: "setProjects", projects: previousProjects });
			toast.error(t("dashboard.failedReorder", { error: String(err) }), { source: "dashboard" });
		}
	}

	return (
		<div className="h-full w-full flex flex-col">
			<div ref={containerRef} className="flex-1 overflow-hidden flex">
				{railOnScreen && (
					<SpacesRail
						spaces={spaces}
						projectCountOf={(id) => railCounts.perSpace.get(id) ?? 0}
						maskedSpaceIds={maskedSpaceIds}
						totalProjects={railCounts.total}
						homeCount={railCounts.home}
						selectedSpaceId={selectedSpaceId}
						onSelect={setSelectedSpaceId}
						onNewSpace={() => setShowNewSpace(true)}
						onReorder={handleReorderSpaces}
						onRenameSpace={(space, name) => void renameSpace(space, name, t)}
						onDeleteSpace={(space) => void deleteSpaceWithConfirm(space, t)}
						onMoveSpace={(space, delta) => void moveSpace(space, delta, spaces, t)}
						onEditProjects={setEditSpace}
						onToggleSensitive={(space, next) => void toggleSpaceSensitive(space, next, t)}
					/>
				)}
				<div className="flex-1 min-w-0 overflow-hidden">
				{projects.length > 0 ? (
					<ActivityOverview
						projects={projects}
						dispatch={dispatch}
						navigate={navigate}
						bellCounts={bellCounts}
						onRemoveProject={handleRemoveProject}
						onOpenAddProject={onOpenAddProject}
						onReorderProjects={handleReorderProjects}
						selectedSpaceId={selectedSpaceId}
						onNewSpace={railOnScreen ? undefined : () => setShowNewSpace(true)}
						onEditSpaceProjects={setEditSpace}
						spaceFilter={
							hasSpaces && !railOnScreen
								? {
										label:
											selectedSpaceId === null
												? t("spaces.railAllProjects")
												: selectedSpaceId === HOME_GROUP_ID
													? t("spaces.homeGroup")
													: spaces.find((s) => s.id === selectedSpaceId)?.name ?? t("spaces.railAllProjects"),
										masked: !!selectedSpaceId && maskedSpaceIds.has(selectedSpaceId),
										onOpen: () => setShowSpaceFilter(true),
									}
								: undefined
						}
					/>
				) : (
					<div className="h-full overflow-y-auto p-3 md:p-7">
						<div className="flex flex-col items-center justify-center h-full">
							<div className="w-20 h-20 rounded-2xl bg-raised flex items-center justify-center mb-5">
								<svg
									aria-hidden="true"
									focusable="false"
									className="w-10 h-10 text-fg-3"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={1.5}
										d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
									/>
								</svg>
							</div>
							<h2 className="text-fg-2 text-lg font-medium mb-1 text-center text-pretty max-w-xs">
								{t("dashboard.noProjects")}
							</h2>
							<p className="text-fg-3 text-sm mb-5 text-center text-pretty max-w-xs">
								{t("dashboard.noProjectsHint")}
							</p>
							<button
								onClick={() => onOpenAddProject()}
								className="px-5 py-2 bg-accent-fill text-white text-sm font-semibold rounded-xl hover:bg-accent-fill-hover shadow-lg shadow-accent/20 transition-[background-color,transform] active:scale-[0.96]"
							>
								{t("dashboard.addProject")}
							</button>
						</div>
					</div>
				)}
				</div>
				{/* No cross-project task panel here: the project rows below already
				    list every task waiting on the user, so a panel beside them
				    rendered the same rows twice. The panel stays in the project
				    view, where the centre is a board and not a task list. */}
			</div>
			{showSpaceFilter && (
				<SpaceFilterSheet
					spaces={spaces}
					maskedSpaceIds={maskedSpaceIds}
					projectCountOf={(id) => railCounts.perSpace.get(id) ?? 0}
					totalProjects={railCounts.total}
					homeCount={railCounts.home}
					selectedSpaceId={selectedSpaceId}
					onSelect={setSelectedSpaceId}
					onClose={() => setShowSpaceFilter(false)}
				/>
			)}
			{showNewSpace && (
				<NewSpaceModal projects={projects} onClose={() => setShowNewSpace(false)} />
			)}
			{editSpace && (
				<SpaceProjectsModal
					space={editSpace}
					projects={projects}
					onClose={() => setEditSpace(null)}
					onCreateProject={(space) => {
						setEditSpace(null);
						onOpenAddProject([space.id]);
					}}
				/>
			)}
		</div>
	);
}

export default Dashboard;
