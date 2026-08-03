import type { Task } from "../../shared/types";
import { decodeTerminalBackend } from "../../shared/terminal-backend-identity";
import { useT } from "../i18n";
import Tooltip from "./Tooltip";

/**
 * The one native-terminal-backend marker, shared by every surface that shows a
 * task's identity (Kanban card, Active Tasks row, Task View breadcrumb).
 *
 * It states the task's PERSISTED backend identity and nothing else — not that a
 * terminal is running, connected, healthy, or focused. Legacy records (no
 * field) and explicit tmux render nothing, so the dense surfaces stay quiet.
 */

/** True only for a task whose record explicitly carries the `native` identity. */
export function isNativeBackendTask(task: Pick<Task, "terminalBackend">): boolean {
	const decoded = decodeTerminalBackend(task);
	return decoded.ok && decoded.present && decoded.backend === "native";
}

/** Bolt in a rounded frame — "launched straight, without tmux in between". Same
 *  stroke style as the header/task icon sets. */
function NativeBackendIcon({ className }: { className?: string }) {
	return (
		<svg
			className={`flex-shrink-0 ${className}`}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.9}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden
		>
			<rect x="3.5" y="3.5" width="17" height="17" rx="4" />
			<path d="M13.2 7.2 9.4 12.6h2.9l-1.5 4.2 3.8-5.4h-2.9z" />
		</svg>
	);
}

export default function NativeBackendMark({
	task,
	className = "w-3 h-3",
	testId = "native-backend-mark",
}: {
	task: Pick<Task, "terminalBackend">;
	/** Sizing/spacing for the glyph; each surface passes its own scale. */
	className?: string;
	testId?: string;
}) {
	const t = useT();
	if (!isNativeBackendTask(task)) return null;
	const label = t("task.nativeBackendMark");
	return (
		<Tooltip content={label} detail={t("ttip.task.nativeBackendMark")}>
			<span
				role="img"
				aria-label={label}
				data-testid={testId}
				className="inline-flex flex-shrink-0 items-center align-middle text-accent"
			>
				<NativeBackendIcon className={className} />
			</span>
		</Tooltip>
	);
}
