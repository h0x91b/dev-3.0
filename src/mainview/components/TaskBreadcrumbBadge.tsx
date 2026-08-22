import { useRef, useState } from "react";
import type { CodingAgent, Task } from "../../shared/types";
import { taskSeqLabel } from "../../shared/types";
import type { Route } from "../state";
import { useT } from "../i18n";
import { getAliveVariants } from "../utils/variantGroups";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import { DropdownIcon } from "./HeaderIcons";
import SiblingPopover from "./SiblingPopover";
import Tooltip from "./Tooltip";

interface TaskBreadcrumbBadgeProps {
	task: Task;
	/** Every task of this task's variant group, current one included. */
	groupMembers: Task[];
	agents: CodingAgent[];
	/** True on the fullscreen task screen, so switching stays on that screen. */
	isFullPage: boolean;
	navigate: (route: Route) => void;
	/** Lets the header close its other dropdowns before this menu opens. */
	onOpen?: () => void;
}

/**
 * The `#1636-1` breadcrumb badge. With live siblings it becomes a segmented
 * control — badge half plus a chevron opening the shared variant menu — using
 * the same grammar as the project breadcrumb beside it.
 */
function TaskBreadcrumbBadge({ task, groupMembers, agents, isFullPage, navigate, onOpen }: TaskBreadcrumbBadgeProps) {
	const t = useT();
	const anchorRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	// The phone header has room for the breadcrumb and one kebab; the chevron would
	// slide under it. It sheds there because the context bar's own variant control
	// (VariantSwitcher) is the touch path on narrow.
	const isNarrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const badge = `#${taskSeqLabel(task)}`;
	// Gated on live siblings, exactly like the ⇧⌘[ / ⇧⌘] cycling this mirrors:
	// a chevron that can only show a dead group is a dead control.
	const switchable = !isNarrow && getAliveVariants(groupMembers).length >= 2;

	if (!switchable) {
		return <span className="font-mono text-micro text-accent/70 flex-shrink-0 tracking-wide">{badge}</span>;
	}

	return (
		<span className="flex items-stretch flex-shrink-0 rounded-md border border-edge bg-raised overflow-hidden self-center">
			<span className="font-mono text-micro text-accent/70 px-1.5 py-[3px] tracking-wide">{badge}</span>
			<span className="w-px self-stretch bg-edge flex-shrink-0" aria-hidden="true" />
			<Tooltip content={t("header.switchVariant")} detail={t("ttip.header.switchVariant")}>
				<button
					ref={anchorRef}
					type="button"
					onClick={() => {
						if (!open) onOpen?.();
						setOpen((v) => !v);
					}}
					aria-haspopup="menu"
					aria-expanded={open}
					aria-label={t("header.switchVariant")}
					data-testid="variant-breadcrumb-toggle"
					className={`header-anim px-1 py-[3px] flex items-center transition-colors ${
						open ? "text-fg bg-elevated" : "text-fg-3 hover:text-fg hover:bg-elevated"
					}`}
				>
					<span className={`inline-block transition-transform ${open ? "rotate-180" : ""}`}>
						<DropdownIcon className="w-3 h-3 block" />
					</span>
				</button>
			</Tooltip>
			{open && anchorRef.current && (
				<SiblingPopover
					variants={groupMembers}
					currentTaskId={task.id}
					agents={agents}
					navigate={navigate}
					onClose={() => setOpen(false)}
					anchorEl={anchorRef.current}
					projectId={task.projectId}
					isFullPage={isFullPage}
				/>
			)}
		</span>
	);
}

export default TaskBreadcrumbBadge;
