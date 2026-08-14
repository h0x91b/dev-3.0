import { useEffect, useRef, useState } from "react";
import type { TFunction } from "../../i18n";
import type { ShortcutSlot } from "../../../shared/types";
import {
	bindingChips,
	bindingFromEvent,
	isBrowserReserved,
	rejectBinding,
	type Binding,
} from "../../keymap-bindings";
import {
	findConflict,
	isRemappable,
	shortcutById,
	shortcutKeysForMode,
	slotBindings,
	type ShortcutSpec,
} from "../../keymap";
import { hasOverride, setKeymapCapture } from "../../keymap-store";
import { isMac } from "../../utils/platform";

/** The project's button feel: explicit properties, 150ms ease-out, press scale. */
const PRESS =
	"outline-none focus-visible:ring-2 focus-visible:ring-accent/50 transition-[color,background-color,border-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96]";

type ChipTone = "normal" | "live";

/** One key pill. `tone` follows the slot's state, not a separate palette. */
function Chip({ children, tone }: { children: string; tone: ChipTone }) {
	const skin = {
		normal: "bg-raised border-edge text-fg-2",
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
function Combo({ chips, tone }: { chips: string[]; tone: ChipTone }) {
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
	/** Commit a rebind of one slot. `null` empties it; `undefined` restores its default. */
	onRebind: (id: string, slot: ShortcutSlot, binding: Binding | null) => void;
	/** Restore both slots of this shortcut to their defaults. */
	onReset: (id: string) => void;
}

export default function ShortcutRow({ spec, t, remote, onRebind, onReset }: ShortcutRowProps) {
	const mac = isMac();
	const [recording, setRecording] = useState<ShortcutSlot | null>(null);
	const [candidate, setCandidate] = useState<Binding | null>(null);
	const [rejected, setRejected] = useState(false);
	const primaryRef = useRef<HTMLButtonElement>(null);
	const aliasRef = useRef<HTMLButtonElement>(null);

	const remappable = isRemappable(spec);
	const overridden = hasOverride(spec.id);
	const conflict = candidate ? findConflict(spec.id, candidate) : null;
	const conflictSpec = conflict ? shortcutById(conflict.ownerId) : undefined;

	// The recorder owns the keyboard while it is open — see `setKeymapCapture`.
	useEffect(() => {
		setKeymapCapture(recording !== null);
		return () => setKeymapCapture(false);
	}, [recording]);

	function stopRecording(slot: ShortcutSlot | null) {
		setRecording(null);
		setCandidate(null);
		setRejected(false);
		(slot === "alias" ? aliasRef : primaryRef).current?.focus();
	}

	/**
	 * While recording, this slot owns the keyboard: every keystroke is a candidate
	 * combo, not a command. Capture phase, because the app dispatcher also listens
	 * on window and would otherwise fire the very shortcut being rebound.
	 */
	useEffect(() => {
		if (!recording) return;
		const slot = recording;
		function onKeyDown(e: KeyboardEvent) {
			e.preventDefault();
			e.stopPropagation();
			if (e.code === "Escape") {
				stopRecording(slot);
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
		if (!candidate || !recording) return;
		onRebind(spec.id, recording, candidate);
		stopRecording(recording);
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
						<div className="text-fg-3 text-xs mt-0.5">{t(spec.fixedReasonKey)}</div>
					) : null}
				</div>
				<div className="shrink-0 flex items-center justify-end gap-1.5">
					<span className="px-2 h-7 inline-flex items-center rounded-md border border-edge text-fg-3 text-xs">
						{shortcutKeysForMode(spec, mac, remote)}
					</span>
					{/* Matches the alias + reset slots on editable rows, so nothing in the
					    combo column wanders off the shared vertical lines. */}
					<span className="min-w-[7.5rem]" />
					<span className="w-7 h-7" />
				</div>
			</div>
		);
	}

	// A combo the browser keeps is a warning, not a refusal: the user may be
	// binding it for the desktop app, and Keyboard Lock hands it back in
	// fullscreen. Refusing it outright would be us guessing at their intent.
	const browserTaken = remote && candidate ? isBrowserReserved(candidate) : false;

	const meta = recording
		? rejected
			? { text: t("keymap.edit.rejectedReserved"), danger: true }
			: conflictSpec
				? { text: t("keymap.edit.conflict", { name: t(conflictSpec.descKey) }), danger: true }
				: browserTaken
					? { text: t("keymap.edit.browserReserved"), danger: true }
					: { text: t("keymap.edit.recordingHint"), danger: false }
		: spec.scope === "desktop"
			? { text: t("keymap.edit.desktopOnly"), danger: false }
			: remote && spec.remoteDisplay
				? { text: t("keymap.edit.inBrowser", { keys: shortcutKeysForMode(spec, mac, true) }), danger: false }
				: null;

	/**
	 * One slot. The chips ARE the control — a separate "Change" button on every
	 * slot of every row is button creep, and the keys already say what to click.
	 */
	function Slot({ slot }: { slot: ShortcutSlot }) {
		const bindings = slotBindings(spec, slot);
		const isAlias = slot === "alias";
		const live = recording === slot;

		if (live && candidate) {
			return (
				<span className="inline-flex items-center gap-1.5">
					<Combo chips={bindingChips(candidate, mac)} tone="live" />
					<button
						type="button"
						onClick={commit}
						className={`px-2.5 h-7 rounded-md bg-accent-fill hover:bg-accent-fill-hover text-white text-xs font-medium ${PRESS}`}
					>
						{t("keymap.edit.save")}
					</button>
					<button
						type="button"
						onClick={() => stopRecording(slot)}
						className={`px-2.5 h-7 rounded-md border border-edge text-fg-3 text-xs hover:border-edge-active ${PRESS}`}
					>
						{t("keymap.edit.cancel")}
					</button>
				</span>
			);
		}
		if (live) {
			return (
				<span className="inline-flex items-center gap-1.5">
					<span className="px-2.5 h-7 inline-flex items-center rounded-md border border-accent/50 bg-accent/10 text-fg-2 text-xs">
						{t("keymap.edit.recording")}
					</span>
					<button
						type="button"
						onClick={() => stopRecording(slot)}
						className={`px-2.5 h-7 rounded-md border border-edge text-fg-3 text-xs hover:border-edge-active ${PRESS}`}
					>
						{t("keymap.edit.cancel")}
					</button>
				</span>
			);
		}

		const label = isAlias
			? t("keymap.edit.a11yRecordAlias", { name: description })
			: t("keymap.edit.a11yRecord", { name: description });

		return (
			<span className="inline-flex items-center gap-1">
				<button
					ref={isAlias ? aliasRef : primaryRef}
					type="button"
					title={isAlias ? t("keymap.edit.aliasHint") : t("keymap.edit.record")}
					aria-label={label}
					onClick={() => {
						setCandidate(null);
						setRejected(false);
						setRecording(slot);
					}}
					className={`px-1 py-0.5 -mx-1 rounded-lg border border-transparent hover:border-edge-active hover:bg-raised ${PRESS}`}
				>
					{bindings.length > 0 ? (
						// More than one entry here means platform variants, never an alias —
						// only one of them can apply, so they never both render.
						<Combo chips={bindingChips(bindings[0], mac)} tone="normal" />
					) : isAlias ? (
						// An empty alias is the normal resting state, so it stays quiet: a
						// dashed "+" that only firms up on hover.
						<span className="w-7 h-7 grid place-items-center rounded-md border border-dashed border-edge/70 text-fg-muted text-xs group-hover:border-edge-active">
							+
						</span>
					) : (
						<span className="px-1.5 h-7 inline-flex items-center rounded-md border border-dashed border-edge text-fg-3 text-xs italic">
							{t("keymap.edit.unassigned")}
						</span>
					)}
				</button>
				{bindings.length > 0 && isAlias ? (
					<button
						type="button"
						title={t("keymap.edit.clearAlias")}
						aria-label={t("keymap.edit.clearAlias")}
						onClick={() => onRebind(spec.id, slot, null)}
						className={`w-5 h-5 grid place-items-center rounded text-fg-3 hover:text-danger hover:bg-danger/10 text-xs leading-none ${PRESS}`}
					>
						×
					</button>
				) : null}
			</span>
		);
	}

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
						className={`text-xs mt-0.5 ${meta.danger ? "text-danger" : "text-fg-3"}`}
						role={recording ? "status" : undefined}
						aria-live={recording ? "polite" : undefined}
					>
						{meta.text}
					</div>
				) : null}
			</div>

			<div className="shrink-0 flex items-center justify-end gap-1.5">
				<Slot slot="primary" />
				{/* The alias column keeps its width whether or not it holds anything, so
				    the primary combos stay on one vertical line down the whole list. */}
				<span className="min-w-[7.5rem] flex items-center justify-end">
					{recording === "primary" ? null : <Slot slot="alias" />}
				</span>
				{/* Reserved even with nothing to restore — same reason. */}
				<span className="w-7 h-7 flex items-center justify-center">
					{overridden && !recording ? (
						<button
							type="button"
							title={t("keymap.edit.reset")}
							aria-label={t("keymap.edit.reset")}
							onClick={() => onReset(spec.id)}
							className={`w-7 h-7 grid place-items-center rounded-md text-fg-3 hover:text-danger hover:bg-danger/10 focus-visible:ring-danger/50 ${PRESS}`}
						>
							<ResetIcon />
						</button>
					) : null}
				</span>
			</div>
		</div>
	);
}
