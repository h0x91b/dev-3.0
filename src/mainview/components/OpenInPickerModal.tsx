import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { toast } from "../toast";
import type { ExternalApp } from "../../shared/types";
import type { TranslationKey } from "../i18n";
import { useAvailableApps } from "../hooks/useAvailableApps";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useFocusTrap } from "../utils/useFocusTrap";
import { OPEN_IN_APP_ICONS, OPEN_IN_APP_ICON_FALLBACK, brandColorForApp, isCustomOpenInApp, openInAppCategory } from "./openInAppIcons";
import { useT } from "../i18n";
import { api } from "../rpc";

interface OpenInPickerModalProps {
	/** Absolute project or worktree path to open. */
	path: string;
	/** Optional owning task for toast attention fallback. */
	taskId?: string;
	/** Called when the modal should close. */
	onClose: () => void;
}

const CATEGORY_KEY: Record<ReturnType<typeof openInAppCategory>, TranslationKey> = {
	files: "openIn.cat.files",
	editor: "openIn.cat.editor",
	terminal: "openIn.cat.terminal",
	custom: "openIn.cat.custom",
};

/**
 * Keyboard-summoned "Open in…" launcher for the Cmd/Ctrl+O shortcut. Unlike the
 * anchored `OpenInMenu` dropdown (right-click / task-panel button), this is a
 * focused Modal surface: a searchable list (Raycast-style) that opens the current
 * context — the project path, or the active task's worktree — in the chosen app.
 * Type to filter, 1–9 to open the Nth visible row, ↑↓ to move, Enter to open.
 */
