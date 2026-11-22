import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useT } from "../i18n";
import { MASK_CLASS } from "../sensitive-projects";
import { mixedEntryId, type DigitSlot, type MixedEntry } from "../utils/digitOrder";
import { digitKeyLabel } from "../utils/platform";

const SLOTS = 9;

/** What every key chip on the dashboard reads: the keys, their pins, and how to change them. */
export interface DigitKeys {
	/** What each key opens right now, pins and default fill together. */
	targets: DigitSlot[];
	/** The pinned entry per key, null where the key follows the default order. */
	pins: DigitSlot[];
	/** Any pin stored, ones that no longer resolve included — what `Unpin all` clears. */
	anyStored: boolean;
	/** Ids a key can be pinned to. */
	pinnable: Set<string>;
	isMasked: (entry: MixedEntry) => boolean;
	/** Pin `id` to key `index` (0-based); null puts the key back on the default order. */
	onPin: (index: number, id: string | null) => void;
	onUnpinAll: () => void;
}

export const DigitKeysContext = createContext<DigitKeys | null>(null);

/** Hover group a row or header sets so its empty key chip shows on hover. */
export const DIGIT_KEY_GROUP = "group/digit";

const entryName = (entry: MixedEntry) => (entry.kind === "space" ? entry.space.name : entry.project.name);

function PinIcon({ className = "w-3 h-3" }: { className?: string }) {
	return (
		<svg aria-hidden="true" focusable="false" className={`${className} flex-shrink-0`} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
			<path d="M12 17v5" fill="none" />
			<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
		</svg>
	);
}

/**
 * The ⌘N chip on a dashboard row or space header. It shows the key that opens
 * the entry and is the place to change it: a click opens the keypad. An entry
 * with no key gets an empty chip on hover, so any row can be given one.
 */
export function DigitKeyControl({ id, name, masked = false }: { id: string; name: string; masked?: boolean }) {
	const t = useT();
	const keys = useContext(DigitKeysContext);
	const [open, setOpen] = useState(false);
	const anchorRef = useRef<HTMLButtonElement>(null);
	if (!keys || !keys.pinnable.has(id)) return null;

	const index = keys.targets.findIndex((entry) => entry !== null && mixedEntryId(entry) === id);
	const pin = index === -1 ? null : keys.pins[index];
	const pinned = !!pin && mixedEntryId(pin) === id;
	const label = index === -1 ? null : digitKeyLabel(index + 1);
	const title = label === null ? t("digitKeys.assign", { name }) : t(pinned ? "digitKeys.chipPinned" : "digitKeys.chipAuto", { key: label, name });

	const tone =
		label === null
			? `border-dashed border-edge text-fg-muted hover:text-fg hover:border-edge-active ${open ? "" : "opacity-0 group-hover/digit:opacity-100 focus-visible:opacity-100"}`
			: pinned
				? "border-edge-active bg-elevated text-fg hover:bg-elevated-hover"
				: "border-edge text-fg-3 hover:text-fg hover:border-edge-active hover:bg-elevated";

	return (
		<>
			<button
				ref={anchorRef}
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label={title}
				title={masked ? undefined : title}
				data-testid={`digit-key-${id}`}
				data-pinned={pinned || undefined}
				className={`hidden md:inline-flex flex-shrink-0 items-center justify-center gap-1 h-6 min-w-[2.5rem] px-1.5 rounded-md border font-mono text-xs tabular-nums leading-none transition-[color,background-color,border-color,opacity,transform] active:scale-[0.96] ${tone}`}
			>
				{pinned && <PinIcon className="w-2.5 h-2.5" />}
				{label ?? (
					<svg aria-hidden="true" focusable="false" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
						<path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m7-7H5" />
					</svg>
				)}
			</button>
			{open && (
				<DigitKeypad
					keys={keys}
					id={id}
					name={name}
					masked={masked}
					current={index}
					pinned={pinned}
					anchor={anchorRef}
					onClose={(restoreFocus = true) => {
						setOpen(false);
						if (restoreFocus) anchorRef.current?.focus();
					}}
				/>
			)}
		</>
	);
}

interface DigitKeypadProps {
	keys: DigitKeys;
	id: string;
	name: string;
	masked: boolean;
	/** The key that opens this entry now, -1 for none. */
	current: number;
	pinned: boolean;
	anchor: React.RefObject<HTMLButtonElement | null>;
	/** Closes; `false` leaves focus where the user moved it instead of returning it to the chip. */
	onClose: (restoreFocus?: boolean) => void;
}

