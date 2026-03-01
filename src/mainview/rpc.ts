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
			navigateToSettings: () => {
				window.dispatchEvent(
					new CustomEvent("rpc:navigateToSettings"),
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
		} as any,
	},
});

const electroview = new Electroview({ rpc });

export const api = electroview.rpc!;
