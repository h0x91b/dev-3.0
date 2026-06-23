import { useEffect, useState } from "react";

export type ToastVariant = "error" | "success" | "info" | "warning";

interface ToastEntry {
	id: number;
	message: string;
	variant: ToastVariant;
	durationMs: number;
	/** Optional click handler — makes the whole toast a button (e.g. navigate to a task). */
	onClick?: () => void;
	/** Optional source line shown above the message (e.g. "#804 · project · task title"). */
	context?: string;
}

type Listener = (entry: ToastEntry) => void;

const listeners = new Set<Listener>();
let counter = 0;

/** Default auto-dismiss delay. Long on purpose so error messages aren't missed. */
const DEFAULT_DURATION_MS = 30_000;

function emit(message: string, variant: ToastVariant, opts?: ToastOpts) {
	const entry: ToastEntry = {
		id: ++counter,
		message,
		variant,
		durationMs: opts?.durationMs ?? DEFAULT_DURATION_MS,
		onClick: opts?.onClick,
		context: opts?.context,
	};
	// No host mounted (e.g. in unit tests) → silently drop.
	listeners.forEach((l) => l(entry));
}

interface ToastOpts {
	durationMs?: number;
	/** When set, the toast becomes clickable and runs this on click (then dismisses). */
	onClick?: () => void;
	/** Optional source line shown above the message (e.g. "#804 · project · task title"). */
	context?: string;
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

const VARIANT: Record<ToastVariant, { icon: string; border: string; text: string; bar: string }> = {
	error: { icon: "\uf06a", border: "border-danger/40", text: "text-danger", bar: "bg-danger" },
	success: { icon: "\uf058", border: "border-success/40", text: "text-success", bar: "bg-success" },
	info: { icon: "\uf05a", border: "border-accent/40", text: "text-accent", bar: "bg-accent" },
	warning: { icon: "\uf071", border: "border-warning/40", text: "text-warning", bar: "bg-warning" },
};

export function ToastHost() {
	const [toasts, setToasts] = useState<ToastEntry[]>([]);

	useEffect(() => {
		const listener: Listener = (entry) => {
			setToasts((prev) => [...prev, entry]);
			setTimeout(() => {
				setToasts((prev) => prev.filter((t) => t.id !== entry.id));
			}, entry.durationMs);
		};
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}, []);

	if (!toasts.length) return null;

	const dismiss = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

	return (
		<div className="fixed top-14 right-4 z-[55] flex flex-col gap-2.5 pointer-events-none">
			{toasts.map((toastEntry) => {
				const v = VARIANT[toastEntry.variant];
				return (
					<div key={toastEntry.id} className="pointer-events-auto animate-slide-in-right" role="alert">
						<div
							className={`relative overflow-hidden bg-overlay border ${v.border} rounded-xl shadow-2xl w-[26rem] max-w-[calc(100vw-2rem)] flex items-start gap-3 p-4`}
						>
							<span
								className={`${v.text} text-2xl leading-none mt-0.5 flex-shrink-0`}
								style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							>
								{v.icon}
							</span>
							{toastEntry.onClick ? (
								<button
									type="button"
									onClick={() => {
										toastEntry.onClick?.();
										dismiss(toastEntry.id);
									}}
									className="flex-1 min-w-0 text-left pr-1 cursor-pointer group"
								>
									{toastEntry.context && (
										<div className="text-[0.6875rem] font-mono text-fg-muted truncate mb-0.5">
											{toastEntry.context}
										</div>
									)}
									<div className="text-fg text-sm leading-relaxed break-words group-hover:underline">
										{toastEntry.message}
									</div>
								</button>
							) : (
								<div className="flex-1 min-w-0 pr-1">
									{toastEntry.context && (
										<div className="text-[0.6875rem] font-mono text-fg-muted truncate mb-0.5">
											{toastEntry.context}
										</div>
									)}
									<div className="text-fg text-sm leading-relaxed break-words">
										{toastEntry.message}
									</div>
								</div>
							)}
							<button
								type="button"
								onClick={() => dismiss(toastEntry.id)}
								aria-label="Dismiss"
								className="text-fg-muted hover:text-fg transition-colors flex-shrink-0"
							>
								<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
								</svg>
							</button>
							<div
								className={`absolute bottom-0 left-0 h-0.5 ${v.bar} opacity-50`}
								style={{ animation: `toast-shrink ${toastEntry.durationMs}ms linear forwards` }}
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
}
