import { useReducedMotion } from "../utils/useReducedMotion";

/**
 * Loading placeholder shaped exactly like AgentConfigPicker with `showFavorites`
 * (narrow star column + Provider/Model/Mode), so the real picker replaces it
 * without shifting the dialog by a field row.
 */
function AgentPickerSkeleton() {
	const reducedMotion = useReducedMotion();
	const pulse = reducedMotion ? "" : " animate-pulse";

	return (
		<div className={`flex flex-col sm:flex-row gap-3${pulse}`} aria-hidden="true" data-testid="agent-picker-skeleton">
			<div className="flex flex-col flex-shrink-0">
				<div className="h-3 w-14 rounded bg-elevated mb-1" />
				<div className="h-[34px] w-[4.5rem] rounded-lg bg-elevated" />
			</div>
			{[0, 1, 2].map((i) => (
				<div key={i} className="flex-1 min-w-0">
					<div className="h-3 w-16 rounded bg-elevated mb-1" />
					<div className="h-[34px] rounded-lg bg-elevated" />
				</div>
			))}
		</div>
	);
}

export default AgentPickerSkeleton;
