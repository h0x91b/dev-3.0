/**
 * The desktop launch's renderer readiness contract.
 *
 * A window handle is NOT a renderer. On Windows the native side creates the
 * window synchronously and *then* fails to create the WebView2 controller —
 * `HRESULT 0x80070578` (`ERROR_INVALID_WINDOW_HANDLE`) when there is no
 * interactive desktop, e.g. over SSH. That failure is asynchronous, inside
 * libNativeWrapper: no JS exception, no event, and a non-null window pointer,
 * so `new BrowserWindow()` returns success and the app logs "ready" with zero
 * renderers. It then keeps pushing to a webview that has no live controller —
 * electrobun's transport falls back to an FFI `evaluateJavaScriptWithNoCompletion`
 * when no renderer socket ever connected — and the quit gate can never finish,
 * because it asks the renderer to confirm and nobody answers.
 *
 * The first webview `dom-ready` is the only signal that a renderer exists, so
 * the launch arms a watchdog on it: ready inside the budget → proceed; silence →
 * the launch has failed and the caller must leave instead of half-running.
 * Measured healthy startups reach dom-ready in 366 ms (Windows, interactive) and
 * 1511 ms (packaged launch proof), so the budget is ~30x the observed cost.
 */

import { CLI_EXIT_CODE_RENDERER_UNAVAILABLE } from "../shared/cli-exit-codes";

/** Budget from window creation to the first `dom-ready`. */
export const RENDERER_READY_TIMEOUT_MS = 45_000;

/** Grepped by the Windows launch proof; keep it stable. */
export const RENDERER_UNAVAILABLE_MARKER = "DEV3_DESKTOP_RENDERER_UNAVAILABLE";

export const RENDERER_READY_TIMEOUT_ENV = "DEV3_RENDERER_READY_TIMEOUT_MS";

/**
 * How long this platform waits for a renderer, or `null` for "do not watch".
 *
 * Only win32 is watched by default: the failure is a WebView2/interactive-desktop
 * one, and killing a launch is severe enough that macOS and Linux keep their
 * existing behaviour until the same failure is observed there. The env override
 * is the seam for tests and for the opt-in duration regression; `0` disables the
 * watchdog outright, and an unparsable value falls back to the platform default
 * rather than silently disabling a safety net.
 */
export function resolveRendererReadyTimeoutMs(
	env: Record<string, string | undefined> = process.env,
	platform: NodeJS.Platform = process.platform,
): number | null {
	const platformDefault = platform === "win32" ? RENDERER_READY_TIMEOUT_MS : null;
	const raw = env[RENDERER_READY_TIMEOUT_ENV]?.trim();
	if (!raw) return platformDefault;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return platformDefault;
	return parsed === 0 ? null : parsed;
}

/**
 * The actionable diagnostic. No native dialog and no `window.alert`: the renderer
 * that would host in-app UI is exactly what is missing, so the console and the
 * log file are the only channels that exist here.
 */
export function buildRendererUnavailableDiagnostic(
	timeoutMs: number,
	platform: NodeJS.Platform = process.platform,
): string {
	const lines = [
		`${RENDERER_UNAVAILABLE_MARKER}: the desktop window never produced a renderer within ${timeoutMs}ms.`,
		"The native window was created but its webview never reported dom-ready, so this process has no UI.",
	];
	if (platform === "win32") {
		lines.push(
			"On Windows this is almost always one of:",
			"  1. No interactive desktop — an SSH / service / session-0 launch. WebView2 fails with",
			"     HRESULT 0x80070578 (ERROR_INVALID_WINDOW_HANDLE). Log in to the machine's own desktop,",
			"     or run the headless server instead: dev3 remote",
			"  2. The WebView2 runtime is missing or broken. Install it with:",
			"     winget install --id Microsoft.EdgeWebView2Runtime -e",
		);
	} else {
		lines.push(
			"Check that this process has access to a graphical session, or run the headless server: dev3 remote",
		);
	}
	lines.push(
		`Exiting with code ${CLI_EXIT_CODE_RENDERER_UNAVAILABLE} instead of running without a UI.`,
	);
	return lines.join("\n");
}

export type RendererReadinessState = "disabled" | "idle" | "armed" | "ready" | "failed";

type TimerHandle = unknown;

export interface RendererReadinessOptions {
	/** `null` disables the watchdog: `arm()` and `markReady()` become no-ops. */
	timeoutMs: number | null;
	/** Called once, when the budget expires without a renderer. */
	onTimeout: (timeoutMs: number) => void;
	onArmed?: (timeoutMs: number) => void;
	onReady?: (source: string, elapsedMs: number) => void;
	setTimer?: (fn: () => void, ms: number) => TimerHandle;
	clearTimer?: (handle: TimerHandle) => void;
	now?: () => number;
}

export interface RendererReadinessWatchdog {
	/** Start the budget. Idempotent — extra windows do not restart it. */
	arm(): void;
	/** Report a renderer. Returns true only for the first report. */
	markReady(source: string): boolean;
	state(): RendererReadinessState;
}

export function createRendererReadinessWatchdog(
	opts: RendererReadinessOptions,
): RendererReadinessWatchdog {
	const setTimer = opts.setTimer ?? ((fn, ms) => {
		const handle = setTimeout(fn, ms);
		// The watchdog must never be the reason a process stays alive.
		(handle as { unref?: () => void }).unref?.();
		return handle;
	});
	const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	const now = opts.now ?? (() => Date.now());

	let state: RendererReadinessState = opts.timeoutMs === null ? "disabled" : "idle";
	let timer: TimerHandle | null = null;
	let armedAt = 0;

	return {
		arm(): void {
			if (state !== "idle") return;
			const timeoutMs = opts.timeoutMs as number;
			state = "armed";
			armedAt = now();
			timer = setTimer(() => {
				if (state !== "armed") return;
				state = "failed";
				timer = null;
				opts.onTimeout(timeoutMs);
			}, timeoutMs);
			opts.onArmed?.(timeoutMs);
		},
		markReady(source: string): boolean {
			if (state === "ready" || state === "failed") return false;
			const wasArmed = state === "armed";
			if (state === "disabled") {
				// Nothing to disarm, but the caller still needs "first renderer"
				// semantics so it can gate one-shot work on it.
				state = "ready";
				opts.onReady?.(source, 0);
				return true;
			}
			state = "ready";
			if (timer !== null) {
				clearTimer(timer);
				timer = null;
			}
			opts.onReady?.(source, wasArmed ? now() - armedAt : 0);
			return true;
		},
		state(): RendererReadinessState {
			return state;
		},
	};
}
