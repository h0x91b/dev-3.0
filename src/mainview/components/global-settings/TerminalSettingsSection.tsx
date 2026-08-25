import { useState } from "react";
import type { TFunction } from "../../i18n";
import {
	applyScrollSpeed,
	DEFAULT_SCROLL_SPEED,
	MAX_SCROLL_SPEED,
	MIN_SCROLL_SPEED,
	SCROLL_SPEED_STEP,
} from "../../scroll-speed";
import type { NativeTerminalAvailability, ShellAvailability, TerminalPathOpenMode } from "../../../shared/types";
import type { ShellFlavor } from "../../../shared/posix-shell";
import { SHELL_FALLBACK_ORDER } from "../../../shared/posix-shell";
import type { TerminalBackendIdentity } from "../../../shared/terminal-backend-identity";
import {
	applyTerminalFontFamily,
	applyTerminalFontSize,
	BUNDLED_TERMINAL_FONTS,
	DEFAULT_TERMINAL_FONT_FAMILY,
	DEFAULT_TERMINAL_FONT_SIZE,
	isTerminalFontAvailable,
	MAX_TERMINAL_FONT_SIZE,
	MIN_TERMINAL_FONT_SIZE,
	terminalFontScale,
	terminalFontStack,
} from "../../terminal-font";
import SettingsEntry from "./SettingsEntry";
import TerminalBackendSetting from "./TerminalBackendSetting";
import TerminalFontGallery from "./TerminalFontGallery";
import SettingsSection from "./SettingsSection";
import Select from "../Select";

const PATH_OPEN_MODES = ["preview", "system", "reveal"] as const;

/** Deliberately not localized: box-drawing, a glyph and digits are what a terminal font is judged on. */
const TERMINAL_FONT_PREVIEW = "├─ 0OIl1 {}[]() →  ✓ 42%";

