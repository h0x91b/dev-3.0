import type { Task } from "../../shared/types";
import { useT } from "../i18n";
import Tooltip from "./Tooltip";

/**
 * The one marker for a task about code the user did not write — a pull request,
 * a colleague's branch. Shared by every surface that shows a task's identity, in
 * the same spirit as NativeBackendMark: it states whose code this is and nothing
 * else. Never that the task is read-only, blocked, or unsafe to touch.
 *
 * Accent-toned on purpose. This is an identity, not a fault: the loud warning
 * belongs on the diff of an executable config file, where the user must read the
 * commands. Painting review tasks amber on the board would spend the warning
 * token on the happy path.
 */

/** Eye in a soft frame — "this task is here to look at someone else's work". */
function ForeignCodeIcon({ className }: { className?: string }) {
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
			<path d="M2.6 12S6.2 5.9 12 5.9 21.4 12 21.4 12 17.8 18.1 12 18.1 2.6 12 2.6 12Z" />
			<circle cx="12" cy="12" r="2.9" />
		</svg>
	);
}

export default function ForeignCodeMark({
	task,
	className = "w-3 h-3",
	testId = "foreign-code-mark",
}: {
	task: Pick<Task, "foreignCode">;
	/** Sizing/spacing for the glyph; each surface passes its own scale. */
	className?: string;
	testId?: string;
}) {
	const t = useT();
	if (!task.foreignCode) return null;
	const label = t("task.foreignCodeMark");
	return (
		<Tooltip content={label} detail={t("ttip.task.foreignCodeMark")}>
			<span
				role="img"
				aria-label={label}
				data-testid={testId}
				className="inline-flex flex-shrink-0 items-center align-middle text-accent"
			>
				<ForeignCodeIcon className={className} />
			</span>
		</Tooltip>
	);
}
