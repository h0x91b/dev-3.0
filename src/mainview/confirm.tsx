import { useEffect, useState } from "react";
import type { Label, TaskPriority } from "../shared/types";
import LabelChip from "./components/LabelChip";
import PriorityBadge from "./components/PriorityBadge";
import { useT } from "./i18n";
import { useFocusTrap } from "./utils/useFocusTrap";

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

	// Render the dialog as a child keyed by request id so it genuinely
	// mounts/unmounts per confirm — that's what lets useFocusTrap capture the
	// right trigger element and restore focus when the dialog closes (the host
	// itself is mounted for the whole app lifetime).
	return <ConfirmDialog key={pending.id} pending={pending} close={close} />;
}

function ConfirmDialog({ pending, close }: { pending: PendingConfirm; close: (result: boolean) => void }) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();

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
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				tabIndex={-1}
				className={`bg-overlay border rounded-2xl shadow-2xl w-[26.25rem] p-6 space-y-4 outline-none ${
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
						{pending.info.labels && pending.info.labels.length > 0 && (
							<div className="flex items-center flex-wrap gap-1 mt-2">
								{pending.info.labels.map((label) => (
									<LabelChip key={label.id} label={label} size="sm" />
								))}
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
