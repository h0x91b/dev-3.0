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
	| { kind: "stop" };

export interface FreezeWorkerOptions {
	hostPid: number;
	directory: string;
	version: string;
	build: string;
}
