import { createPortal } from "react-dom";
import { useState, type Dispatch, type ReactNode } from "react";
import type { Project, Task } from "../../shared/types";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { toast } from "../toast";
import { confirm } from "../confirm";
import { formatBytes } from "../utils/formatBytes";
import SpawnAgentModal from "../components/SpawnAgentModal";
import ScheduleMessageModal from "../components/ScheduleMessageModal";
import BugHuntersLightbox from "../components/BugHuntersLightbox";

/** One per mounted header: the items, the sheet rows and the restore control act on it. */
export interface TaskSessionController {
	openSpawnAgent: () => void;
	openBugHunters: () => void;
	openScheduleMessage: () => void;
	/** Asks first: killing the session is the one part hibernation cannot undo. */
	hibernate: () => Promise<void>;
	hibernating: boolean;
	/** The open dialog, if any; the header renders it once. */
	dialogs: ReactNode;
}

interface SessionControllerOptions {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
}

export function useTaskSessionController({ task, project, dispatch }: SessionControllerOptions): TaskSessionController {
	const t = useT();
	const [spawnModalOpen, setSpawnModalOpen] = useState(false);
	const [scheduleMsgOpen, setScheduleMsgOpen] = useState(false);
	const [bugHuntersOpen, setBugHuntersOpen] = useState(false);
	const [hibernating, setHibernating] = useState(false);

	async function hibernate() {
		// Extra agent panes come back only through "Wake and resume agent"; a
		// plain-shell wake starts none of them, so the dialog counts them.
		const paneCount = task.sessionState?.panes?.length ?? 0;
		const confirmed = await confirm({
			title: t("task.hibernateConfirmTitle"),
			message: paneCount > 1
				? `${t("task.hibernateConfirmBody")}\n\n${t("task.hibernateConfirmMulti", { count: String(paneCount) })}`
				: t("task.hibernateConfirmBody"),
			confirmLabel: t("task.hibernateConfirmCta"),
			danger: true,
			info: { title: task.title },
		});
		if (!confirmed) return;
		setHibernating(true);
		try {
			const { task: updated, freedRssBytes } = await api.request.hibernateTask({ taskId: task.id, projectId: project.id });
			dispatch({ type: "updateTask", task: updated });
			// "about": the reading comes from the resource monitor's last poll, which
			// can be up to one poll interval older than the kill.
			toast.success(freedRssBytes
				? t("task.hibernatedToastMem", { mem: formatBytes(freedRssBytes) })
				: t("task.hibernatedToast"), { taskId: task.id });
		} catch (err) {
			toast.error(t("task.hibernateFailed", { error: String(err) }), { taskId: task.id });
		} finally {
			setHibernating(false);
		}
	}

	const dialogs = (
		<>
			{spawnModalOpen && createPortal(
				<SpawnAgentModal task={task} project={project} onClose={() => setSpawnModalOpen(false)} />,
				document.body,
			)}
			{bugHuntersOpen && createPortal(
				<BugHuntersLightbox task={task} project={project} onClose={() => setBugHuntersOpen(false)} />,
				document.body,
			)}
			{scheduleMsgOpen && createPortal(
				<ScheduleMessageModal task={task} project={project} dispatch={dispatch} onClose={() => setScheduleMsgOpen(false)} />,
				document.body,
			)}
		</>
	);

	return {
		openSpawnAgent: () => setSpawnModalOpen(true),
		openBugHunters: () => setBugHuntersOpen(true),
		openScheduleMessage: () => setScheduleMsgOpen(true),
		hibernate,
		hibernating,
		dialogs,
	};
}
