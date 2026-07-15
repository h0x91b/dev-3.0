import { useEffect, useRef, useState } from "react";
import { useNarrowViewport } from "./hooks/useNarrowViewport";

export type ToastVariant = "error" | "success" | "info" | "warning";

export interface ToastEntry {
	id: number;
	message: string;
	variant: ToastVariant;
	durationMs: number;
	/** Optional task identity used when capacity eviction needs a durable fallback. */
	taskId?: string;
	/** Optional click handler — makes the whole toast a button (e.g. navigate to a task). */
	onClick?: () => void;
	/** Optional source line shown above the message (e.g. "#804 · project · task title"). */
	context?: string;
}

export interface ToastOpts {
	durationMs?: number;
	/** Task identity for task-scoped overflow fallback. */
	taskId?: string;
	/** When set, the toast becomes clickable and runs this on click (then dismisses). */
	onClick?: () => void;
	/** Optional source line shown above the message (e.g. "#804 · project · task title"). */
	context?: string;
}

export interface ToastHostProps {
	/** Receives only task-scoped entries evicted by the visible toast capacity limit. */
	onTaskOverflow?: (entry: ToastEntry) => void;
}

type Listener = (entry: ToastEntry) => void;

interface ToastRuntime {
	remainingMs: number;
	startedAtMs: number | null;
	timeoutId: ReturnType<typeof setTimeout> | null;
	hovered: boolean;
	focused: boolean;
}

interface RenderedToast {
	entry: ToastEntry;
	paused: boolean;
}

const listeners = new Set<Listener>();
let counter = 0;
let suppressed = false;
const pendingEntries: ToastEntry[] = [];

/** Default auto-dismiss delay. Long on purpose so error messages aren't missed. */
const DEFAULT_DURATION_MS = 30_000;
const MAX_VISIBLE_TOASTS = 5;
const NARROW_MAX_VISIBLE_TOASTS = 1;
const NARROW_VIEWPORT_PX = 768;

function deliver(entry: ToastEntry): void {
	listeners.forEach((l) => l(entry));
}

function emit(message: string, variant: ToastVariant, opts?: ToastOpts): void {
	const entry: ToastEntry = {
		id: ++counter,
		message,
		variant,
		durationMs: opts?.durationMs ?? DEFAULT_DURATION_MS,
		taskId: opts?.taskId,
		onClick: opts?.onClick,
		context: opts?.context,
	};
	if (suppressed) {
		pendingEntries.push(entry);
		return;
	}
	// No host mounted (e.g. in unit tests) → silently drop.
	deliver(entry);
}

/**
 * Imperative toast notifications — the in-app replacement for `window.alert`.
 *
 * Callable from anywhere (components, hooks, plain modules) because it is
 * module-level. Renders via a single `<ToastHost />` mounted in `App.tsx`, so
 * it works identically in the Electrobun desktop shell and headless remote
 * (browser) mode.
 */
export const toast = {
	error: (message: string, opts?: ToastOpts) => emit(message, "error", opts),
	success: (message: string, opts?: ToastOpts) => emit(message, "success", opts),
	info: (message: string, opts?: ToastOpts) => emit(message, "info", opts),
	warning: (message: string, opts?: ToastOpts) => emit(message, "warning", opts),
};

/** Suppress transient toasts while terminal immersive fullscreen is active. */
export function setToastSuppressed(value: boolean): void {
	if (suppressed === value) return;
	suppressed = value;
	if (suppressed) return;

	const pending = pendingEntries.splice(0, pendingEntries.length);
	pending.forEach(deliver);
}

const VARIANT: Record<ToastVariant, { icon: string; border: string; text: string; bar: string }> = {
	error: { icon: "\uf06a", border: "border-danger/40", text: "text-danger", bar: "bg-danger" },
	success: { icon: "\uf058", border: "border-success/40", text: "text-success", bar: "bg-success" },
	info: { icon: "\uf05a", border: "border-accent/40", text: "text-accent", bar: "bg-accent" },
	warning: { icon: "\uf071", border: "border-warning/40", text: "text-warning", bar: "bg-warning" },
};