export default function TerminalSettingsSection({
	t,
	scrollSpeed,
	terminalFontFamily,
	terminalFontSize,
	newTaskTerminalBackend,
	nativeTerminalAvailability,
	terminalPathOpenMode,
	terminalShell,
	shellAvailability,
	onNewTaskTerminalBackendChange,
	onTerminalPathOpenModeChange,
	onTerminalShellChange,
}: {
	t: TFunction;
	scrollSpeed: number;
	terminalFontFamily: string;
	terminalFontSize: number;
	newTaskTerminalBackend: TerminalBackendIdentity | undefined;
	nativeTerminalAvailability: NativeTerminalAvailability | null;
	terminalPathOpenMode: TerminalPathOpenMode | undefined;
	terminalShell: ShellFlavor | undefined;
	shellAvailability: ShellAvailability | null;
	onNewTaskTerminalBackendChange: (backend: TerminalBackendIdentity) => void;
	onTerminalPathOpenModeChange: (mode: TerminalPathOpenMode) => void;
	onTerminalShellChange: (shell: ShellFlavor | undefined) => void;
}) {
	const resolved = shellAvailability?.resolved ?? null;
	// Windows answers with no POSIX resolution at all — the whole choice is moot
	// there, so the control stays off the screen instead of lying about it.
	const showShellPicker = !shellAvailability || resolved !== null;
	const [galleryOpen, setGalleryOpen] = useState(false);
	const fontAvailable = isTerminalFontAvailable(terminalFontFamily);
	/** How much this font had to shrink to stay inside the reference cell, in percent. */
	const narrowedBy = Math.round((1 - terminalFontScale(terminalFontFamily)) * 1000) / 10;
	// The reference font is a normal option; the empty value stays reserved for
	// "never chose one", which is what every existing user has stored.
	const fontOptions = BUNDLED_TERMINAL_FONTS.map((font) => ({
		value: font.family,
		label: font.label,
	}));
	const pathOpenModeLabel: Record<TerminalPathOpenMode, string> = {
		preview: t("settings.terminalPathOpenModePreview"),
		system: t("settings.terminalPathOpenModeSystem"),
		reveal: t("settings.terminalPathOpenModeReveal"),
	};
	return (
		<SettingsSection title={t("settings.categoryTerminal")} helpTopicId="settings.terminal">
			<SettingsEntry anchor="terminal-backend">
				<TerminalBackendSetting
					t={t}
					value={newTaskTerminalBackend}
					availability={nativeTerminalAvailability}
					onChange={onNewTaskTerminalBackendChange}
				/>
			</SettingsEntry>

			{showShellPicker && (
				<SettingsEntry anchor="terminal-shell">
					<div>
						<p className="block text-fg text-sm font-semibold mb-2">{t("settings.terminalShell")}</p>
						<p className="text-fg-3 text-sm mb-3">{t("settings.terminalShellDesc")}</p>
						<div className="flex flex-col gap-3 sm:flex-row">
							{([undefined, ...SHELL_FALLBACK_ORDER] as const).map((flavor) => {
								const installedPath = flavor ? shellAvailability?.installed[flavor] : undefined;
								const missing = Boolean(flavor && shellAvailability && !installedPath);
								return (
									<button
										key={flavor ?? "auto"}
										onClick={() => onTerminalShellChange(flavor)}
										className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm transition-colors ${
											terminalShell === flavor
												? "border-accent bg-accent/10 text-accent"
												: "border-edge bg-raised text-fg hover:border-edge-active"
										}`}
									>
										{flavor ?? t("settings.terminalShellAuto")}
										{missing && (
											<span className="text-fg-muted text-xs">
												({t("settings.terminalShellNotInstalled")})
											</span>
										)}
									</button>
								);
							})}
						</div>
						{resolved && (
							<p className={`text-sm mt-3 ${resolved.fellBack ? "text-danger" : "text-fg-3"}`}>
								{resolved.fellBack
									? t("settings.terminalShellMissing", {
											shell: String(resolved.requested),
											path: resolved.path,
										})
									: t("settings.terminalShellResolved", { path: resolved.path })}
							</p>
						)}
					</div>
				</SettingsEntry>
			)}

			<SettingsEntry anchor="terminal-path-open-mode">
				<div>
					<p className="block text-fg text-sm font-semibold mb-2">
						{t("settings.terminalPathOpenMode")}
					</p>
					<p className="text-fg-3 text-sm mb-3">
						{t("settings.terminalPathOpenModeDesc")}
					</p>
					<div className="flex flex-col gap-3 sm:flex-row">
						{PATH_OPEN_MODES.map((mode) => (
							<button
								key={mode}
								onClick={() => onTerminalPathOpenModeChange(mode)}
								className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm transition-colors ${
									(terminalPathOpenMode ?? "preview") === mode
										? "border-accent bg-accent/10 text-accent"
										: "border-edge bg-raised text-fg hover:border-edge-active"
								}`}
							>
								{pathOpenModeLabel[mode]}
							</button>
						))}
					</div>
				</div>
			</SettingsEntry>

			<SettingsEntry anchor="terminal-font">
				<div>
					<p className="block text-fg text-sm font-semibold mb-2">
						{t("settings.terminalFont")}
					</p>
					<p className="text-fg-3 text-sm mb-3">{t("settings.terminalFontDesc")}</p>
					<div className="flex flex-col gap-3 sm:flex-row sm:items-start">
						<div className="flex-1 min-w-0">
							<Select
								value={terminalFontFamily}
								options={fontOptions}
								onChange={applyTerminalFontFamily}
								allowCustom
								ariaLabel={t("settings.terminalFontFamily")}
								placeholder={t("settings.terminalFontBundled")}
								searchPlaceholder={t("settings.terminalFontSearch")}
								searchLabel={t("settings.terminalFontFamily")}
							/>
						</div>
						<button
							type="button"
							onClick={() => applyTerminalFontFamily(DEFAULT_TERMINAL_FONT_FAMILY)}
							disabled={terminalFontFamily === DEFAULT_TERMINAL_FONT_FAMILY}
							className="px-3 h-10 rounded-lg bg-raised border border-edge text-fg-2 text-sm hover:border-edge-active transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
						>
							{t("settings.zoomReset")}
						</button>
					</div>
					{!fontAvailable && (
						<p className="text-warning-strong text-sm mt-2">
							{t("settings.terminalFontMissing")}
						</p>
					)}
					{narrowedBy > 0 && (
						<p className="text-fg-3 text-sm mt-2">
							{t("settings.terminalFontNarrowedNote", { percent: String(narrowedBy) })}
						</p>
					)}
					<p
						className="mt-3 px-3 py-2 rounded-lg bg-base border border-edge text-fg-2 overflow-hidden text-ellipsis whitespace-nowrap"
						style={{
							fontFamily: terminalFontStack(terminalFontFamily),
							fontSize: terminalFontSize * terminalFontScale(terminalFontFamily),
						}}
					>
						{TERMINAL_FONT_PREVIEW}
					</p>
					<button
						type="button"
						onClick={() => setGalleryOpen((open) => !open)}
						aria-expanded={galleryOpen}
						className="mt-3 px-3 h-9 rounded-lg bg-raised border border-edge text-fg-2 text-sm hover:border-edge-active transition-colors"
					>
						{galleryOpen
							? t("settings.terminalFontCompareHide")
							: t("settings.terminalFontCompare", {
									count: String(BUNDLED_TERMINAL_FONTS.length),
								})}
					</button>
					{galleryOpen && (
						<TerminalFontGallery
							t={t}
							value={terminalFontFamily}
							size={terminalFontSize}
							onSelect={applyTerminalFontFamily}
						/>
					)}
				</div>
			</SettingsEntry>

			<SettingsEntry anchor="terminal-font-size">
				<div>
					<label className="block text-fg text-sm font-semibold mb-2">
						{t("settings.terminalFontSize")}
					</label>
					<p className="text-fg-3 text-sm mb-3">{t("settings.terminalFontSizeDesc")}</p>
					<div className="flex items-center gap-4">
						<input
							type="range"
							min={MIN_TERMINAL_FONT_SIZE}
							max={MAX_TERMINAL_FONT_SIZE}
							step={1}
							value={terminalFontSize}
							onChange={(event) => applyTerminalFontSize(parseInt(event.target.value, 10))}
							aria-label={t("settings.terminalFontSize")}
							className="flex-1 h-2 rounded-full appearance-none cursor-pointer bg-raised border border-edge accent-accent"
						/>
						<span className="w-12 text-right text-fg text-lg font-semibold tabular-nums">
							{terminalFontSize}
						</span>
						<button
							type="button"
							onClick={() => applyTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE)}
							disabled={terminalFontSize === DEFAULT_TERMINAL_FONT_SIZE}
							className="px-3 h-10 rounded-lg bg-raised border border-edge text-fg-2 text-sm hover:border-edge-active transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
						>
							{t("settings.zoomReset")}
						</button>
					</div>
				</div>
			</SettingsEntry>

			<SettingsEntry anchor="terminal-scroll-speed">
				<div>
					<label className="block text-fg text-sm font-semibold mb-2">
						{t("settings.scrollSpeed")}
					</label>
					<p className="text-fg-3 text-sm mb-3">
						{t("settings.scrollSpeedDesc")}
					</p>
					<div className="flex items-center gap-4">
						<input
							type="range"
							min={MIN_SCROLL_SPEED}
							max={MAX_SCROLL_SPEED}
							step={SCROLL_SPEED_STEP}
							value={scrollSpeed}
							onChange={(event) => applyScrollSpeed(parseFloat(event.target.value))}
							aria-label={t("settings.scrollSpeed")}
							className="flex-1 h-2 rounded-full appearance-none cursor-pointer bg-raised border border-edge accent-accent"
						/>
						<span className="w-12 text-right text-fg text-lg font-semibold tabular-nums">
							{scrollSpeed}×
						</span>
						<button
							type="button"
							onClick={() => applyScrollSpeed(DEFAULT_SCROLL_SPEED)}
							disabled={scrollSpeed === DEFAULT_SCROLL_SPEED}
							className="px-3 h-10 rounded-lg bg-raised border border-edge text-fg-2 text-sm hover:border-edge-active transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
						>
							{t("settings.zoomReset")}
						</button>
					</div>
				</div>
			</SettingsEntry>
		</SettingsSection>
	);
}
