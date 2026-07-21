import { useEffect, useState } from "react";
import type { Label, TaskPriority } from "../shared/types";
import LabelChip from "./components/LabelChip";
import PriorityBadge from "./components/PriorityBadge";
import { useT } from "./i18n";
import { useFocusTrap } from "./utils/useFocusTrap";

export interface ConfirmAlternativeAction {
	label: string;
	value: string;
}

export interface ConfirmOutcomeCards {
	kicker: string;
	statusLabel: string;
	statusValue: string;
	confirmDescription: string;
	cancelDescription: string;
	alternativeDescription: string;
}

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
	 *
	 * The optional metadata (`seqLabel`, `projectName`, `priority`, `labels`)
	 * renders a compact identity row above the title so a session-destroying
	 * prompt makes clear which project/task it targets — critical when the
	 * dialog fires while the user is looking at a different project's board.
	 */
	info?: {
		title: string;
		body?: string;
		/** Per-project task id, variant suffix included (e.g. `"1159"`, `"1159-1"`). */
		seqLabel?: string;
		/** Owning project's display name. */
		projectName?: string;
		/** Task importance band, shown as a static `P{n}` badge. */
		priority?: TaskPriority;
		/** Resolved task labels; shown as read-only chips below the body. */
		labels?: Label[];
	};
	/**
	 * Close the dialog externally, without a user choice — e.g. the underlying
	 * task was resolved on another window or on the remote browser. When the
	 * signal aborts, the dialog closes and the promise resolves `false`; callers
	 * that must tell this apart from a real decline should check `signal.aborted`
	 * after awaiting and skip their own resolution side effects.
	 */
	signal?: AbortSignal;
	/** Optional neutral action that resolves with a string value. */
	alternativeAction?: ConfirmAlternativeAction;
	/** Render the three actions as consequence-explaining cards. */
	outcomeCards?: ConfirmOutcomeCards;
	/** Defaults to true. Disable when closing without a choice would be ambiguous. */
	dismissOnBackdrop?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
	id: number;
	resolve: (value: boolean | string) => void;
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
export function confirm(options: ConfirmOptions & { alternativeAction: ConfirmAlternativeAction }): Promise<boolean | string>;
export function confirm(options: ConfirmOptions): Promise<boolean>;
export function confirm(options: ConfirmOptions): Promise<boolean | string> {
	return new Promise((resolve) => {
		if (!listener) {
			resolve(false);
			return;
		}
		listener({ ...options, id: ++counter, resolve });
	});
}

export function ConfirmHost() {
	const [pending, setPending] = useState<PendingConfirm | null>(null);

	useEffect(() => {
		listener = setPending;
		return () => {
			listener = null;
		};
	}, []);

	if (!pending) return null;

	const close = (result: boolean | string) => {
		pending.resolve(result);
		setPending(null);
	};

	// Render the dialog as a child keyed by request id so it genuinely
	// mounts/unmounts per confirm — that's what lets useFocusTrap capture the
	// right trigger element and restore focus when the dialog closes (the host
	// itself is mounted for the whole app lifetime).
	return <ConfirmDialog key={pending.id} pending={pending} close={close} />;
}

