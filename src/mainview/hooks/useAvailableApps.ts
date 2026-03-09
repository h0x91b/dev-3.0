import { useState, useEffect } from "react";
import type { ExternalApp } from "../../shared/types";
import { api } from "../rpc";

let cachedApps: ExternalApp[] | null = null;
let fetchPromise: Promise<ExternalApp[]> | null = null;

/** Returns the list of installed external apps (cached after first fetch). */
export function useAvailableApps(): ExternalApp[] {
	const [apps, setApps] = useState<ExternalApp[]>(cachedApps ?? []);

	useEffect(() => {
		if (cachedApps) {
			setApps(cachedApps);
			return;
		}

		if (!fetchPromise) {
			fetchPromise = api.request.getAvailableApps().then((result) => {
				cachedApps = result;
				return result;
			}).catch(() => {
				return [];
			});
		}

		fetchPromise.then((result) => setApps(result)).catch(() => {});
	}, []);

	return apps;
}

/** Invalidate the cache so the next call refetches. */
export function invalidateAvailableApps(): void {
	cachedApps = null;
	fetchPromise = null;
}
