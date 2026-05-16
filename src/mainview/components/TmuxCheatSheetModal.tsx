import { useEffect, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";

interface Props {
	open: boolean;
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

/**
 * Tmux cheat sheet — a full-screen overlay summarising the prefix-keyed
 * bindings the agent / user has at their disposal inside any task terminal.
 *
 * Triggered from Terminal > Show Tmux Cheat Sheet and Help > Tmux Cheat Sheet
 * in the native menu (App.tsx listens for `menu:show-tmux-cheat-sheet`).
 *
 * Content matches the actual key bindings configured in
 * `src/bun/tmux-config.ts` and the iTerm2-compatible keymap preset.
 */
export default function TmuxCheatSheetModal({ open, onClose }: Props): ReactElement | null {
	const t = useT();

	useEffect(() => {
		if (!open) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	if (!open) return null;

	const sections: Section[] = [
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

	const overlay = (
		<div
			className="fixed inset-0 z-[1000] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
			onClick={onClose}
			data-testid="tmux-cheat-sheet-overlay"
		>
			<div
				className="bg-overlay border border-edge-active rounded-2xl shadow-2xl shadow-black/50 w-full max-w-5xl max-h-[88vh] overflow-hidden flex flex-col"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between px-6 py-4 border-b border-edge">
					<div>
						<div className="text-base font-semibold text-fg">{t("cheatSheet.title")}</div>
						<div className="text-xs text-fg-muted mt-0.5">{t("cheatSheet.subtitle")}</div>
					</div>
					<button
						type="button"
						className="text-fg-muted hover:text-fg rounded-md p-1 hover:bg-elevated transition-colors"
						onClick={onClose}
						aria-label="Close"
					>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
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
										<kbd className="font-mono text-[0.7rem] text-fg-2 bg-elevated border border-edge rounded px-1.5 py-0.5 whitespace-nowrap self-start">
											{row.keys}
										</kbd>
										<span className="text-xs text-fg-2 leading-relaxed">{row.desc}</span>
									</div>
								))}
							</div>
						</section>
					))}
				</div>
				<div className="px-6 py-3 border-t border-edge text-[0.7rem] text-fg-muted flex items-center justify-between">
					<span>{t("cheatSheet.footerPrefix")}</span>
					<span>{t("cheatSheet.footerEscape")}</span>
				</div>
			</div>
		</div>
	);

	return createPortal(overlay, document.body);
}
