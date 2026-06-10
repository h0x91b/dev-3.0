import { useEffect, useState } from "react";
import { useT } from "./i18n";

export interface ConfirmOptions {
	title: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
	/** Style the confirm button as destructive (red). */
	danger?: boolean;
	/**
	 * Mark the dialog as initiated by an AI agent, not by the user's own click:
	 * shows a robot badge, an accent border, and autofocuses Cancel so muscle
	 * memory cannot accidentally approve a session-destroying request.
	 */
	agentInitiated?: boolean;
	/**
	 * Optional highlighted subject card rendered between the title and the
	 * message — an accent-tinted panel with a prominent title (e.g. the task
	 * name) and an optional secondary line (e.g. the task overview). Use it
	 * when the dialog is *about* a specific object the user must recognize.
	 */
	info?: { title: string; body?: string };
}

interface PendingConfirm extends ConfirmOptions {
	id: number;
	resolve: (value: boolean) => void;
}

let listener: ((req: PendingConfirm | null) => void) | null = null;
let counter = 0;

/**
 * Imperative, promise-based confirmation dialog — the in-app replacement for
 * the old native `showConfirm` RPC (`Utils.showMessageBox`) and `window.confirm`.
 *
 * Works identically in the Electrobun desktop shell and in headless remote
 * (browser) mode because it renders as plain React. Callable from anywhere —
 * components, hooks, and plain util modules — since it is module-level.
 *
 * Requires `<ConfirmHost />` to be mounted once (in `App.tsx`). If it is not
 * mounted, the promise resolves `false` (fail-closed) instead of blocking.
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => {
		if (!listener) {
			resolve(false);
			return;
		}
		listener({ ...options, id: ++counter, resolve });
	});
}

export function ConfirmHost() {
	const t = useT();
	const [pending, setPending] = useState<PendingConfirm | null>(null);

	useEffect(() => {
		listener = setPending;
		return () => {
			listener = null;
		};
	}, []);

	if (!pending) return null;

	const close = (result: boolean) => {
		pending.resolve(result);
		setPending(null);
	};

	const confirmLabel = pending.confirmLabel ?? t("confirmDialog.confirm");
	const cancelLabel = pending.cancelLabel ?? t("confirmDialog.cancel");

	return (
		<div
			className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) close(false);
			}}
		>
			<div
				className={`bg-overlay border rounded-2xl shadow-2xl w-[26.25rem] p-6 space-y-4 ${
					pending.agentInitiated ? "border-accent/40" : "border-edge"
				}`}
			>
				{pending.agentInitiated && (
					<div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent/15 text-accent text-xs font-medium">
						<span
							className="text-sm leading-none"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
						>
							{"\u{F06A9}"}
						</span>
						{t("confirmDialog.agentBadge")}
					</div>
				)}
				<h2 className="text-fg text-lg font-semibold">{pending.title}</h2>
				{pending.info && (
					<div className="rounded-xl bg-accent/10 border border-accent/30 px-4 py-3">
						<div className="flex items-start gap-2">
							<span
								className="text-accent text-[1.0625rem] leading-snug"
								style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							>
								{"\u{F0AE2}"}
							</span>
							{/* `text-base` is unusable here: the project defines a `base` color
							    token, so Tailwind also emits text-base as a COLOR utility that
							    overrides text-accent. Use an arbitrary font-size instead. */}
							<div className="text-accent text-[1.0625rem] font-semibold leading-snug">
								{pending.info.title}
							</div>
						</div>
						{pending.info.body && (
							<div className="text-fg-2 text-sm leading-relaxed mt-1.5 whitespace-pre-line">
								{pending.info.body}
							</div>
						)}
					</div>
				)}
				<p className="text-fg-2 text-sm leading-relaxed whitespace-pre-line">{pending.message}</p>
				<div className="flex justify-end gap-2 pt-1">
					<button
						type="button"
						autoFocus={pending.agentInitiated}
						onClick={() => close(false)}
						className="px-4 py-2 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
					>
						{cancelLabel}
					</button>
					<button
						type="button"
						onClick={() => close(true)}
						className={
							pending.danger
								? "px-4 py-2 text-sm rounded-lg bg-danger text-white hover:bg-danger/80 transition-colors"
								: "px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
						}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}
