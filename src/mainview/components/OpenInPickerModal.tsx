import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { toast } from "../toast";
import type { ExternalApp } from "../../shared/types";
import { useAvailableApps } from "../hooks/useAvailableApps";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useFocusTrap } from "../utils/useFocusTrap";
import { OPEN_IN_APP_ICONS, brandColorForApp, isCustomOpenInApp } from "./openInAppIcons";
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

const COLUMNS = 4;

/**
 * Centered, keyboard-summoned picker for the Cmd/Ctrl+O "Open in…" shortcut.
 * Unlike the anchored `OpenInMenu` dropdown (right-click / task-panel button),
 * this is a focused Modal surface: a brand-colored tile grid that always lists
 * the installed apps and opens the current context (project path or task
 * worktree) in the chosen one. 1–9 open directly; arrows move the focus ring.
 */
export default function OpenInPickerModal({ path, taskId, onClose }: OpenInPickerModalProps) {
	const t = useT();
	const apps = useAvailableApps();
	const dialogRef = useFocusTrap<HTMLDivElement>();
	const tileRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const [copied, setCopied] = useState(false);

	useEscapeKey(onClose);

	// Focus the first tile once the list is known so keyboard users land on a
	// concrete choice (Enter opens it) instead of the bare dialog container.
	useEffect(() => {
		if (apps.length > 0) tileRefs.current[0]?.focus();
	}, [apps.length]);

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

	function focusTile(index: number) {
		const count = apps.length;
		if (count === 0) return;
		tileRefs.current[((index % count) + count) % count]?.focus();
	}

	function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
		// 1–9 open the Nth app directly (no text input in this modal to conflict).
		if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key >= "1" && event.key <= "9") {
			const index = Number(event.key) - 1;
			if (index < apps.length) {
				event.preventDefault();
				void handleOpen(apps[index]);
			}
			return;
		}
		const current = tileRefs.current.findIndex((el) => el === document.activeElement);
		const base = current === -1 ? 0 : current;
		switch (event.key) {
			case "ArrowRight":
				event.preventDefault();
				focusTile(base + 1);
				break;
			case "ArrowLeft":
				event.preventDefault();
				focusTile(base - 1);
				break;
			case "ArrowDown":
				event.preventDefault();
				focusTile(base + COLUMNS);
				break;
			case "ArrowUp":
				event.preventDefault();
				focusTile(base - COLUMNS);
				break;
			default:
				break;
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
				className="bg-overlay rounded-2xl border border-edge-active shadow-2xl shadow-black/40 w-full max-w-[30rem] outline-none"
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

				{apps.length === 0 ? (
					<div className="px-5 py-10 text-sm text-fg-muted text-center">{t("openIn.noAppsFound")}</div>
				) : (
					<div className="p-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))` }}>
						{apps.map((app, index) => {
							const glyph = OPEN_IN_APP_ICONS[app.id];
							const custom = isCustomOpenInApp(app.id);
							return (
								<button
									key={app.id}
									ref={(el) => {
										tileRefs.current[index] = el;
									}}
									onClick={() => handleOpen(app)}
									title={app.name}
									className="relative flex flex-col items-center gap-2 rounded-xl px-1.5 pt-3.5 pb-2.5 border border-transparent hover:border-edge hover:bg-elevated-hover focus:outline-none focus:border-accent/60 focus:bg-accent/10 focus:ring-2 focus:ring-accent/20 transition-colors"
								>
									{index < 9 && (
										<span className="absolute top-1.5 right-1.5 flex items-center justify-center min-w-[1rem] h-4 px-1 rounded-[5px] bg-elevated border border-edge text-fg-muted text-[0.625rem] font-semibold leading-none font-mono">
											{index + 1}
										</span>
									)}
									{custom && (
										<span className="absolute top-1.5 left-1.5 px-1 py-0.5 rounded-[5px] bg-warning/15 text-warning text-[0.5rem] font-bold uppercase tracking-wide leading-none">
											{t("openIn.customBadge")}
										</span>
									)}
									<span
										className="flex items-center justify-center w-11 h-11 rounded-[27%] text-white shadow-inner"
										style={{ background: brandColorForApp(app.id) }}
									>
										{glyph ? (
											<span className="text-[1.25rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
												{glyph}
											</span>
										) : (
											<span className="text-base font-bold leading-none">{app.name.slice(0, 1).toUpperCase()}</span>
										)}
									</span>
									<span className="text-[0.6875rem] font-semibold text-fg-2 text-center leading-tight">{app.name}</span>
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
