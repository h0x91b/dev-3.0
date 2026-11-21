import { useCallback, useSyncExternalStore } from "react";
import { useT } from "../i18n";
import { getAppRoot } from "../plugins/root";
import { SlotComponent, SlotHost } from "../plugins/SlotHost";
import { BUILTIN_DESTINATION_BODIES } from "./builtins";
import { DestinationPropsContext } from "./props";
import { getDestinationBodyRegistry, type DestinationBodyProps, type DestinationId } from "./registry";

/**
 * A destination's body on the `destinationBodies` replace slot. The built-in is the only
 * option today, so there is no chooser and nothing is saved (bible §5.12, Verdict 1).
 */
export function DestinationBody<D extends DestinationId>({ destination, props }: { destination: D; props: DestinationBodyProps[D] }) {
	const t = useT();
	const registry = getDestinationBodyRegistry();
	const entries = useSyncExternalStore(registry.subscribe, useCallback(() => registry.listRegion(destination), [registry, destination]));
	const builtin = BUILTIN_DESTINATION_BODIES[destination];
	const active = entries.find((entry) => entry.def.id === builtin.id);
	return (
		<DestinationPropsContext.Provider value={props}>
			<SlotHost
				slot="destinationBodies"
				requestedId={builtin.id}
				active={active}
				fallback={<SlotComponent ctx={getAppRoot()} component={builtin.component} />}
				crashedMessage={t("destinationBody.crashed")}
				failedMessage={(name) => t("destinationBody.extensionFailed", { name })}
			/>
		</DestinationPropsContext.Provider>
	);
}
