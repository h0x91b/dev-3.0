import { useRef, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ExternalApp } from "../../shared/types";
import { useAvailableApps } from "../hooks/useAvailableApps";
import { useT } from "../i18n";
import { api } from "../rpc";

/** Nerd Font icons for known app IDs */
const APP_ICONS: Record<string, string> = {
	finder: "\uF024",     // nf-oct-file_directory
	vscode: "\u{F0A1E}",  // nf-md-microsoft_visual_studio_code
	cursor: "\u{F0A1E}",  // reuse vscode icon
	ghostty: "\uF489",    // nf-oct-terminal
	iterm: "\uF489",
	terminal: "\uF489",
	intellij: "\u{F0184}",    // nf-md-diamond_stone (IntelliJ)
	"intellij-ultimate": "\u{F0184}",
	"intellij-ce": "\u{F0184}",
	zed: "\u{F0599}",            // nf-md-lightning_bolt (Zed)
	sublime: "\u{F0CC5}",        // nf-md-text_box (Sublime Text)
};

interface OpenInMenuProps {
	/** Position of the menu (top-left corner) */
	position: { top: number; left: number };
	/** Worktree or file path to open */
	path: string;
	/** Called when the menu should close */
	onClose: () => void;
}

export default function OpenInMenu({ position, path, onClose }: OpenInMenuProps) {
	const t = useT();
	const apps = useAvailableApps();
	const menuRef = useRef<HTMLDivElement>(null);
	const [menuPos, setMenuPos] = useState(position);
	const [visible, setVisible] = useState(false);

	// Close on click outside
	useEffect(() => {
		function handleClick(e: MouseEvent) {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				onClose();
			}
		}
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		document.addEventListener("mousedown", handleClick);
		document.addEventListener("keydown", handleKey);
		return () => {
			document.removeEventListener("mousedown", handleClick);
			document.removeEventListener("keydown", handleKey);
		};
	}, [onClose]);

	// Viewport clamping
	useLayoutEffect(() => {
		if (!menuRef.current) return;
		const menu = menuRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;

		let top = position.top;
		let left = position.left;

		if (top + menu.height > vh - pad) {
			top = vh - menu.height - pad;
		}
		if (left + menu.width > vw - pad) {
			left = vw - menu.width - pad;
		}
		if (left < pad) left = pad;
		if (top < pad) top = pad;

		setMenuPos({ top, left });
		setVisible(true);
	}, [position]);

	async function handleOpen(app: ExternalApp) {
		onClose();
		try {
			await api.request.openInApp({ appName: app.macAppName, path });
		} catch (err) {
			alert(t("openIn.failedOpen", { app: app.name, error: String(err) }));
		}
	}

	return createPortal(
		<div
			ref={menuRef}
			className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 min-w-[11.25rem]"
			style={{
				top: menuPos.top,
				left: menuPos.left,
				visibility: visible ? "visible" : "hidden",
			}}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="px-3 py-2 text-xs text-fg-3 uppercase tracking-wider font-semibold">
				{t("openIn.menuTitle")}
			</div>
			{apps.length === 0 ? (
				<div className="px-3 py-2 text-sm text-fg-muted">
					{t("openIn.noAppsFound")}
				</div>
			) : (
				apps.map((app) => (
					<button
						key={app.id}
						onClick={() => handleOpen(app)}
						className="w-full text-left px-3 py-2 text-sm text-fg-2 hover:bg-elevated-hover hover:text-fg flex items-center gap-2.5 transition-colors"
					>
						<span
							className="w-4 text-center text-[0.875rem] leading-none flex-shrink-0"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
						>
							{APP_ICONS[app.id] ?? "\u{F0645}"}
						</span>
						{app.name}
					</button>
				))
			)}
		</div>,
		document.body,
	);
}
