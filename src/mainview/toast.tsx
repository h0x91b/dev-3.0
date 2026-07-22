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
			{toasts.map(({ entry, paused }) => (
				<ToastCard
					key={entry.id}
					entry={entry}
					paused={paused}
					onDismiss={removeToast}
					onInteraction={setInteraction}
				/>
			))}
		</div>
	);
}

/** Movement before a press counts as a swipe, not a tap. */
const SWIPE_DECIDE_PX = 8;
/** Minimum rightward distance that dismisses (adaptive floor for narrow toasts). */
const SWIPE_COMMIT_MIN_PX = 72;
/** …or this fraction of the toast's own width, whichever is larger. */
const SWIPE_COMMIT_FRACTION = 0.35;

interface ToastCardProps {
	entry: ToastEntry;
	paused: boolean;
	onDismiss: (id: number) => void;
	onInteraction: (id: number, kind: "hovered" | "focused", value: boolean) => void;
}

/**
 * A single toast. Swipe it right (touch or mouse drag, via Pointer Events) to
 * dismiss — the toast slides in from the right, so flinging it back off the
 * right edge is the natural discard gesture. The visible X button and click
 * navigation still work; a completed drag suppresses the click that follows it.
 */
function ToastCard({ entry, paused, onDismiss, onInteraction }: ToastCardProps) {
	const v = VARIANT[entry.variant];
	const [dragX, setDragX] = useState(0);
	const [dragging, setDragging] = useState(false);
	const pointerIdRef = useRef<number | null>(null);
	const startXRef = useRef(0);
	const dragXRef = useRef(0);
	const widthRef = useRef(0);
	const draggedRef = useRef(false);

	function beginSwipe(e: React.PointerEvent) {
		if (pointerIdRef.current !== null) return; // ignore additional pointers (multi-touch)
		pointerIdRef.current = e.pointerId;
		startXRef.current = e.clientX;
		widthRef.current = e.currentTarget.getBoundingClientRect().width || 0;
		draggedRef.current = false;
		dragXRef.current = 0;
		setDragging(true);
		try {
			e.currentTarget.setPointerCapture(e.pointerId);
		} catch {
			// Pointer capture is a best-effort enhancement (absent in happy-dom).
		}
	}

	function updateSwipe(e: React.PointerEvent) {
		if (pointerIdRef.current !== e.pointerId) return;
		const dx = e.clientX - startXRef.current;
		if (Math.abs(dx) > SWIPE_DECIDE_PX) draggedRef.current = true;
		const next = dx > 0 ? dx : 0; // right-anchored toast: only follow rightward
		dragXRef.current = next;
		setDragX(next);
	}

	function endSwipe(e: React.PointerEvent) {
		if (pointerIdRef.current !== e.pointerId) return;
		const commit = Math.max(SWIPE_COMMIT_MIN_PX, widthRef.current * SWIPE_COMMIT_FRACTION);
		const dismiss = dragXRef.current >= commit;
		try {
			e.currentTarget.releasePointerCapture(e.pointerId);
		} catch {
			// no-op
		}
		pointerIdRef.current = null;
		setDragging(false);
		if (dismiss) {
			onDismiss(entry.id);
		} else {
			dragXRef.current = 0;
			setDragX(0);
		}
	}

	function cancelSwipe(e: React.PointerEvent) {
		if (pointerIdRef.current !== e.pointerId) return;
		pointerIdRef.current = null;
		draggedRef.current = false;
		setDragging(false);
		dragXRef.current = 0;
		setDragX(0);
	}

	// A completed drag must not also fire the toast's click/dismiss actions.
	function suppressIfDragged(): boolean {
		if (draggedRef.current) {
			draggedRef.current = false;
			return true;
		}
		return false;
	}

	const width = widthRef.current > 0 ? widthRef.current : 400;
	const opacity = 1 - Math.min(0.85, dragX / width);

	return (
		<div
			className="pointer-events-auto animate-slide-in-right"
			role="alert"
			data-toast-id={entry.id}
			onMouseEnter={() => onInteraction(entry.id, "hovered", true)}
			onMouseLeave={() => onInteraction(entry.id, "hovered", false)}
			onFocusCapture={() => onInteraction(entry.id, "focused", true)}
			onBlurCapture={(event) => {
				const nextFocus = event.relatedTarget;
				if (!(nextFocus instanceof Node) || !event.currentTarget.contains(nextFocus)) {
					onInteraction(entry.id, "focused", false);
				}
			}}
		>
			<div
				data-toast-card
				data-dragging={dragging ? "true" : "false"}
				className={`toast-swipe relative overflow-hidden bg-overlay border ${v.border} rounded-xl shadow-2xl w-[26rem] max-w-[calc(100vw-2rem)] flex items-start gap-3 p-4`}
				style={{ transform: `translateX(${dragX}px)`, opacity }}
				onPointerDown={beginSwipe}
				onPointerMove={updateSwipe}
				onPointerUp={endSwipe}
				onPointerCancel={cancelSwipe}
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
							if (suppressIfDragged()) return;
							entry.onClick?.();
							onDismiss(entry.id);
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
					onPointerDown={(event) => event.stopPropagation()}
					onClick={() => {
						if (suppressIfDragged()) return;
						onDismiss(entry.id);
					}}
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
}
