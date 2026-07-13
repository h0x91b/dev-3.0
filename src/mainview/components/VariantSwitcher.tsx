import type { CodingAgent, Task } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import type { Route } from "../state";
import { useT } from "../i18n";
import { useStatusColors } from "../hooks/useStatusColors";
import { getAliveVariants } from "../utils/variantGroups";
import AgentLauncherBadge from "./AgentLauncherBadge";
import Tooltip from "./Tooltip";

interface VariantSwitcherProps {
	variants: Task[];
	currentTaskId: string;
	agents: CodingAgent[];
	projectId: string;
	isFullPage?: boolean;
	navigate: (route: Route) => void;
}

/** Compact Context-bar control for switching between the live variants. */
function VariantSwitcher({ variants, currentTaskId, agents, projectId, isFullPage = false, navigate }: VariantSwitcherProps) {
	const t = useT();
	const statusColors = useStatusColors();
	const aliveVariants = getAliveVariants(variants);

	if (aliveVariants.length < 2) return null;

	function navigateToVariant(taskId: string) {
		navigate(isFullPage
			? { screen: "task", projectId, taskId }
			: { screen: "project", projectId, activeTaskId: taskId });
	}

	return (
		<div
			role="group"
			aria-label={t("task.siblings")}
			className="inline-flex min-w-0 flex-shrink-0 items-center gap-0.5 rounded-lg border border-edge bg-raised/60 p-0.5"
			data-testid="variant-switcher"
		>
			{aliveVariants.map((variant) => {
				const isCurrent = variant.id === currentTaskId;
				const agent = variant.agentId ? agents.find((candidate) => candidate.id === variant.agentId) : undefined;
				const variantLabel = t("task.attempt", { n: String(variant.variantIndex) });
				const title = getTaskTitle(variant);
				const accessibleLabel = isCurrent
					? `${t("task.currentVariant")}: ${variantLabel} — ${title}`
					: t("task.switchToVariant", { variant: variantLabel, title });

				return (
					<Tooltip key={variant.id} content={variantLabel} detail={title}>
						<button
							type="button"
							disabled={isCurrent}
							aria-label={accessibleLabel}
							aria-current={isCurrent ? "true" : undefined}
							data-testid={`variant-switcher-${variant.id}`}
							onClick={() => navigateToVariant(variant.id)}
							className={`inline-flex h-7 min-w-[2.25rem] items-center justify-center gap-1 rounded-md px-1.5 text-[0.625rem] font-semibold tabular-nums transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
								isCurrent
									? "bg-accent/15 text-fg ring-1 ring-inset ring-accent/60"
									: "text-fg-3 hover:bg-elevated-hover hover:text-fg"
							}`}
						>
							<span
								aria-hidden="true"
								className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
								style={{ background: statusColors[variant.status] }}
							/>
							<span aria-hidden="true">{variant.variantIndex}</span>
							{agent && <AgentLauncherBadge agent={agent} size={13} />}
						</button>
					</Tooltip>
				);
			})}
		</div>
	);
}

export default VariantSwitcher;
