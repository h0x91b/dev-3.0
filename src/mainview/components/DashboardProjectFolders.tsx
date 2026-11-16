import { useState } from "react";
import type { Project, ProjectFolder } from "../../shared/types";
import type { Route } from "../state";
import { useT } from "../i18n";
import { folderSourceLabel, requestRevealFolder, useDashboardFoldersOpen, useProjectFolders } from "../project-folders";
import Tooltip from "./Tooltip";

/** Rows shown before "Show N more": a card stays one glance tall however many folders a project has. */
const FOLDER_ROW_CAP = 3;

function FolderIcon({ className = "" }: { className?: string }) {
	return (
		<svg aria-hidden="true" focusable="false" className={className} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
		</svg>
	);
}

/** The collapsed `+N folders` pill in a project row header; absent while the project has none. */
export function ProjectFoldersToggle({ project }: { project: Project }) {
	const t = useT();
	const folders = useProjectFolders(project.kind === "virtual" ? null : project.id);
	const [open, toggle] = useDashboardFoldersOpen(project.id);
	if (folders.length === 0) return null;
	return (
		<button
			type="button"
			onClick={toggle}
			aria-expanded={open}
			data-testid={`project-folders-toggle-${project.id}`}
			className="inline-flex items-center gap-1 h-6 px-1.5 rounded-md text-micro text-fg-3 hover:text-fg hover:bg-elevated transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
		>
			<FolderIcon />
			<span className="tabular-nums whitespace-nowrap">{t.plural("dashboard.extraFolders", folders.length)}</span>
			<svg aria-hidden="true" focusable="false" className={`transition-transform ${open ? "rotate-180" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
				<polyline points="6 9 12 15 18 9" />
			</svg>
		</button>
	);
}

function sourceLabel(folder: ProjectFolder, t: ReturnType<typeof useT>): string {
	if (!folder.exists) return t("fileExplorer.folderMissing");
	return folderSourceLabel(folder, t);
}

/** The expanded list under a row header: one slim line per folder, a click opens it in the Repo file explorer. */
export function ProjectFoldersRows({ project, navigate }: { project: Project; navigate: (route: Route) => void }) {
	const t = useT();
	const [open] = useDashboardFoldersOpen(project.id);
	const folders = useProjectFolders(project.kind === "virtual" ? null : project.id, { withBranch: true, enabled: open });
	const [showAll, setShowAll] = useState(false);
	if (!open || folders.length === 0) return null;
	const visible = showAll ? folders : folders.slice(0, FOLDER_ROW_CAP);
	const more = folders.length - visible.length;
	return (
		<div className="border-t border-edge py-1" data-testid={`project-folders-${project.id}`}>
			{visible.map((folder) => (
				<Tooltip
					key={folder.path}
					content={folder.name}
					detail={
						<span className="block font-mono break-all streamer-private">
							{folder.path}
							<span className="block font-sans text-fg-3 not-italic">
								{[folder.branch, sourceLabel(folder, t)].filter(Boolean).join(" · ")}
							</span>
						</span>
					}
					wide
				>
					<button
						type="button"
						disabled={!folder.exists}
						onClick={() => {
							requestRevealFolder(project.id, folder.path);
							navigate({ screen: "project-terminal", projectId: project.id });
						}}
						className="group/folder w-full flex items-center gap-2 pl-[3.25rem] md:pl-[5.75rem] pr-3 md:pr-5 py-1 text-left hover:bg-raised-hover disabled:cursor-default disabled:opacity-60 transition-colors"
					>
						<FolderIcon className="text-accent flex-shrink-0" />
						<span className="text-xs text-fg-2 group-hover/folder:text-accent flex-shrink-0 max-w-[40%] truncate">{folder.name}</span>
						<span className="min-w-0 flex-1 truncate font-mono text-dense text-fg-muted streamer-private">{folder.displayPath}</span>
					</button>
				</Tooltip>
			))}
			{more > 0 && (
				<button
					type="button"
					onClick={() => setShowAll(true)}
					className="pl-[3.25rem] md:pl-[5.75rem] py-1 text-micro text-fg-3 hover:text-accent transition-colors"
				>
					{t.plural("dashboard.moreFolders", more)}
				</button>
			)}
		</div>
	);
}
