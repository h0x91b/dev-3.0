import { useEffect, useRef, useState } from "react";
import type { TFunction } from "../../i18n";
import {
	bindingChips,
	bindingFromEvent,
	rejectBinding,
	type Binding,
} from "../../keymap-bindings";
import {
	bindingsFor,
	findConflict,
	isRemappable,
	shortcutById,
	shortcutKeysForMode,
	type ShortcutSpec,
} from "../../keymap";
import { hasOverride, setKeymapCapture } from "../../keymap-store";
import { isMac } from "../../utils/platform";

/** The project's button feel: explicit properties, 150ms ease-out, press scale. */
const PRESS =
	"outline-none focus-visible:ring-2 focus-visible:ring-accent/50 transition-[color,background-color,border-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96]";

/** Keeps the combo column from shifting when chips swap for the recording pill. */
const COMBO_COL = "shrink-0 flex items-center justify-end gap-1.5 min-w-[10.5rem]";

/** One key pill. `tone` follows the row's state, not a separate palette. */
function Chip({ children, tone }: { children: string; tone: "normal" | "muted" | "live" }) {
	const skin = {
		normal: "bg-raised border-edge text-fg-2",
		muted: "bg-base border-edge/50 text-fg-muted",
		live: "bg-accent/15 border-accent/40 text-fg",
	}[tone];
	return (
		<kbd
			className={`px-1.5 min-w-[1.75rem] h-7 inline-flex items-center justify-center rounded-md border text-xs font-medium ${skin}`}
		>
			{children}
		</kbd>
	);
}

/** A combo as key pills (`⇧` `⌘` `P`), so it reads as keys rather than as text. */
function Combo({ chips, tone }: { chips: string[]; tone: "normal" | "muted" | "live" }) {
	return (
		<span className="inline-flex items-center gap-1">
			{chips.map((chip, i) => (
				<Chip key={`${chip}-${i}`} tone={tone}>
					{chip}
				</Chip>
			))}
		</span>
	);
}

function ResetIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
			<path
				d="M2.2 5.6h3.2M2.2 5.6V2.4M2.6 8.4a4.6 4.6 0 1 0 .4-4.3"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

interface ShortcutRowProps {
	spec: ShortcutSpec;
	t: TFunction;
	remote: boolean;
	/** Commit a rebind. `null` restores the default. */
	onRebind: (id: string, bindings: Binding[] | null) => void;
}

