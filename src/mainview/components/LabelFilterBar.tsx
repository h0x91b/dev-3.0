import type { Label } from "../../shared/types";
import { useT } from "../i18n";
import LabelChip from "./LabelChip";

interface LabelFilterBarProps {
	labels: Label[];
	activeFilters: string[];
	onToggle: (labelId: string) => void;
	onClear: () => void;
}

function LabelFilterBar({ labels, activeFilters, onToggle, onClear }: LabelFilterBarProps) {
	const t = useT();

	if (labels.length === 0) return null;

	return (
		<div className="flex items-center gap-2 px-6 py-2 border-b border-edge/50 flex-wrap">
			<span className="text-xs text-fg-3 font-medium flex-shrink-0">{t("labels.filterTitle")}:</span>
			<div className="flex items-center gap-1.5 flex-wrap">
				{labels.map((label) => (
					<LabelChip
						key={label.id}
						label={label}
						size="sm"
						active={activeFilters.includes(label.id)}
						onClick={() => onToggle(label.id)}
					/>
				))}
			</div>
			{activeFilters.length > 0 && (
				<button
					type="button"
					onClick={onClear}
					className="ml-auto text-xs text-fg-3 hover:text-fg px-2 py-0.5 rounded-lg hover:bg-fg/8 transition-colors flex-shrink-0"
				>
					× {t("labels.clearFilters")}
				</button>
			)}
		</div>
	);
}

export default LabelFilterBar;