/** Nine keys, what each opens, and a click (or the digit itself) to pin this entry to one. */
function DigitKeypad({ keys, id, name, masked, current, pinned, anchor, onClose }: DigitKeypadProps) {
	const t = useT();
	const panelRef = useRef<HTMLDivElement>(null);
	const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const anyPinned = keys.anyStored;
	// One translated sentence, split around the name so each locale keeps its own word order.
	const [titleBefore, titleAfter = ""] = t("digitKeys.pickerLabel", { name: "\u0000" }).split("\u0000");

	const choose = (index: number) => {
		keys.onPin(index, id);
		onClose();
	};

	useEscapeKey(() => onClose());

	useLayoutEffect(() => {
		if (!anchor.current || !panelRef.current) return;
		const a = anchor.current.getBoundingClientRect();
		const panel = panelRef.current.getBoundingClientRect();
		const pad = 8;
		let top = a.bottom + 6;
		if (top + panel.height > window.innerHeight - pad) top = Math.max(pad, a.top - panel.height - 6);
		const left = Math.min(Math.max(pad, a.right - panel.width), window.innerWidth - panel.width - pad);
		setPos({ top, left });
	}, [anchor]);

	useEffect(() => {
		tileRefs.current[Math.max(current, 0)]?.focus();
	}, [current]);

	useEffect(() => {
		function onDown(e: MouseEvent) {
			const target = e.target as Node;
			if (!panelRef.current?.contains(target) && !anchor.current?.contains(target)) onClose(false);
		}
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	});

	// Keys only while focus is inside the panel: a digit typed anywhere else
	// (the dashboard search) is the user's text, never a pin.
	function onKeyDown(e: React.KeyboardEvent) {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (/^[1-9]$/.test(e.key)) {
			e.preventDefault();
			e.stopPropagation();
			choose(Number(e.key) - 1);
			return;
		}
		const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }[e.key];
		const at = tileRefs.current.findIndex((tile) => tile === document.activeElement);
		if (step === undefined || at === -1) return;
		e.preventDefault();
		tileRefs.current[Math.min(SLOTS - 1, Math.max(0, at + step))]?.focus();
	}

	// Tabbing out closes it, so nothing stays open behind the user's focus.
	function onBlur(e: React.FocusEvent) {
		const next = e.relatedTarget as Node | null;
		if (next && !panelRef.current?.contains(next) && !anchor.current?.contains(next)) onClose(false);
	}

	return createPortal(
		<div
			ref={panelRef}
			role="dialog"
			aria-label={t("digitKeys.pickerLabel", { name })}
			data-testid="digit-keypad"
			onKeyDown={onKeyDown}
			onBlur={onBlur}
			className="fixed z-50 w-80 bg-overlay rounded-2xl shadow-2xl shadow-black/40 border border-edge-active p-3 space-y-3"
			style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
		>
			<p className="text-xs text-fg-3 text-pretty">
				{titleBefore}
				<span className={`text-fg font-medium ${masked ? MASK_CLASS : ""}`}>{name}</span>
				{titleAfter}
			</p>
			<div className="grid grid-cols-3 gap-1.5">
				{Array.from({ length: SLOTS }, (_, index) => {
					const target = keys.targets[index] ?? null;
					const pin = keys.pins[index] ?? null;
					const isCurrent = index === current;
					const targetName = target ? entryName(target) : t("digitKeys.free");
					return (
						<button
							key={index}
							ref={(el) => {
								tileRefs.current[index] = el;
							}}
							type="button"
							onClick={() => choose(index)}
							aria-pressed={isCurrent}
							aria-label={t(pin ? "digitKeys.tilePinned" : "digitKeys.tile", { key: digitKeyLabel(index + 1), name: targetName })}
							data-testid={`digit-keypad-${index + 1}`}
							className={`flex flex-col items-start gap-1 min-w-0 px-2 py-1.5 rounded-lg border text-left transition-[background-color,border-color,transform] active:scale-[0.96] ${
								isCurrent ? "border-accent/60 bg-accent/10" : "border-edge hover:border-edge-active hover:bg-overlay-hover"
							}`}
						>
							<span className={`flex items-center gap-1 font-mono text-xs tabular-nums leading-none ${isCurrent ? "text-accent" : "text-fg-2"}`}>
								{digitKeyLabel(index + 1)}
								{pin && <PinIcon className="w-2.5 h-2.5 text-fg-3" />}
							</span>
							<span
								className={`w-full truncate text-xs ${target ? (isCurrent ? "text-fg" : "text-fg-3") : "text-fg-muted italic"} ${target && keys.isMasked(target) ? MASK_CLASS : ""}`}
							>
								{targetName}
							</span>
						</button>
					);
				})}
			</div>
			<p className="text-dense text-fg-muted text-pretty">{t("digitKeys.hint")}</p>
			{(pinned || anyPinned) && (
				<div className="flex items-center justify-between gap-2 border-t border-edge pt-2">
					{pinned ? (
						<button
							type="button"
							onClick={() => {
								keys.onPin(current, null);
								onClose();
							}}
							className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-fg-2 hover:text-fg hover:bg-overlay-hover transition-[color,background-color,transform] active:scale-[0.96]"
							data-testid="digit-keypad-unpin"
						>
							{t("digitKeys.unpin")}
						</button>
					) : (
						<span />
					)}
					{anyPinned && (
						<button
							type="button"
							onClick={() => {
								keys.onUnpinAll();
								onClose();
							}}
							className="px-2 py-1 rounded-md text-xs text-fg-3 hover:text-fg hover:bg-overlay-hover transition-[color,background-color,transform] active:scale-[0.96]"
							data-testid="digit-keypad-unpin-all"
						>
							{t("digitKeys.unpinAll")}
						</button>
					)}
				</div>
			)}
		</div>,
		document.body,
	);
}