export default function ShortcutRow({ spec, t, remote, onRebind }: ShortcutRowProps) {
	const mac = isMac();
	const [recording, setRecording] = useState(false);
	const [candidate, setCandidate] = useState<Binding | null>(null);
	const [rejected, setRejected] = useState(false);
	const comboRef = useRef<HTMLButtonElement>(null);

	const remappable = isRemappable(spec);
	const bindings = bindingsFor(spec);
	const overridden = hasOverride(spec.id);
	const conflict = candidate ? findConflict(spec.id, candidate) : null;
	const conflictSpec = conflict ? shortcutById(conflict.ownerId) : undefined;

	// The recorder owns the keyboard while it is open — see `setKeymapCapture`.
	useEffect(() => {
		setKeymapCapture(recording);
		return () => setKeymapCapture(false);
	}, [recording]);

	function stopRecording() {
		setRecording(false);
		setCandidate(null);
		setRejected(false);
	}

	/**
	 * While recording, this row owns the keyboard: every keystroke is a candidate
	 * combo, not a command. Capture phase, because the app dispatcher also listens
	 * on window and would otherwise fire the very shortcut being rebound.
	 */
	useEffect(() => {
		if (!recording) return;
		function onKeyDown(e: KeyboardEvent) {
			e.preventDefault();
			e.stopPropagation();
			if (e.code === "Escape") {
				stopRecording();
				comboRef.current?.focus();
				return;
			}
			const next = bindingFromEvent(e, mac);
			if (!next) return; // still holding modifiers — keep waiting
			if (rejectBinding(next)) {
				setRejected(true);
				setCandidate(null);
				return;
			}
			setRejected(false);
			setCandidate(next);
		}
		window.addEventListener("keydown", onKeyDown, { capture: true });
		return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
	}, [recording, mac]);

	function commit() {
		if (!candidate) return;
		onRebind(spec.id, [candidate]);
		stopRecording();
		comboRef.current?.focus();
	}

	const description = t(spec.descKey);
	const rowBase =
		"group flex items-center justify-between gap-4 -mx-2 px-2 py-2 rounded-lg transition-colors duration-150";

	// ── Fixed row: shown, greyed, with the reason. Hiding it would read as a
	// keymap with holes rather than a keymap with rules. ──
	if (!remappable) {
		return (
			<div className={rowBase}>
				<div className="min-w-0">
					<div className="text-fg-3 text-sm">{description}</div>
					{spec.fixedReasonKey ? (
						<div className="text-fg-muted text-xs mt-0.5">{t(spec.fixedReasonKey)}</div>
					) : null}
				</div>
				<div className={COMBO_COL}>
					<span className="px-2 h-7 inline-flex items-center rounded-md border border-edge/50 bg-base text-fg-muted text-xs">
						{shortcutKeysForMode(spec, mac, remote)}
					</span>
					{/* Matches the reset slot on editable rows, so every combo in the list
					    ends on the same vertical line. */}
					<span className="w-7 h-7" />
				</div>
			</div>
		);
	}

	const meta = recording
		? rejected
			? { text: t("keymap.edit.rejectedReserved"), danger: true }
			: conflictSpec
				? { text: t("keymap.edit.conflict", { name: t(conflictSpec.descKey) }), danger: true }
				: { text: t("keymap.edit.recordingHint"), danger: false }
		: spec.scope === "desktop"
			? { text: t("keymap.edit.desktopOnly"), danger: false }
			: null;

	return (
		<div className={`${rowBase} ${recording ? "bg-accent/5" : "hover:bg-raised/50"}`}>
			<div className="min-w-0">
				<div className="flex items-center gap-1.5">
					{overridden ? (
						<span
							className="w-1.5 h-1.5 rounded-full bg-accent shrink-0"
							title={t("keymap.edit.customized")}
						/>
					) : null}
					{/* Wraps rather than truncates: a clipped shortcut name is unusable,
					    and a couple of these carry a legend in the name. */}
					<span className="text-fg-2 text-sm">{description}</span>
				</div>
				{meta ? (
					<div
						className={`text-xs mt-0.5 ${meta.danger ? "text-danger" : "text-fg-muted"}`}
						role={recording ? "status" : undefined}
						aria-live={recording ? "polite" : undefined}
					>
						{meta.text}
					</div>
				) : null}
			</div>

			<div className={COMBO_COL}>
				{recording && candidate ? (
					<>
						<Combo chips={bindingChips(candidate, mac)} tone="live" />
						<button
							type="button"
							onClick={commit}
							className={`px-2.5 h-7 rounded-md bg-accent-fill hover:bg-accent-fill-hover text-white text-xs font-medium ${PRESS}`}
						>
							{t("keymap.edit.save")}
						</button>
					</>
				) : recording ? (
					<span className="px-2.5 h-7 inline-flex items-center rounded-md border border-accent/50 bg-accent/10 text-fg-2 text-xs">
						{t("keymap.edit.recording")}
					</span>
				) : (
					// The combo itself is the control — 33 rows with a separate "Change"
					// button each is button creep, and the chips already say what to click.
					<button
						ref={comboRef}
						type="button"
						title={t("keymap.edit.record")}
						aria-label={t("keymap.edit.a11yRecord", { name: description })}
						onClick={() => setRecording(true)}
						className={`px-1 py-0.5 -mx-1 rounded-lg border border-transparent hover:border-edge-active hover:bg-raised ${PRESS}`}
					>
						{bindings.length > 0 ? (
							// Alternatives need a visible break — two adjacent chip runs read
							// as one long combo (`⌘ [ ⌃ -` instead of `⌘[` or `⌃-`).
							<span className="inline-flex items-center gap-1.5">
								{bindings.map((b, i) => (
									<span key={i} className="inline-flex items-center gap-1.5">
										{i > 0 ? <span className="text-fg-muted text-xs">/</span> : null}
										<Combo chips={bindingChips(b, mac)} tone="normal" />
									</span>
								))}
							</span>
						) : (
							<span className="px-1.5 h-7 inline-flex items-center rounded-md border border-dashed border-edge text-fg-muted text-xs italic">
								{t("keymap.edit.unassigned")}
							</span>
						)}
					</button>
				)}

				{recording ? (
					<button
						type="button"
						onClick={() => {
							stopRecording();
							comboRef.current?.focus();
						}}
						className={`px-2.5 h-7 rounded-md border border-edge text-fg-3 text-xs hover:border-edge-active ${PRESS}`}
					>
						{t("keymap.edit.cancel")}
					</button>
				) : (
					// Reserve the slot even when there is nothing to restore, so the combo
					// column stays on one vertical line down the whole list.
					<span className="w-7 h-7 flex items-center justify-center">
						{overridden ? (
							<button
								type="button"
								title={t("keymap.edit.reset")}
								aria-label={t("keymap.edit.reset")}
								onClick={() => onRebind(spec.id, null)}
								className={`w-7 h-7 grid place-items-center rounded-md text-fg-muted hover:text-danger hover:bg-danger/10 focus-visible:ring-danger/50 ${PRESS}`}
							>
								<ResetIcon />
							</button>
						) : null}
					</span>
				)}
			</div>
		</div>
	);
}
