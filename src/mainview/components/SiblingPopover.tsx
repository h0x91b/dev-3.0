import { useState, useEffect, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import type { CodingAgent, Task } from "../../shared/types";
import { ACTIVE_STATUSES, STATUS_COLORS } from "../../shared/types";
import type { Route } from "../state";
import { useT, statusKey } from "../i18n";

interface SiblingPopoverProps {
	siblings: Task[];
	agents: CodingAgent[];
	navigate: (route: Route) => void;
	onClose: () => void;
	anchorEl: HTMLElement;
	projectId: string;
}

function SiblingPopover({ siblings, agents, navigate, onClose, anchorEl, projectId }: SiblingPopoverProps) {
	const t = useT();
	const popoverRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ top: 0, left: 0 });
	const [visible, setVisible] = useState(false);

	// Position relative to anchor, clamped to viewport
	useLayoutEffect(() => {
		if (!popoverRef.current) return;
		const anchor = anchorEl.getBoundingClientRect();
		const pop = popoverRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;

		let top = anchor.bottom + 4;
		let left = anchor.left;

		if (top + pop.height > vh - pad) {
			top = anchor.top - pop.height - 4;
		}
		if (left + pop.width > vw - pad) {
			left = vw - pop.width - pad;
		}
		if (left < pad) left = pad;
		if (top < pad) top = pad;

		setPos({ top, left });
		setVisible(true);
	}, [anchorEl]);

	// Close on click outside or Escape
	useEffect(() => {
		function handleClick(e: MouseEvent) {
			if (
				popoverRef.current &&
				!popoverRef.current.contains(e.target as Node) &&
				!anchorEl.contains(e.target as Node)
			) {
				onClose();
			}
		}
		function handleKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		document.addEventListener("mousedown", handleClick);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("mousedown", handleClick);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [anchorEl, onClose]);

	function handleSiblingClick(sibling: Task) {
		if (ACTIVE_STATUSES.includes(sibling.status)) {
			navigate({
				screen: "project",
				projectId,
				activeTaskId: sibling.id,
			});
		}
		onClose();
	}

	return createPortal(
		<div
			ref={popoverRef}
			className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active overflow-hidden"
			style={{
				top: pos.top,
				left: pos.left,
				width: 240,
				visibility: visible ? "visible" : "hidden",
			}}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="px-3 py-2 text-xs text-fg-3 uppercase tracking-wider font-semibold border-b border-edge/50">
				{t("task.siblings")}
			</div>
			<div className="max-h-48 overflow-y-auto py-1">
				{siblings.map((sibling) => {
					const agent = sibling.agentId ? agents.find((a) => a.id === sibling.agentId) : null;
					const config = agent && sibling.configId
						? agent.configurations.find((c) => c.id === sibling.configId)
						: agent?.configurations.find((c) => c.id === agent.defaultConfigId) ?? agent?.configurations[0];
					const isClickable = ACTIVE_STATUSES.includes(sibling.status);

					return (
						<button
							key={sibling.id}
							type="button"
							onClick={() => handleSiblingClick(sibling)}
							className={`w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors ${
								isClickable ? "hover:bg-elevated-hover cursor-pointer" : "opacity-60 cursor-default"
							}`}
						>
							<span
								className="w-2.5 h-2.5 rounded-full flex-shrink-0"
								style={{ background: STATUS_COLORS[sibling.status] }}
							/>
							<div className="flex-1 min-w-0">
								<div className="text-xs text-fg truncate">
									{t("task.attempt", { n: String(sibling.variantIndex) })}
									{agent ? ` · ${agent.name}` : ""}
									{config?.name ? ` (${config.name})` : ""}
								</div>
								<div className="text-[0.625rem] text-fg-muted truncate">
									{t(statusKey(sibling.status))}
								</div>
							</div>
						</button>
					);
				})}
			</div>
		</div>,
		document.body,
	);
}

export default SiblingPopover;
