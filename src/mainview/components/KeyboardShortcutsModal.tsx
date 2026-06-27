import { useEffect, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useT, type TranslationKey } from "../i18n";
import {
	APP_SHORTCUTS,
	SHORTCUT_CATEGORY_KEY,
	SHORTCUT_CATEGORY_ORDER,
	shortcutKeysFor,
} from "../keymap";
import { isMac } from "../utils/platform";
import { useFocusTrap } from "../utils/useFocusTrap";

export type ShortcutsTab = "app" | "terminal";

interface Props {
	open: boolean;
	tab: ShortcutsTab;
	onTabChange: (tab: ShortcutsTab) => void;
	onClose: () => void;
}

interface BindRow {
	keys: string;
	desc: string;
}

interface Section {
	title: string;
	rows: BindRow[];
}

type T = (key: TranslationKey) => string;

/**
 * Insert a thin space (U+2009) after each macOS modifier glyph (⌘⇧⌥⌃) so the
 * cluster doesn't visually merge — "⇧⌘P" reads as "⇧ ⌘ P". No-op for the
 * textual Linux form ("Ctrl+Shift+P") and for tmux bindings, which already
 * carry real spaces.
 */
function spaceModifierGlyphs(keys: string): string {
	return keys.replace(/([⌘⇧⌥⌃])(?=\S)/gu, "$1 ");
}

/** App-level shortcuts grouped by category, rendered from the keymap registry. */
function buildAppSections(t: T, mac: boolean): Section[] {
	return SHORTCUT_CATEGORY_ORDER.map((category) => ({
		title: t(SHORTCUT_CATEGORY_KEY[category]),
		rows: APP_SHORTCUTS.filter((s) => s.category === category).map((s) => ({
			keys: spaceModifierGlyphs(shortcutKeysFor(s, mac)),
			desc: t(s.descKey),
		})),
	})).filter((section) => section.rows.length > 0);
}

/**
 * Tmux prefix-keyed bindings shown on the Terminal tab. Sourced from the actual
 * key bindings configured in `src/bun/tmux-config.ts` and the iTerm2-compatible
 * keymap preset (this is the former standalone TmuxCheatSheetModal content,
 * folded into the unified shortcuts overlay).
 */
function buildTmuxSections(t: T): Section[] {
	return [
		{
			title: t("cheatSheet.section.panes"),
			rows: [
				{ keys: "⌃B -", desc: t("tmux.splitHDesc") },
				{ keys: "⌃B |", desc: t("tmux.splitVDesc") },
				{ keys: "⌃B z", desc: t("tmux.zoomDesc") },
				{ keys: "⌃B x", desc: t("tmux.closePaneDesc") },
				{ keys: "⌃B o", desc: t("cheatSheet.nextPane") },
				{ keys: "⌃B ;", desc: t("cheatSheet.lastPane") },
				{ keys: "⌃B q", desc: t("cheatSheet.showPaneNumbers") },
				{ keys: "⌃B ↑ ↓ ← →", desc: t("cheatSheet.directionalSelect") },
				{ keys: "⌃B m", desc: t("cheatSheet.markPane") },
				{ keys: "⌃B s", desc: t("cheatSheet.swapWithMarked") },
				{ keys: "⌃B { / }", desc: t("cheatSheet.swapWithPrevNext") },
				{ keys: "⌃B ⌃o", desc: t("cheatSheet.rotatePanes") },
				{ keys: "⌃B Alt-↑ ↓ ← →", desc: t("cheatSheet.resize") },
			],
		},
		{
			title: t("cheatSheet.section.layout"),
			rows: [
				{ keys: "⌃B ␣", desc: t("tmux.nextLayoutDesc") },
				{ keys: "⌃B M-1", desc: t("tmux.layoutEvenHDesc") },
				{ keys: "⌃B M-2", desc: t("tmux.layoutEvenVDesc") },
				{ keys: "⌃B M-3", desc: t("tmux.layoutMainHDesc") },
				{ keys: "⌃B M-4", desc: t("tmux.layoutMainVDesc") },
				{ keys: "⌃B M-5", desc: t("tmux.layoutTiledDesc") },
			],
		},
		{
			title: t("cheatSheet.section.window"),
			rows: [
				{ keys: "⌃B c", desc: t("cheatSheet.newWindow") },
				{ keys: "⌃B ,", desc: t("cheatSheet.renameWindow") },
				{ keys: "⌃B n / p", desc: t("cheatSheet.nextPrevWindow") },
				{ keys: "⌃B 0..9", desc: t("cheatSheet.goToWindow") },
				{ keys: "⌃B w", desc: t("cheatSheet.chooseTree") },
				{ keys: "⌃B f", desc: t("cheatSheet.findWindow") },
				{ keys: "⌃B &", desc: t("cheatSheet.killWindow") },
			],
		},
		{
			title: t("cheatSheet.section.session"),
			rows: [
				{ keys: "⌃B $", desc: t("cheatSheet.renameSession") },
				{ keys: "⌃B d", desc: t("cheatSheet.detach") },
				{ keys: "⌃B s", desc: t("cheatSheet.chooseSession") },
				{ keys: "⌃B (  /  )", desc: t("cheatSheet.prevNextSession") },
			],
		},
		{
			title: t("cheatSheet.section.copyMode"),
			rows: [
				{ keys: "⌃B [", desc: t("cheatSheet.enterCopyMode") },
				{ keys: "⌃B ]", desc: t("cheatSheet.paste") },
				{ keys: "/  ?", desc: t("cheatSheet.findFwdBack") },
				{ keys: "n  N", desc: t("cheatSheet.findRepeat") },
				{ keys: "Space  Enter", desc: t("cheatSheet.selectionCopy") },
				{ keys: "q", desc: t("cheatSheet.exitCopyMode") },
			],
		},
		{
			title: t("cheatSheet.section.misc"),
			rows: [
				{ keys: "⌃B :", desc: t("cheatSheet.commandPrompt") },
				{ keys: "⌃B t", desc: t("cheatSheet.clock") },
				{ keys: "⌃B ?", desc: t("cheatSheet.listKeys") },
				{ keys: "⌃B Set-w synchronize-panes", desc: t("cheatSheet.synchronize") },
			],
		},
	];
}

