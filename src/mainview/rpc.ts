import { Electroview } from "electrobun/view";
import type { AppRPCSchema } from "../shared/types";
import { adjustZoom, applyZoom, ZOOM_STEP, DEFAULT_ZOOM } from "./zoom";

const rpc = Electroview.defineRPC<AppRPCSchema>({
	maxRequestTime: 120_000, // 2 min — covers native dialogs and git operations
	handlers: {
		requests: {},
		messages: {
			taskUpdated: (payload: any) => {
				window.dispatchEvent(
					new CustomEvent("rpc:taskUpdated", { detail: payload }),
				);
			},
			projectUpdated: (payload: any) => {
				window.dispatchEvent(
					new CustomEvent("rpc:projectUpdated", { detail: payload }),
				);
			},
			ptyDied: (payload: any) => {
				window.dispatchEvent(
					new CustomEvent("rpc:ptyDied", { detail: payload }),
				);
			},
			terminalBell: (payload: any) => {
				window.dispatchEvent(
					new CustomEvent("rpc:terminalBell", { detail: payload }),
				);
			},
			gitOpCompleted: (payload: any) => {
				window.dispatchEvent(
					new CustomEvent("rpc:gitOpCompleted", { detail: payload }),
				);
			},
			branchMerged: (payload: any) => {
				window.dispatchEvent(
					new CustomEvent("rpc:branchMerged", { detail: payload }),
				);
			},
			updateAvailable: (payload: any) => {
				window.dispatchEvent(
					new CustomEvent("rpc:updateAvailable", { detail: payload }),
				);
			},
			portsUpdated: (payload: any) => {
				window.dispatchEvent(
					new CustomEvent("rpc:portsUpdated", { detail: payload }),
				);
			},
			updateDownloadProgress: (payload: any) => {
				window.dispatchEvent(
					new CustomEvent("rpc:updateDownloadProgress", { detail: payload }),
				);
			},
			navigateToSettings: () => {
				window.dispatchEvent(
					new CustomEvent("rpc:navigateToSettings"),
				);
			},
			navigateToGaugeDemo: () => {
				window.dispatchEvent(
					new CustomEvent("rpc:navigateToGaugeDemo"),
				);
			},
			navigateToViewportLab: () => {
				window.dispatchEvent(
					new CustomEvent("rpc:navigateToViewportLab"),
				);
			},
			terminalSoftReset: () => {
				window.dispatchEvent(
					new CustomEvent("rpc:terminalSoftReset"),
				);
			},
			terminalHardReset: () => {
				window.dispatchEvent(
					new CustomEvent("rpc:terminalHardReset"),
				);
			},
			zoomIn: () => {
				adjustZoom(ZOOM_STEP);
			},
			zoomOut: () => {
				adjustZoom(-ZOOM_STEP);
			},
			zoomReset: () => {
				applyZoom(DEFAULT_ZOOM);
			},
		} as any,
	},
});

const electroview = new Electroview({ rpc });

const rawApi = electroview.rpc!;

// Wrap api.request so that every RPC call has a safety-net .catch().
// Electrobun rejects with "RPC request timed out." when a request exceeds
// maxRequestTime.  If the calling code has no .catch() / try-catch the
// rejection becomes an unhandled promise rejection (visible in analytics
// as "UNHANDLED REJECTION: RPC REQUEST TIMED OUT. | NO STACK").
//
// The trick: attaching .catch() synchronously to the original promise marks
// it as "handled" for the engine — so unhandledrejection never fires — but
// callers who DO await the promise still get the rejection re-thrown.
const safeRequest = new Proxy(rawApi.request, {
	get(target: typeof rawApi.request, prop: string | symbol, receiver: unknown) {
		const value = Reflect.get(target, prop, receiver);
		if (typeof value !== "function") return value;
		return (...args: unknown[]) => {
			const promise = (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
			// Safety net — silently absorb the rejection on this fork.
			// The original promise stays rejected so callers with try/catch still see it.
			promise.catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				if (/timed?\s*out/i.test(msg)) {
					console.warn(`[RPC] "${String(prop)}" timed out (${(rawApi as any).maxRequestTime ?? 120_000}ms)`);
				}
				// Non-timeout errors are also absorbed here to prevent unhandled rejection,
				// but callers with try/catch still receive the error normally.
			});
			return promise;
		};
	},
});

export const api = { ...rawApi, request: safeRequest } as typeof rawApi;
