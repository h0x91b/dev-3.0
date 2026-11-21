import { createContext, useContext } from "react";
import type { DestinationBodyProps, DestinationId } from "./registry";

export const DestinationPropsContext = createContext<unknown>(null);

/** The props the host passed for `destination`; a body reads them instead of App props. */
export function useDestinationProps<D extends DestinationId>(destination: D): DestinationBodyProps[D] {
	const props = useContext(DestinationPropsContext);
	if (props === null) throw new Error(`${destination} body rendered outside its <DestinationBody>`);
	return props as DestinationBodyProps[D];
}
