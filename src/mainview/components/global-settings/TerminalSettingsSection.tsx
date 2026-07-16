import type { TFunction } from "../../i18n";
import {
	applyScrollSpeed,
	DEFAULT_SCROLL_SPEED,
	MAX_SCROLL_SPEED,
	MIN_SCROLL_SPEED,
	SCROLL_SPEED_STEP,
} from "../../scroll-speed";
import type { TerminalKeymapPreset } from "../../../shared/types";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";

export default function TerminalSettingsSection({
	t,
	keymapPreset,
	scrollSpeed,
	onKeymapChange,
}: {
	t: TFunction;
	keymapPreset: TerminalKeymapPreset;
	scrollSpeed: number;
	onKeymapChange: (preset: TerminalKeymapPreset) => void;
}) {
	return (
		<SettingsSection title={t("settings.categoryTerminal")} helpTopicId="settings.terminal">
			<SettingsEntry anchor="terminal-keymap">
				<div>
					<label className="block text-fg text-sm font-semibold mb-2">
						{t("settings.terminalKeymap")}
					</label>
					<p className="text-fg-3 text-sm mb-3">
						{t("settings.terminalKeymapDesc")}
					</p>
					<button
						type="button"
						onClick={() =>
							onKeymapChange(keymapPreset === "iterm2" ? "default" : "iterm2")
						}
						className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 transition-all text-left ${
							keymapPreset === "iterm2"
								? "border-accent shadow-lg shadow-accent/10"
								: "border-edge hover:border-edge-active"
						}`}
					>
						<div
							className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
								keymapPreset === "iterm2"
									? "border-accent bg-accent"
									: "border-edge-active"
							}`}
						>
							{keymapPreset === "iterm2" ? (
								<svg width="10" height="8" viewBox="0 0 10 8" fill="none" aria-hidden="true">
									<path
										d="M1 4L3.5 6.5L9 1"
										stroke="white"
										strokeWidth="1.5"
										strokeLinecap="round"
										strokeLinejoin="round"
									/>
								</svg>
							) : null}
						</div>
						<div>
							<div className="text-fg text-sm font-semibold">
								{t("settings.keymapIterm2")}
							</div>
							<div className="text-fg-3 text-xs mt-0.5">
								{t("settings.keymapIterm2Desc")}
							</div>
						</div>
					</button>
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