function rendererIsActive(): boolean {
	if (typeof document === "undefined") return true;
	const focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
	return document.visibilityState === "visible" && focused;
}

export function ToastHost({ onTaskOverflow }: ToastHostProps = {}) {
	const narrow = useNarrowViewport(NARROW_VIEWPORT_PX);
	const maxVisibleToasts = narrow ? NARROW_MAX_VISIBLE_TOASTS : MAX_VISIBLE_TOASTS;
	const [toasts, setToasts] = useState<RenderedToast[]>([]);
	const toastsRef = useRef<RenderedToast[]>([]);
	const runtimesRef = useRef(new Map<number, ToastRuntime>());
	const activeRef = useRef(rendererIsActive());
	const overflowHandlerRef = useRef(onTaskOverflow);
	const maxVisibleToastsRef = useRef(maxVisibleToasts);
	overflowHandlerRef.current = onTaskOverflow;
	maxVisibleToastsRef.current = maxVisibleToasts;

	function publish(next: RenderedToast[]): void {
		toastsRef.current = next;
		setToasts(next);
	}

	function clearRuntime(id: number): void {
		const runtime = runtimesRef.current.get(id);
		if (!runtime) return;
		if (runtime.timeoutId !== null) {
			clearTimeout(runtime.timeoutId);
			runtime.timeoutId = null;
		}
		runtimesRef.current.delete(id);
	}

	function removeToast(id: number): void {
		clearRuntime(id);
		const next = toastsRef.current.filter(({ entry }) => entry.id !== id);
		if (next.length === toastsRef.current.length) return;
		publish(next);
	}

	function pauseRuntime(id: number): void {
		const runtime = runtimesRef.current.get(id);
		if (!runtime || runtime.startedAtMs === null) return;
		runtime.remainingMs = Math.max(0, runtime.remainingMs - (Date.now() - runtime.startedAtMs));
		runtime.startedAtMs = null;
		if (runtime.timeoutId !== null) {
			clearTimeout(runtime.timeoutId);
			runtime.timeoutId = null;
		}
	}

	function startRuntime(id: number): void {
		const runtime = runtimesRef.current.get(id);
		if (
			!runtime ||
			!activeRef.current ||
			runtime.hovered ||
			runtime.focused ||
			runtime.startedAtMs !== null
		) {
			return;
		}
		if (runtime.remainingMs <= 0) {
			removeToast(id);
			return;
		}
		runtime.startedAtMs = Date.now();
		runtime.timeoutId = setTimeout(() => removeToast(id), runtime.remainingMs);
	}

	function publishPauseState(): void {
		const next = toastsRef.current.map((view) => {
			const runtime = runtimesRef.current.get(view.entry.id);
			const paused = !activeRef.current || !!runtime?.hovered || !!runtime?.focused;
			return view.paused === paused ? view : { ...view, paused };
		});
		if (next.some((view, index) => view !== toastsRef.current[index])) publish(next);
	}

	function setInteraction(id: number, kind: "hovered" | "focused", value: boolean): void {
		const runtime = runtimesRef.current.get(id);
		if (!runtime || runtime[kind] === value) return;
		runtime[kind] = value;
		const shouldPause = !activeRef.current || runtime.hovered || runtime.focused;
		if (shouldPause) pauseRuntime(id);
		else startRuntime(id);
		publishPauseState();
	}

	function updateActivity(): void {
		const active = rendererIsActive();
		if (active === activeRef.current) return;
		activeRef.current = active;
		if (active) {
			for (const id of runtimesRef.current.keys()) startRuntime(id);
		} else {
			for (const id of runtimesRef.current.keys()) pauseRuntime(id);
		}
		publishPauseState();
	}

	useEffect(() => {
		document.addEventListener("visibilitychange", updateActivity);
		window.addEventListener("focus", updateActivity);
		window.addEventListener("blur", updateActivity);
		updateActivity();
		return () => {
			document.removeEventListener("visibilitychange", updateActivity);
			window.removeEventListener("focus", updateActivity);
			window.removeEventListener("blur", updateActivity);
		};
	}, []);

	useEffect(() => {
		const previous = toastsRef.current;
		const evictedCount = Math.max(0, previous.length - maxVisibleToasts);
		if (!evictedCount) return;

		const evicted = previous.slice(0, evictedCount);
		evicted.forEach(({ entry }) => clearRuntime(entry.id));
		publish(previous.slice(evictedCount));
		for (const { entry } of evicted) {
			if (entry.taskId) overflowHandlerRef.current?.(entry);
		}
	}, [maxVisibleToasts]);

	useEffect(() => {
		const listener: Listener = (entry) => {
			const runtime: ToastRuntime = {
				remainingMs: Math.max(0, entry.durationMs),
				startedAtMs: null,
				timeoutId: null,
				hovered: false,
				focused: false,
			};
			runtimesRef.current.set(entry.id, runtime);

			const previous = toastsRef.current;
			const capacity = maxVisibleToastsRef.current;
			const evictedCount = Math.max(0, previous.length - capacity + 1);
			const evicted = previous.slice(0, evictedCount);
			evicted.forEach(({ entry: evictedEntry }) => clearRuntime(evictedEntry.id));
			const next = [
				...previous.slice(evictedCount),
				{ entry, paused: !activeRef.current },
			];
			publish(next);

			for (const { entry: evictedEntry } of evicted) {
				if (evictedEntry.taskId) overflowHandlerRef.current?.(evictedEntry);
			}
			startRuntime(entry.id);
		};
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			for (const id of runtimesRef.current.keys()) clearRuntime(id);
			toastsRef.current = [];
		};
	}, []);

	if (!toasts.length) return null;

	return (
		<div className="fixed top-14 right-4 z-[55] flex flex-col gap-2.5 pointer-events-none">
			{toasts.map(({ entry, paused }) => {
				const v = VARIANT[entry.variant];
				return (
					<div
						key={entry.id}
						className="pointer-events-auto animate-slide-in-right"
						role="alert"
						data-toast-id={entry.id}
						onMouseEnter={() => setInteraction(entry.id, "hovered", true)}
						onMouseLeave={() => setInteraction(entry.id, "hovered", false)}
						onFocusCapture={() => setInteraction(entry.id, "focused", true)}
						onBlurCapture={(event) => {
							const nextFocus = event.relatedTarget;
							if (!(nextFocus instanceof Node) || !event.currentTarget.contains(nextFocus)) {
								setInteraction(entry.id, "focused", false);
							}
						}}
					>
						<div
							className={`relative overflow-hidden bg-overlay border ${v.border} rounded-xl shadow-2xl w-[26rem] max-w-[calc(100vw-2rem)] flex items-start gap-3 p-4`}
						>
							<span
								className={`${v.text} text-2xl leading-none mt-0.5 flex-shrink-0`}
								style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							>
								{v.icon}
							</span>
							{entry.onClick ? (
								<button
									type="button"
									onClick={() => {
										entry.onClick?.();
										removeToast(entry.id);
									}}
									className="flex-1 min-w-0 text-left pr-1 cursor-pointer group"
								>
									{entry.context && (
										<div className="text-[0.6875rem] font-mono text-fg-muted truncate mb-0.5">
											{entry.context}
										</div>
									)}
									<div className="text-fg text-sm leading-relaxed break-words group-hover:underline">
										{entry.message}
									</div>
								</button>
							) : (
								<div className="flex-1 min-w-0 pr-1">
									{entry.context && (
										<div className="text-[0.6875rem] font-mono text-fg-muted truncate mb-0.5">
											{entry.context}
										</div>
									)}
									<div className="text-fg text-sm leading-relaxed break-words">
										{entry.message}
									</div>
								</div>
							)}
							<button
								type="button"
								onClick={() => removeToast(entry.id)}
								aria-label="Dismiss"
								className="text-fg-muted hover:text-fg transition-colors flex-shrink-0"
							>
								<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
								</svg>
							</button>
							<div
								data-toast-progress
								className={`absolute bottom-0 left-0 h-0.5 ${v.bar} opacity-50`}
								style={{
									animation: `toast-shrink ${entry.durationMs}ms linear forwards`,
									animationPlayState: paused ? "paused" : "running",
								}}
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
}
