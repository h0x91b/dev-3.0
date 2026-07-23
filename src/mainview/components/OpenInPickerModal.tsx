import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { toast } from "../toast";
import type { ExternalApp } from "../../shared/types";
import { useAvailableApps } from "../hooks/useAvailableApps";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useFocusTrap } from "../utils/useFocusTrap";
import { OPEN_IN_APP_ICONS, OPEN_IN_APP_ICON_FALLBACK } from "./openInAppIcons";
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

const COLUMNS = 3;

/**
 * Centered, keyboard-summoned picker for the Cmd/Ctrl+O "Open in…" shortcut.
 * Unlike the anchored `OpenInMenu` dropdown (right-click / task-panel button),
 * this is a focused Modal surface: it always lists the installed apps as tiles
 * and opens the current context (project path or task worktree) in the chosen one.
 */
export default function OpenInPickerModal({ path, taskId, onClose }: OpenInPickerModalProps) {
	const t = useT();
	const apps = useAvailableApps();
	const dialogRef = useFocusTrap<HTMLDivElement>();
	const tileRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const [copied, setCopied] = useState(false);

	useEscapeKey(onClose);

	// Focus the first app tile once the list is known so keyboard users land on a
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

	// Arrow keys move focus linearly across the tile grid (Right/Down = next,
	// Left/Up = previous), wrapping at the ends.
	function handleGridKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
		const delta =
			event.key === "ArrowRight" || event.key === "ArrowDown"
				? 1
				: event.key === "ArrowLeft" || event.key === "ArrowUp"
					? -1
					: 0;
		if (delta === 0) return;
		event.preventDefault();
		const current = tileRefs.current.findIndex((el) => el === document.activeElement);
		const base = current === -1 ? 0 : current;
		const next = (base + delta + apps.length) % apps.length;
		tileRefs.current[next]?.focus();
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
					<div className="p-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))` }} onKeyDown={handleGridKeyDown}>
						{apps.map((app, index) => (
							<button
								key={app.id}
								ref={(el) => {
									tileRefs.current[index] = el;
								}}
								onClick={() => handleOpen(app)}
								className="flex flex-col items-center justify-center gap-2 rounded-xl px-2 py-4 text-fg-2 hover:text-fg hover:bg-elevated-hover border border-transparent hover:border-edge focus:outline-none focus:ring-2 focus:ring-accent/50 focus:bg-elevated-hover transition-colors"
							>
								<span
									className="text-[1.75rem] leading-none text-accent"
									style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
								>
									{OPEN_IN_APP_ICONS[app.id] ?? OPEN_IN_APP_ICON_FALLBACK}
								</span>
								<span className="text-xs font-medium text-center leading-tight">{app.name}</span>
							</button>
						))}
					</div>
				)}

				<div className="border-t border-edge px-3 py-2">
					<button
						onClick={copyPath}
						className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-fg-3 hover:text-fg hover:bg-elevated-hover focus:outline-none focus:ring-2 focus:ring-accent/50 transition-colors"
					>
						<span className="w-4 text-center leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
							{copied ? "\u{F012C}" : "\u{F0C5}"}
						</span>
						{copied ? t("openIn.pathCopied") : t("openIn.copyPath")}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
