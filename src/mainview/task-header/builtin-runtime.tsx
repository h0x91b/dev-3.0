import type { ComponentType } from "react";
import { ACTIVE_STATUSES, isSharedClip, taskSharedMedia } from "../../shared/types";
import { useIsControlHidden } from "../hooks/useIsControlHidden";
import { useT } from "../i18n";
import HideableControl from "../components/HideableControl";
import { ArtifactsIcon, ImagesIcon } from "../components/TaskIcons";
import TaskArtifacts from "../components/task-info-panel/TaskArtifacts";
import TaskDevServer from "../components/task-info-panel/TaskDevServer";
import TaskExposedPorts from "../components/task-info-panel/TaskExposedPorts";
import TaskFileExplorerToggle from "../components/task-info-panel/TaskFileExplorerToggle";
import TaskOpenIn from "../components/task-info-panel/TaskOpenIn";
import TaskScripts from "../components/task-info-panel/TaskScripts";
import TaskSharedImages from "../components/task-info-panel/TaskSharedImages";
import type { SlotItemProps } from "../plugins/SlotItems";
import type { TaskHeaderItem, TaskHeaderScope } from "./registry";
import { useTaskHeaderInternals, useTaskHeaderScope, useTaskHeaderSurface, type TaskHeaderLayout, type TaskHeaderSurface } from "./scope";
import { SHEET_ROW_CLASS } from "./sheet-row";

interface RuntimeView extends TaskHeaderScope {
	layout: TaskHeaderLayout;
	surface: TaskHeaderSurface;
	closeSheet: () => void;
}

function useRuntimeView(): RuntimeView {
	const scope = useTaskHeaderScope();
	const { layout, closeSheet } = useTaskHeaderInternals();
	return { ...scope, layout, closeSheet, surface: useTaskHeaderSurface() };
}

/** The desktop runtime bar; the narrow summary bar carries no runtime controls. */
function useOnDesktopBar(): RuntimeView | null {
	const view = useRuntimeView();
	return view.surface === "bar" && !view.layout.narrow ? view : null;
}

function isActive(scope: TaskHeaderScope): boolean {
	return ACTIVE_STATUSES.includes(scope.task.status);
}

function OpenInItem() {
	const scope = useOnDesktopBar();
	if (!scope) return null;
	return <TaskOpenIn task={scope.task} isTaskActive={isActive(scope)} compact={scope.layout.tight} />;
}

/** Only while collapsed, as the bar has always done. */
function FileExplorerItem() {
	const scope = useOnDesktopBar();
	if (!scope?.layout.collapsed) return null;
	return <TaskFileExplorerToggle task={scope.task} isTaskActive={isActive(scope)} />;
}

function ScriptsItem() {
	const scope = useOnDesktopBar();
	const hidden = useIsControlHidden("scripts-runner");
	if (!scope || hidden) return null;
	return (
		<HideableControl id="scripts-runner">
			<TaskScripts task={scope.task} project={scope.project} isTaskActive={isActive(scope)} />
		</HideableControl>
	);
}

function DevServerItem() {
	const scope = useOnDesktopBar();
	if (!scope) return null;
	return <TaskDevServer task={scope.task} project={scope.project} isTaskActive={isActive(scope)} compact={scope.layout.tight} />;
}

function PortsItem() {
	const scope = useRuntimeView();
	const { surface } = scope;
	if (surface === "sheet") return <TaskExposedPorts task={scope.task} rowClassName={SHEET_ROW_CLASS} />;
	if (scope.layout.narrow) return null;
	return <TaskExposedPorts task={scope.task} compact={scope.layout.tight} />;
}

function ImagesItem() {
	const t = useT();
	const scope = useRuntimeView();
	const { surface } = scope;
	const { task, project } = scope;
	if (surface === "bar") {
		return scope.layout.narrow ? null : <TaskSharedImages task={task} projectId={project.id} compact={scope.layout.tight} />;
	}
	const media = taskSharedMedia(task);
	if (media.length === 0) return null;
	return (
		<button
			type="button"
			onClick={() => {
				scope.closeSheet();
				window.dispatchEvent(new CustomEvent("dev3:openImageViewer", {
					detail: { taskId: task.id, projectId: project.id, images: media },
				}));
			}}
			className={SHEET_ROW_CLASS}
		>
			<ImagesIcon className="h-5 w-5 shrink-0 text-fg-3" />
			<span className="flex-1 text-sm font-medium">{t(media.some(isSharedClip) ? "infoPanel.mediaLabel" : "infoPanel.imagesLabel")}</span>
			<span className="text-xs font-semibold text-accent tabular-nums">{media.length}</span>
		</button>
	);
}

function ArtifactsItem() {
	const t = useT();
	const scope = useRuntimeView();
	const { surface } = scope;
	const { task, project } = scope;
	if (surface === "bar") {
		return scope.layout.narrow ? null : <TaskArtifacts task={task} projectId={project.id} compact={scope.layout.tight} />;
	}
	const count = (task.sharedArtifacts?.length ?? 0) + (task.liveArtifact ? 1 : 0);
	if (count === 0) return null;
	return (
		<button
			type="button"
			onClick={() => {
				scope.closeSheet();
				window.dispatchEvent(new CustomEvent("dev3:openArtifactViewer", {
					detail: { taskId: task.id, taskStatus: task.status, projectId: project.id, artifacts: task.sharedArtifacts ?? [], index: count - 1, live: task.liveArtifact },
				}));
			}}
			className={SHEET_ROW_CLASS}
		>
			<ArtifactsIcon className="h-5 w-5 shrink-0 text-fg-3" />
			<span className="flex-1 text-sm font-medium">{t("infoPanel.artifactsLabel")}</span>
			<span className="text-xs font-semibold text-accent tabular-nums">{count}</span>
		</button>
	);
}

const notVirtual = (scope: TaskHeaderScope) => scope.project.kind !== "virtual";

function item(id: string, component: ComponentType<SlotItemProps>, when?: TaskHeaderItem["when"]): TaskHeaderItem {
	return { id: `builtin:runtime.${id}`, region: "runtime", component, when };
}

/** The runtime bar, left to right; registration order is display order. */
export const RUNTIME_ITEMS: readonly TaskHeaderItem[] = [
	item("open-in", OpenInItem),
	item("file-explorer", FileExplorerItem),
	item("scripts", ScriptsItem, notVirtual),
	item("dev-server", DevServerItem, notVirtual),
	item("ports", PortsItem),
	item("images", ImagesItem),
	item("artifacts", ArtifactsItem),
];