/**
 * Unified keyboard-shortcut reference overlay. Two tabs on one shell:
 * - App      — app-level shortcuts rendered from the `keymap.ts` registry.
 * - Terminal — tmux prefix bindings (the folded-in tmux cheat sheet).
 *
 * Opened from Help > Keyboard Shortcuts (App tab) / Help > Tmux Cheat Sheet
 * (Terminal tab), the ⌘/ (Ctrl+/) shortcut, and the ⇧⌘P command palette.
 * App.tsx owns the open/tab state and the keyboard handler.
 */
export default function KeyboardShortcutsModal({ open, tab, onTabChange, onClose }: Props): ReactElement | null {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();

	useEffect(() => {
		if (!open) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				onClose();
			} else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
				onTabChange(tab === "app" ? "terminal" : "app");
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, tab, onClose, onTabChange]);

	if (!open) return null;

	const sections = tab === "app" ? buildAppSections(t, isMac()) : buildTmuxSections(t);
	const tabs: ShortcutsTab[] = ["app", "terminal"];
	const tabLabel: Record<ShortcutsTab, string> = {
		app: t("keymap.tab.app"),
		terminal: t("keymap.tab.terminal"),
	};

	const overlay = (
		<div
			className="fixed inset-0 z-[1000] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
			onClick={onClose}
			data-testid="keyboard-shortcuts-overlay"
		>
			<div
				ref={trapRef}
				tabIndex={-1}
				className="bg-overlay border border-edge-active rounded-2xl shadow-2xl shadow-black/50 w-full max-w-5xl max-h-[88vh] overflow-hidden flex flex-col outline-none"
				onClick={(e) => e.stopPropagation()}
				role="dialog"
				aria-modal="true"
				aria-label={t("keymap.title")}
			>
				<div className="flex items-center justify-between px-6 py-4 border-b border-edge">
					<div>
						<div className="text-base font-semibold text-fg">{t("keymap.title")}</div>
						<div className="text-xs text-fg-muted mt-0.5">{t("keymap.subtitle")}</div>
					</div>
					<button
						type="button"
						className="text-fg-muted hover:text-fg rounded-md p-1 hover:bg-elevated transition-colors"
						onClick={onClose}
						aria-label={t("keymap.footerEscape")}
					>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>
				<div className="px-6 pt-3" role="tablist" aria-label={t("keymap.title")}>
					<div className="inline-flex rounded-lg border border-edge bg-raised p-0.5 gap-0.5">
						{tabs.map((id) => (
							<button
								key={id}
								type="button"
								role="tab"
								aria-selected={tab === id}
								className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
									tab === id
										? "bg-accent text-white"
										: "text-fg-3 hover:text-fg hover:bg-elevated"
								}`}
								onClick={() => onTabChange(id)}
								data-testid={`shortcuts-tab-${id}`}
							>
								{tabLabel[id]}
							</button>
						))}
					</div>
				</div>
				<div className="overflow-y-auto px-6 py-5 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
					{sections.map((section) => (
						<section key={section.title}>
							<h3 className="text-xs font-semibold uppercase tracking-wide text-fg-2 mb-2.5">
								{section.title}
							</h3>
							<div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
								{section.rows.map((row) => (
									<div key={row.keys + row.desc} className="contents">
										<kbd className="font-mono text-xs text-fg bg-elevated border border-edge rounded px-2 py-0.5 whitespace-nowrap self-start">
											{row.keys}
										</kbd>
										<span className="text-xs text-fg-2 leading-relaxed">{row.desc}</span>
									</div>
								))}
							</div>
						</section>
					))}
				</div>
				<div className="px-6 py-3 border-t border-edge text-[0.7rem] text-fg-muted flex items-center justify-end">
					<span>{t("keymap.footerEscape")}</span>
				</div>
			</div>
		</div>
	);

	return createPortal(overlay, document.body);
}
