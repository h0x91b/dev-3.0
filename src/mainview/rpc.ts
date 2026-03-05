import { Electroview } from "electrobun/view";
import type { AppRPCSchema } from "../shared/types";

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
				const z = (window as any).__dev3Zoom;
				z?.adjustZoom(z.ZOOM_STEP);
			},
			zoomOut: () => {
				const z = (window as any).__dev3Zoom;
				z?.adjustZoom(-z.ZOOM_STEP);
			},
			zoomReset: () => {
				(window as any).__dev3Zoom?.applyZoom(1.0);
			},
		} as any,
	},
});

const electroview = new Electroview({ rpc });

export const api = electroview.rpc!;
