import TipCard from "../../components/TipCard";
import { useTipRotation } from "../../hooks/useTipRotation";

/** The tip carrier every surface shares (board column, Active Tasks): the rotation hook and its card. */
export function TipCarrier() {
	const { tip, tipState, applyTipState } = useTipRotation("board", false);
	return tip && tipState ? <TipCard tip={tip} tipState={tipState} onChanged={applyTipState} /> : <div data-testid="no-tip" />;
}
