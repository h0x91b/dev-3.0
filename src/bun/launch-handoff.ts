// Linux single-instance activation (issue #2039).
//
// Closing the last window keeps the app alive (`exitOnLastWindowClosed: false`),
// and Linux has no dock icon to bring it back, so every relaunch from the app
// launcher used to start another full backend on the same data. A desktop
// launch now first asks a running instance of the SAME installed build to show
// a window, and exits if one agrees — the launcher click becomes macOS's dock
// click. Nothing is ever killed. See decisions/2026/10/25/linux-launch-hands-off-to-running-instance.md.

import type { CliRequest, CliResponse } from "../shared/types";
import { createLogger } from "./logger";

const log = createLogger("launch-handoff");

export const LAUNCH_ACTIVATE_METHOD = "app.activate";
const PER_PEER_TIMEOUT_MS = 1500;

export interface LaunchActivateReply {
	activated: boolean;
	/** Why a peer declined; diagnostic only. */
	reason?: string;
}

/** What a running desktop instance does when a newcomer asks it to take over. */
export type LaunchActivationHost = (bundle: string) => LaunchActivateReply;

let activationHost: LaunchActivationHost | null = null;

/** Installed by the desktop entry once it can open windows; headless never sets it. */
export function setLaunchActivationHost(host: LaunchActivationHost | null): void {
	activationHost = host;
}

/** `app.activate` socket handler: decline unless a window host is installed. */
export function handleLaunchActivate(params: Record<string, unknown>): LaunchActivateReply {
	if (!activationHost) return { activated: false, reason: "no-window-host" };
	const bundle = typeof params.bundle === "string" ? params.bundle : "";
	if (!bundle) return { activated: false, reason: "no-bundle" };
	return activationHost(bundle);
}

export interface ActivationPolicyInput {
	platform: NodeJS.Platform;
	/** This instance's own bundle; a peer accepts only an identical one. */
	bundle: string;
	ownBundle: string;
	/** Set when an agent pane or devScript launched this instance (a "guest"). */
	hostTaskId: string | null;
	windowCount: number;
}

/** The peer-side decision, kept pure so every refusal is testable. */
export function decideLaunchActivation(input: ActivationPolicyInput): LaunchActivateReply & { open?: boolean } {
	if (input.platform !== "linux") return { activated: false, reason: "platform" };
	if (input.hostTaskId) return { activated: false, reason: "guest-instance" };
	if (input.bundle !== input.ownBundle) return { activated: false, reason: "other-install" };
	return { activated: true, open: input.windowCount === 0 };
}

export interface NewcomerPolicyInput {
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
}

/**
 * Only an ordinary Linux desktop launch hands off. A guest (DEV3_TASK_ID) or a
 * dev launch (DEV3_FRESH_START) is a deliberate extra instance; macOS gets this
 * from the OS already, and Windows keeps its current behavior.
 */
export function shouldTryLaunchHandoff(input: NewcomerPolicyInput): boolean {
	return input.platform === "linux" && !input.env.DEV3_TASK_ID && input.env.DEV3_FRESH_START !== "1";
}

export type PeerRequest = (endpoint: string, request: CliRequest, timeoutMs: number) => Promise<CliResponse | null>;

export interface HandoffDeps {
	peers: () => string[];
	request: PeerRequest;
	bundle: string;
}

/** Returns the endpoint that took over, or null to continue launching normally. */
export async function handOffToRunningInstance(deps: HandoffDeps): Promise<string | null> {
	for (const endpoint of deps.peers()) {
		// Unix sockets only: Windows loopback records never reach this (Linux-gated).
		if (!endpoint.endsWith(".sock")) continue;
		const request: CliRequest = { id: `handoff-${process.pid}`, method: LAUNCH_ACTIVATE_METHOD, params: { bundle: deps.bundle } };
		const response = await deps.request(endpoint, request, PER_PEER_TIMEOUT_MS).catch(() => null);
		const reply = response?.ok ? (response.data as LaunchActivateReply | undefined) : undefined;
		if (reply?.activated === true) return endpoint;
		log.info("Running instance did not take over this launch", {
			endpoint,
			reason: reply?.reason ?? response?.error ?? "no-response",
		});
	}
	return null;
}

/** One NDJSON request over a Unix socket; null on timeout or any transport error. */
export const requestOverUnixSocket: PeerRequest = (endpoint, request, timeoutMs) =>
	new Promise((resolve) => {
		let buffered = "";
		let settled = false;
		const finish = (value: CliResponse | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		const parse = (): CliResponse | null => {
			const line = buffered.split("\n").find((part) => part.trim());
			if (!line) return null;
			try {
				return JSON.parse(line) as CliResponse;
			} catch {
				return null;
			}
		};
		Bun.connect({
			unix: endpoint,
			socket: {
				open(socket) {
					socket.write(JSON.stringify(request) + "\n");
				},
				data(socket, chunk) {
					buffered += Buffer.from(chunk).toString("utf-8");
					if (buffered.includes("\n")) {
						finish(parse());
						socket.end();
					}
				},
				close() {
					finish(parse());
				},
				error() {
					finish(null);
				},
			},
		}).catch(() => finish(null));
	});
