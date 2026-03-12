import { useState, useEffect } from "react";
import type { ExternalApp } from "../../shared/types";
import { api } from "../rpc";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedApps: ExternalApp[] | null = null;
let fetchPromise: Promise<ExternalApp[]> | null = null;
let fetchedAt = 0;

/** Returns the list of installed external apps (cached with a 5-minute TTL). */
export function useAvailableApps(): ExternalApp[] {
	const [apps, setApps] = useState<ExternalApp[]>(cachedApps ?? []);

	useEffect(() => {
		// Invalidate stale cache
		if (cachedApps && Date.now() - fetchedAt > CACHE_TTL_MS) {
			cachedApps = null;
			fetchPromise = null;
		}

		if (cachedApps) {
			setApps(cachedApps);
			return;
		}

		if (!fetchPromise) {
			fetchPromise = api.request.getAvailableApps().then((result) => {
				cachedApps = result;
				fetchedAt = Date.now();
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
	fetchedAt = 0;
}
