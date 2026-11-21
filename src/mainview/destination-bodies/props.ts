import { createContext, useContext } from "react";
import type { DestinationBodyProps, DestinationId } from "./registry";

/** The destination the host is rendering and its props; a body asking for another one is a bug. */
export const DestinationPropsContext = createContext<{ destination: DestinationId; props: unknown } | null>(null);

/** The props the host passed for `destination`; a body reads them instead of App props. */
export function useDestinationProps<D extends DestinationId>(destination: D): DestinationBodyProps[D] {
	const provided = useContext(DestinationPropsContext);
	if (!provided) throw new Error(`${destination} body rendered outside any <DestinationBody>`);
	if (provided.destination !== destination) {
		throw new Error(`${destination} body rendered inside the ${provided.destination} <DestinationBody>`);
	}
	return provided.props as DestinationBodyProps[D];
}
