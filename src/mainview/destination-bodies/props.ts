import { createContext, useContext } from "react";
import type { DestinationBodyProps, DestinationId } from "./registry";

/** The destination the host is rendering and its props; a body asking for another one is a bug. */
export const DestinationPropsContext = createContext<{ destination: DestinationId; props: unknown } | null>(null);

/** The props the host passed for `destination`; a body reads them instead of App props. */
export function useDestinationProps<D extends DestinationId>(destination: D): DestinationBodyProps[D] {
	const provided = useContext(DestinationPropsContext);
	if (provided?.destination !== destination) {
		throw new Error(`${destination} body rendered inside ${provided ? `the ${provided.destination}` : "no"} <DestinationBody>`);
	}
	return provided.props as DestinationBodyProps[D];
}