export default function OpenInPickerModal({ path, taskId, onClose }: OpenInPickerModalProps) {
	const t = useT();
	const apps = useAvailableApps();
	const dialogRef = useFocusTrap<HTMLDivElement>();
	const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const [copied, setCopied] = useState(false);

	useEscapeKey(onClose);

	const filtered = apps.filter((app) => app.name.toLowerCase().includes(query.trim().toLowerCase()));
	const active = Math.min(activeIndex, Math.max(0, filtered.length - 1));

	// Keep the highlighted row scrolled into view as it moves.
	useEffect(() => {
		rowRefs.current[active]?.scrollIntoView({ block: "nearest" });
	}, [active]);

	async function handleOpen(app: ExternalApp) {
		onClose();
		try {
			await api.request.openInApp({ appName: app.macAppName, path });
		} catch (err) {
			toast.error(t("openIn.failedOpen", { app: app.name, error: String(err) }), { taskId });
		}
	}

	function copyPath() {
		navigator.clipboard.writeText(path);
		setCopied(true);
		setTimeout(() => setCopied(false), 1200);
	}

	function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
		// Digits 1–9 open the Nth visible row directly. App names are alphabetic, so
		// repurposing digits as quick-open (rather than filter text) is worth it.
		if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key >= "1" && event.key <= "9") {
			const index = Number(event.key) - 1;
			if (index < filtered.length) {
				event.preventDefault();
				void handleOpen(filtered[index]);
			}
			return;
		}
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setActiveIndex(Math.min(active + 1, filtered.length - 1));
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setActiveIndex(Math.max(active - 1, 0));
		} else if (event.key === "Enter") {
			if (!filtered[active]) return;
			event.preventDefault();
			void handleOpen(filtered[active]);
		}
	}

	return createPortal(
		<div
			role="presentation"
			className="fixed inset-0 z-[10000] flex items-start justify-center bg-black/50 backdrop-blur-sm pt-[12vh] px-4"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				ref={dialogRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-labelledby="open-in-picker-title"
				className="bg-overlay rounded-2xl border border-edge-active shadow-2xl shadow-black/40 w-full max-w-[27rem] outline-none flex flex-col"
				onMouseDown={(event) => event.stopPropagation()}
				onKeyDown={handleKeyDown}
			>
				<div className="px-5 pt-4 pb-3 border-b border-edge">
					<div id="open-in-picker-title" className="text-sm font-semibold text-fg">
						{t("openIn.menuTitle")}
					</div>
					<div className="text-xs text-fg-3 mt-0.5 truncate font-mono streamer-private" title={path}>
						{path}
					</div>
				</div>

				<div className="px-3 pt-3">
					<div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-edge bg-base focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15 transition-colors">
						<span className="text-fg-muted text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
							{"\u{F002}"}
						</span>
						<input
							type="text"
							autoFocus
							value={query}
							onChange={(event) => {
								setQuery(event.target.value);
								setActiveIndex(0);
							}}
							placeholder={t("openIn.searchPlaceholder")}
							aria-label={t("openIn.searchPlaceholder")}
							className="flex-1 bg-transparent border-0 outline-none text-sm text-fg placeholder:text-fg-muted"
						/>
					</div>
				</div>

				{apps.length === 0 ? (
					<div className="px-5 py-9 text-sm text-fg-muted text-center">{t("openIn.noAppsFound")}</div>
				) : filtered.length === 0 ? (
					<div className="px-5 py-9 text-sm text-fg-muted text-center">{t("openIn.noMatches")}</div>
				) : (
					<div className="p-2 max-h-[19rem] overflow-auto" role="listbox" aria-label={t("openIn.menuTitle")}>
						{filtered.map((app, index) => {
							const glyph = OPEN_IN_APP_ICONS[app.id] ?? OPEN_IN_APP_ICON_FALLBACK;
							const custom = isCustomOpenInApp(app.id);
							return (
								<button
									key={app.id}
									ref={(el) => {
										rowRefs.current[index] = el;
									}}
									role="option"
									aria-selected={index === active}
									onClick={() => handleOpen(app)}
									onMouseMove={() => setActiveIndex(index)}
									className={`flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-left transition-colors ${
										index === active ? "bg-accent/12 ring-1 ring-inset ring-accent/40" : "hover:bg-elevated-hover"
									}`}
								>
									<span
										className="flex items-center justify-center w-7 h-7 rounded-[27%] text-white shadow-inner flex-shrink-0"
										style={{ background: brandColorForApp(app.id) }}
									>
										<span className="text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
											{isCustomOpenInApp(app.id) && !OPEN_IN_APP_ICONS[app.id] ? app.name.slice(0, 1).toUpperCase() : glyph}
										</span>
									</span>
									<span className="flex-1 min-w-0">
										<span className="block text-[0.8125rem] font-semibold text-fg truncate">{app.name}</span>
										<span className="block text-[0.6875rem] text-fg-muted">{t(CATEGORY_KEY[openInAppCategory(app.id)])}</span>
									</span>
									<span className="flex items-center gap-1.5 flex-shrink-0">
										{custom && (
											<span className="px-1 py-0.5 rounded-[5px] bg-warning/15 text-warning text-[0.5rem] font-bold uppercase tracking-wide leading-none">
												{t("openIn.customBadge")}
											</span>
										)}
										{index < 9 && (
											<span className="flex items-center justify-center min-w-[1rem] h-4 px-1 rounded-[5px] bg-elevated border border-edge text-fg-muted text-[0.625rem] font-semibold leading-none font-mono">
												{index + 1}
											</span>
										)}
									</span>
								</button>
							);
						})}
					</div>
				)}

				<div className="border-t border-edge px-3 py-2 flex items-center justify-between gap-3">
					<button
						onClick={copyPath}
						className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-fg-3 hover:text-fg hover:bg-elevated-hover focus:outline-none focus:ring-2 focus:ring-accent/50 transition-colors"
					>
						<span className="w-4 text-center leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
							{copied ? "\u{F012C}" : "\u{F0C5}"}
						</span>
						{copied ? t("openIn.pathCopied") : t("openIn.copyPath")}
					</button>
					<span className="text-[0.625rem] text-fg-muted hidden sm:block">{t("openIn.openShortcutHint")}</span>
				</div>
			</div>
		</div>,
		document.body,
	);
}
