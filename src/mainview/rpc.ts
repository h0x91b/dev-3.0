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

const RPC_TIMEOUT_MS = 120_000;

// Wrap api.request to enrich timeout errors with the method name.
// Electrobun rejects with a generic "RPC request timed out." — no indication
// of which method failed.  This proxy catches that and re-throws with context
// so the unhandled-rejection tracker (analytics.ts) and console show something
// actionable like: 'RPC "getBranchStatus" timed out (120 000 ms)'.
const enrichedRequest = new Proxy(rawApi.request, {
	get(target: typeof rawApi.request, prop: string | symbol, receiver: unknown) {
		const value = Reflect.get(target, prop, receiver);
		if (typeof value !== "function") return value;
		return (...args: unknown[]) => {
			const promise = (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
			return promise.catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				if (/timed?\s*out/i.test(msg)) {
					throw new Error(`RPC "${String(prop)}" timed out (${RPC_TIMEOUT_MS} ms)`);
				}
				throw err;
			});
		};
	},
});

export const api = { ...rawApi, request: enrichedRequest } as typeof rawApi;
