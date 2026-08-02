import type { TFunction } from "../../i18n";
import {
	applyScrollSpeed,
	DEFAULT_SCROLL_SPEED,
	MAX_SCROLL_SPEED,
	MIN_SCROLL_SPEED,
	SCROLL_SPEED_STEP,
} from "../../scroll-speed";
import type { NativeTerminalAvailability } from "../../../shared/types";
import type { TerminalBackendIdentity } from "../../../shared/terminal-backend-identity";
import SettingsEntry from "./SettingsEntry";
import TerminalBackendSetting from "./TerminalBackendSetting";
import SettingsSection from "./SettingsSection";

export default function TerminalSettingsSection({
	t,
	scrollSpeed,
	newTaskTerminalBackend,
	nativeTerminalAvailability,
	onNewTaskTerminalBackendChange,
}: {
	t: TFunction;
	scrollSpeed: number;
	newTaskTerminalBackend: TerminalBackendIdentity | undefined;
	nativeTerminalAvailability: NativeTerminalAvailability | null;
	onNewTaskTerminalBackendChange: (backend: TerminalBackendIdentity) => void;
}) {
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
