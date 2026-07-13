import { useState, useEffect, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import type { CodingAgent, Task } from "../../shared/types";
import { ACTIVE_STATUSES, getTaskTitle } from "../../shared/types";
import { useStatusColors } from "../hooks/useStatusColors";
import type { Route } from "../state";
import { useT, statusKey } from "../i18n";
import { sortVariants } from "../utils/variantGroups";

interface SiblingPopoverProps {
	variants: Task[];
	currentTaskId: string;
	agents: CodingAgent[];
	navigate: (route: Route) => void;
	onClose: () => void;
	anchorEl: HTMLElement;
	projectId: string;
}

function SiblingPopover({ variants, currentTaskId, agents, navigate, onClose, anchorEl, projectId }: SiblingPopoverProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const popoverRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ top: 0, left: 0 });
	const [visible, setVisible] = useState(false);
	const orderedVariants = sortVariants(variants);

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

	useEffect(() => {
		function handleKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") onClose();
		}
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	// Close on click outside
	useEffect(() => {
		function handleClick(event: MouseEvent) {
			if (
				popoverRef.current &&
				!popoverRef.current.contains(event.target as Node) &&
				!anchorEl.contains(event.target as Node)
			) {
				onClose();
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => {
			document.removeEventListener("mousedown", handleClick);
		};
	}, [anchorEl, onClose]);

	function handleVariantClick(variant: Task) {
		if (variant.id !== currentTaskId && ACTIVE_STATUSES.includes(variant.status)) {
			navigate({
				screen: "project",
				projectId,
				activeTaskId: variant.id,
			});
		}
		onClose();
	}

	return createPortal(
		<div
			ref={popoverRef}
			role="dialog"
			aria-label={t("task.siblings")}
			className="fixed z-50 overflow-hidden rounded-xl border border-edge-active bg-overlay shadow-2xl shadow-black/40"
			style={{
				top: pos.top,
				left: pos.left,
				width: 280,
				visibility: visible ? "visible" : "hidden",
			}}
			onClick={(event) => event.stopPropagation()}
		>
			<div className="border-b border-edge/50 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-fg-3">
				{t("task.siblings")}
			</div>
			<div className="max-h-64 overflow-y-auto py-1">
				{orderedVariants.map((variant) => {
					const agent = variant.agentId ? agents.find((candidate) => candidate.id === variant.agentId) : null;
					const config = agent && variant.configId
						? agent.configurations.find((candidate) => candidate.id === variant.configId)
						: agent?.configurations.find((candidate) => candidate.id === agent.defaultConfigId) ?? agent?.configurations[0];
					const isCurrent = variant.id === currentTaskId;
					const isAlive = ACTIVE_STATUSES.includes(variant.status);
					const isClickable = isAlive && !isCurrent;
					const title = getTaskTitle(variant);
					const variantLabel = t("task.attempt", { n: String(variant.variantIndex) });
					const rowLabel = isCurrent
						? `${t("task.currentVariant")}: ${variantLabel} — ${title}`
						: isAlive
							? t("task.switchToVariant", { variant: variantLabel, title })
							: `${variantLabel} — ${title} — ${t(statusKey(variant.status))}`;

					return (
						<button
							key={variant.id}
							type="button"
							disabled={!isClickable}
							aria-label={rowLabel}
							aria-current={isCurrent ? "true" : undefined}
							onClick={() => handleVariantClick(variant)}
							className={`w-full px-3 py-2 text-left transition-colors ${
								isCurrent
									? "bg-accent/10"
									: isClickable
										? "cursor-pointer hover:bg-elevated-hover"
										: "cursor-default opacity-55"
							}`}
							title={rowLabel}
						>
							<div className="flex items-start gap-2.5">
								<span
									aria-hidden="true"
									className="mt-1 h-2.5 w-2.5 flex-shrink-0 rounded-full"
									style={{ background: statusColors[variant.status] }}
								/>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-1.5 text-xs text-fg">
										<span className="truncate">
											{variantLabel}
											{agent ? ` · ${agent.name}` : ""}
											{config?.name ? ` (${config.name})` : ""}
										</span>
										{isCurrent && (
											<span className="flex-shrink-0 rounded bg-accent/15 px-1 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide text-accent">
												{t("task.currentVariant")}
											</span>
										)}
									</div>
									<div className="truncate text-[0.625rem] text-fg-2">{title}</div>
									<div className="truncate text-[0.5625rem] text-fg-muted">{t(statusKey(variant.status))}</div>
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
