export interface FreezeBeat {
	clientId: string;
	visible: boolean;
	sinceLastBeatMs: number;
	hiddenSinceLastBeat: boolean;
	terminals: number;
	frameErrorPanes: number;
	artifactOpen?: boolean;
	artifactIdleMs?: number | null;
	viewport?: { width: number; height: number; dpr: number };
	focused?: boolean;
	animationFrameAgeMs?: number | null;
}

export type FreezeMessage =
	| { kind: "host" }
	| { kind: "window"; windowId: number; event: "created" | "focus" | "blur" | "closed" }
	| { kind: "beat"; windowId: number; beat: FreezeBeat }
	| { kind: "display"; reason: string }
	| { kind: "pty-output"; number: number; ok: boolean; clients: number; bytes: number }
	| { kind: "stop" };

/** Worker → host: a renderer stopped beating, so write out the recent terminal output. */
export interface PtyOutputRequest {
	event: "capture-pty-output";
	session: string;
	number: number;
	reasons: string[];
}

export function wantsPtyOutput(reasons: string[]): boolean {
	return reasons.some((reason) => /^window-\d+-heartbeat-missing$/.test(reason));
}

export interface FreezeWorkerOptions {
	hostPid: number;
	directory: string;
	version: string;
	build: string;
}
