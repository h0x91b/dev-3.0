import type { Epic } from "../../shared/types";
import { useT } from "../i18n";

interface EpicChipProps {
	epic: Pick<Epic, "name" | "color" | "archived">;
	/** Present → the chip is a button (filter by this epic). Absent → plain text. */
	onClick?: (e: React.MouseEvent) => void;
	testId?: string;
}

/**
 * One epic, as a squared tag with a colour bar — square on purpose, so it never
 * reads as one more round label chip. The colour is user data, like a label's.
 */
function EpicChip({ epic, onClick, testId = "epic-chip" }: EpicChipProps) {
	const t = useT();
	const title = epic.archived ? t("epic.chipArchivedTitle", { name: epic.name }) : t("epic.chipTitle", { name: epic.name });
	const className = `inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md py-px pl-1 pr-1.5 text-dense font-semibold leading-tight text-fg-2 ${
		epic.archived ? "opacity-60" : ""
	} ${onClick ? "cursor-pointer hover:text-fg focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.96] transition-transform" : ""}`;
	const style = { background: `${epic.color}1f`, boxShadow: `inset 0 0 0 1px ${epic.color}40` };
	const body = (
		<>
			<span aria-hidden className="h-2.5 w-[3px] flex-shrink-0 rounded-full" style={{ background: epic.color }} />
			<span className="truncate">{epic.name}</span>
		</>
	);
	return onClick ? (
		<button type="button" data-testid={testId} title={title} aria-label={title} onClick={onClick} className={className} style={style}>
			{body}
		</button>
	) : (
		<span data-testid={testId} title={title} className={className} style={style}>
			{body}
		</span>
	);
}

export default EpicChip;
