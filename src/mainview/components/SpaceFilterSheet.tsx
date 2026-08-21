import type { Space } from "../../shared/types";
import BottomSheet from "./BottomSheet";
import { HOME_GROUP_ID } from "../utils/spaceGroups";
import { MASK_CLASS } from "../sensitive-projects";
import { useT } from "../i18n";

interface SpaceFilterSheetProps {
	spaces: Space[];
	maskedSpaceIds: ReadonlySet<string>;
	projectCountOf: (spaceId: string) => number;
	totalProjects: number;
	homeCount: number;
	/** null = All projects. `HOME_GROUP_ID` = the computed Home group. */
	selectedSpaceId: string | null;
	onSelect: (id: string | null) => void;
	onClose: () => void;
}

/**
 * The space filter below the rail's width. Same choice the rail offers, in the
 * container narrow screens are allowed to use — the rail is 224px of horizontal
 * chrome, which a phone does not have to spend.
 *
 * It exists so the filter is not a setting the user can reach only by widening
 * the window: the dashboard used to clear the selection when the rail went away,
 * which silently changed what was on screen.
 */
function SpaceFilterSheet({
	spaces,
	maskedSpaceIds,
	projectCountOf,
	totalProjects,
	homeCount,
	selectedSpaceId,
	onSelect,
	onClose,
}: SpaceFilterSheetProps) {
	const t = useT();

	function Row({ id, label, count, masked }: { id: string | null; label: string; count: number; masked?: boolean }) {
		const active = selectedSpaceId === id;
		return (
			<button
				type="button"
				onClick={() => {
					onSelect(id);
					onClose();
				}}
				aria-pressed={active}
				className={`w-full flex items-center gap-3 px-3 rounded-xl text-left transition-colors ${
					active ? "bg-accent/15 text-fg" : "text-fg-2 hover:bg-elevated-hover"
				}`}
				data-testid={`space-filter-${id ?? "all"}`}
			>
				<span aria-hidden="true" className={`text-accent text-sm leading-none w-4 ${active ? "" : "invisible"}`} style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
					{"\u{F012C}"}
				</span>
				<span className={`flex-1 text-sm truncate ${masked ? MASK_CLASS : ""}`}>{label}</span>
				<span className={`text-fg-muted text-xs tabular-nums ${masked ? MASK_CLASS : ""}`}>{count}</span>
			</button>
		);
	}

	return (
		<BottomSheet open onClose={onClose} title={t("spaces.filterTitle")} testId="space-filter-sheet">
			<div className="flex flex-col gap-0.5">
				<Row id={null} label={t("spaces.railAllProjects")} count={totalProjects} />
				{spaces.map((space) => (
					<Row
						key={space.id}
						id={space.id}
						label={space.name}
						count={projectCountOf(space.id)}
						masked={maskedSpaceIds.has(space.id)}
					/>
				))}
				{homeCount > 0 && <Row id={HOME_GROUP_ID} label={t("spaces.homeGroup")} count={homeCount} />}
			</div>
		</BottomSheet>
	);
}

export default SpaceFilterSheet;