function ConfirmDialog({ pending, close }: { pending: PendingConfirm; close: (result: boolean | string) => void }) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();

	const confirmLabel = pending.confirmLabel ?? t("confirmDialog.confirm");
	const cancelLabel = pending.cancelLabel ?? t("confirmDialog.cancel");

	// Auto-close when the caller's signal aborts (task resolved elsewhere).
	useEffect(() => {
		const signal = pending.signal;
		if (!signal) return;
		if (signal.aborted) {
			close(false);
			return;
		}
		const onAbort = () => close(false);
		signal.addEventListener("abort", onAbort);
		return () => signal.removeEventListener("abort", onAbort);
	}, [pending.signal, close]);

	return (
		<div
			className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget && pending.dismissOnBackdrop !== false) close(false);
			}}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				tabIndex={-1}
				className={`bg-overlay border rounded-2xl shadow-2xl max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-y-auto p-6 space-y-4 outline-none ${
					pending.outcomeCards ? "w-[34rem]" : pending.alternativeAction ? "w-[30rem]" : "w-[26.25rem]"
				} ${
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
				{pending.outcomeCards && (
					<div className="inline-flex items-center gap-2 text-success text-xs font-semibold uppercase tracking-[0.08em]">
						<span className="grid h-5 w-5 place-items-center rounded-full bg-success/15 text-sm leading-none" aria-hidden>
							✓
						</span>
						{pending.outcomeCards.kicker}
					</div>
				)}
				<h2 className={`text-fg font-semibold ${pending.outcomeCards ? "text-xl tracking-[-0.015em]" : "text-lg"}`}>
					{pending.title}
				</h2>
				{pending.outcomeCards && (
					<p className="text-fg-2 text-sm leading-relaxed whitespace-pre-line">{pending.message}</p>
				)}
				{pending.info && (
					<div className={`rounded-xl border px-4 py-3 ${pending.outcomeCards ? "bg-elevated/70 border-edge" : "bg-accent/10 border-accent/30"}`}>
						{/* Identity row: which project/task this prompt is about. */}
						{(pending.info.seqLabel || pending.info.projectName || pending.info.priority) && (
							<div className="flex items-center flex-wrap gap-x-2 gap-y-1 mb-2 text-fg-3 text-xs">
								{pending.info.seqLabel && (
									<span className="font-mono text-fg-2">{`#${pending.info.seqLabel}`}</span>
								)}
								{pending.info.projectName && (
									<>
										{pending.info.seqLabel && <span aria-hidden>·</span>}
										<span className="truncate max-w-[12rem]">{pending.info.projectName}</span>
									</>
								)}
								{pending.info.priority && (
									<PriorityBadge priority={pending.info.priority} size="sm" className="ml-auto" />
								)}
							</div>
						)}
						<div className="flex items-start gap-2">
							<span
								className={`${pending.outcomeCards ? "text-fg-3" : "text-accent"} text-[1.0625rem] leading-snug`}
								style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							>
								{"\u{F0AE2}"}
							</span>
							{/* `text-base` is unusable here: the project defines a `base` color
							    token, so Tailwind also emits text-base as a COLOR utility that
							    overrides text-accent. Use an arbitrary font-size instead. */}
							<div className={`${pending.outcomeCards ? "text-fg" : "text-accent"} text-[1.0625rem] font-semibold leading-snug`}>
								{pending.info.title}
							</div>
						</div>
						{pending.info.body && (
							<div className="text-fg-2 text-sm leading-relaxed mt-1.5 whitespace-pre-line">
								{pending.info.body}
							</div>
						)}
						{pending.info.labels && pending.info.labels.length > 0 && (
							<div className="flex items-center flex-wrap gap-1 mt-2">
								{pending.info.labels.map((label) => (
									<LabelChip key={label.id} label={label} size="sm" />
								))}
							</div>
						)}
					</div>
				)}
				{pending.outcomeCards && (
					<div className="flex min-w-0 items-center gap-2 rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-xs">
						<span className="text-success" aria-hidden>✓</span>
						<span className="font-medium text-fg-2">{pending.outcomeCards.statusLabel}</span>
						<span className="min-w-0 truncate font-mono text-fg-3">{pending.outcomeCards.statusValue}</span>
					</div>
				)}
				{!pending.outcomeCards && <p className="text-fg-2 text-sm leading-relaxed whitespace-pre-line">{pending.message}</p>}
				{pending.outcomeCards && pending.alternativeAction ? (
					<div className="grid gap-2 pt-1">
						<OutcomeAction
							id={`confirm-${pending.id}-complete`}
							icon="✓"
							label={confirmLabel}
							description={pending.outcomeCards.confirmDescription}
							primary
							onClick={() => close(true)}
						/>
						<OutcomeAction
							id={`confirm-${pending.id}-later`}
							icon="↻"
							label={cancelLabel}
							description={pending.outcomeCards.cancelDescription}
							onClick={() => close(false)}
						/>
						<OutcomeAction
							id={`confirm-${pending.id}-manual`}
							icon="◎"
							label={pending.alternativeAction.label}
							description={pending.outcomeCards.alternativeDescription}
							onClick={() => close(pending.alternativeAction!.value)}
						/>
					</div>
				) : (
					<div className="flex flex-wrap justify-end gap-2 pt-1">
					<button
						type="button"
						autoFocus={pending.agentInitiated}
						onClick={() => close(false)}
						className="px-4 py-2 text-sm whitespace-nowrap rounded-lg text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
					>
						{cancelLabel}
					</button>
					{pending.alternativeAction && (
						<button
							type="button"
							onClick={() => close(pending.alternativeAction!.value)}
							className="px-4 py-2 text-sm whitespace-nowrap rounded-lg border border-edge text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
						>
							{pending.alternativeAction.label}
						</button>
					)}
					<button
						type="button"
						onClick={() => close(true)}
						className={
							pending.danger
								? "px-4 py-2 text-sm whitespace-nowrap rounded-lg bg-danger text-white hover:bg-danger/80 transition-colors"
								: "px-4 py-2 text-sm whitespace-nowrap rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
						}
					>
						{confirmLabel}
					</button>
					</div>
				)}
			</div>
		</div>
	);
}

function OutcomeAction({
	id,
	icon,
	label,
	description,
	primary = false,
	onClick,
}: {
	id: string;
	icon: string;
	label: string;
	description: string;
	primary?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-labelledby={`${id}-label`}
			aria-describedby={`${id}-description`}
			className={`group flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors ${
				primary
					? "border-accent/60 bg-accent/10 hover:border-accent hover:bg-accent/15"
					: "border-edge bg-elevated/55 hover:border-edge-active hover:bg-elevated"
			}`}
		>
			<span
				className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sm font-semibold transition-colors ${
					primary ? "bg-accent text-white" : "bg-raised text-fg-2 group-hover:text-fg"
				}`}
				aria-hidden
			>
				{icon}
			</span>
			<span className="min-w-0 flex-1">
				<span id={`${id}-label`} className="block text-sm font-semibold text-fg">{label}</span>
				<span id={`${id}-description`} className="mt-0.5 block text-xs leading-relaxed text-fg-3">{description}</span>
			</span>
			<span className="text-lg leading-none text-fg-muted transition-transform group-hover:translate-x-0.5 group-hover:text-fg-2" aria-hidden>›</span>
		</button>
	);
}
