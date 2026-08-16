import { useEffect, useState } from "react";
import type { ModelCatalogView } from "../../shared/types";
import { api } from "../rpc";

/** The saved catalog, or null while it loads or when it cannot be read. The
 *  roles editor, the command preview and the launch picker's provider caption
 *  all read it, and none of them owns the error: the catalog settings surface
 *  does. Best-effort by contract — every caller must render without it, so the
 *  call itself is guarded rather than only its promise. */
export function useModelCatalog(reloadKey?: unknown): ModelCatalogView | null {
	const [catalog, setCatalog] = useState<ModelCatalogView | null>(null);

	useEffect(() => {
		let cancelled = false;
		void Promise.resolve()
			.then(() => api.request.modelCatalogGet())
			.then((view) => {
				if (!cancelled) setCatalog(view);
			})
			.catch(() => {
				/* stays null — the surface that owns the catalog reports it */
			});
		return () => {
			cancelled = true;
		};
		// `reloadKey` is the caller's own "it changed" signal (connecting a
		// provider): the catalog has no push message of its own.
	}, [reloadKey]);

	return catalog;
}
