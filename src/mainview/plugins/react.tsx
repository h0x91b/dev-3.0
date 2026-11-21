import { createContext, useContext } from "react";
import type { Context } from "cordis";

/** The Cordis context a plugin's component renders under — the registering plugin's own. */
export const CordisContext = createContext<Context | null>(null);

export function useCordis(): Context {
	const ctx = useContext(CordisContext);
	if (!ctx) throw new Error("useCordis() outside a plugin component");
	return ctx;
}
