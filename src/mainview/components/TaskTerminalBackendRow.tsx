import { useCallback, useEffect, useState, type Dispatch } from "react";
import type { NativeTerminalAvailability, Project, Task, TaskTerminalBackendInfo } from "../../shared/types";
import type { TerminalBackendIdentity } from "../../shared/terminal-backend-identity";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { toast } from "../toast";
import { handleRadioGroupKeys } from "../utils/radioGroupKeys";

/**
 * The rare per-task terminal-backend override, shown inside the Task Detail
 * modal only (never on the board, a toolbar, or the live terminal chrome).
 *
 * It states the effective backend and lets a STOPPED task pick the one its next
 * launch uses. While either backend owns a live session both choices are
 * disabled with the reason spelled out — dev3 never migrates a running terminal,
 * and the backend refuses such a switch anyway.
 */
export default function TaskTerminalBackendRow({
	task,
	project,
	dispatch,
}: {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
}) {
	const t = useT();
	const [info, setInfo] = useState<TaskTerminalBackendInfo | null>(null);
	const [availability, setAvailability] = useState<NativeTerminalAvailability | null>(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		let cancelled = false;
		Promise.all([
			api.request.getTaskTerminalBackend({ taskId: task.id, projectId: project.id }),
			api.request.getNativeTerminalAvailability(),
		])
			.then(([backendInfo, hostAvailability]) => {
				if (cancelled) return;
				setInfo(backendInfo);
				setAvailability(hostAvailability);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [task.id, project.id]);

	const handleSelect = useCallback(
		async (backend: TerminalBackendIdentity) => {
			if (!info || info.backend === backend) return;
			setSaving(true);
			try {
				const updated = await api.request.setTaskTerminalBackend({
					taskId: task.id,
					projectId: project.id,
					backend,
				});
				dispatch({ type: "updateTask", task: updated });
				setInfo({ backend, explicit: true, liveBackend: info.liveBackend });
			} catch (err) {
				toast.error(t("task.terminalBackendFailed", { error: String(err) }), { taskId: task.id });
			} finally {
				setSaving(false);
			}
		},
		[dispatch, info, project.id, t, task.id],
	);

	if (!info) return null;

	const live = info.liveBackend;
	const tmuxSupported = availability?.tmuxSupported !== false;
	const nativeAvailable = availability?.available === true;
	const label = (backend: TerminalBackendIdentity) =>
		backend === "native" ? t("task.terminalBackendNative") : t("task.terminalBackendTmux");

	const reasons: string[] = [];
	if (live) reasons.push(t("task.terminalBackendLive", { backend: label(live) }));
	if (!tmuxSupported) reasons.push(t("task.terminalBackendWindows"));
	if (availability && !nativeAvailable) reasons.push(t("task.terminalBackendNativeUnavailable"));

	const options: TerminalBackendIdentity[] = ["tmux", "native"];
	const selectable = options.filter((option) =>
		live === null && availability !== null && (option === "tmux" ? tmuxSupported : nativeAvailable),
	);

	return (
		<div className="mt-4 space-y-2">
			<span className="text-fg-3 text-xs font-medium uppercase tracking-wider">
				{t("task.terminalBackend")}
			</span>
			<div className="flex items-center gap-2">
				<div
					role="radiogroup"
					aria-label={t("task.terminalBackend")}
					className="inline-flex rounded-lg border border-edge p-0.5"
					onKeyDown={(event) => handleRadioGroupKeys(event, selectable, info.backend, handleSelect)}
				>
					{options.map((option) => {
						const active = info.backend === option;
						const blocked =
							saving ||
							live !== null ||
							(option === "tmux" ? !tmuxSupported : !nativeAvailable) ||
							availability === null;
						return (
							<button
								key={option}
								type="button"
								role="radio"
								aria-checked={active}
								disabled={blocked && !active}
								onClick={() => handleSelect(option)}
								className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
									active ? "bg-accent/15 text-accent" : "text-fg-3 hover:bg-fg/8 hover:text-fg"
								}`}
							>
								{label(option)}
							</button>
						);
					})}
				</div>
				{!info.explicit && (
					<span className="text-fg-muted text-xs">{t("task.terminalBackendDefaultSuffix")}</span>
				)}
			</div>
			<p className="text-fg-muted text-xs">
				{live ? reasons[0] : t("task.terminalBackendHint")}
			</p>
			{!live &&
				reasons.map((reason) => (
					<p key={reason} className="text-warning text-xs">
						{reason}
					</p>
				))}
		</div>
	);
}
