import type { TFunction } from "../../i18n";
import type { TerminalKeymapPreset } from "../../../shared/types";

/**
 * The tmux keymap preset. Lives in the Keyboard category next to the app
 * shortcut editor — every "where do I change a key" question has one destination.
 */
export default function TerminalKeymapSetting({
	t,
	keymapPreset,
	onKeymapChange,
}: {
	t: TFunction;
	keymapPreset: TerminalKeymapPreset;
	onKeymapChange: (preset: TerminalKeymapPreset) => void;
}) {
	const enabled = keymapPreset === "iterm2";
	return (
		<div>
			<label className="block text-fg text-sm font-semibold mb-2">
				{t("settings.terminalKeymap")}
			</label>
			<p className="text-fg-3 text-sm mb-3">{t("settings.terminalKeymapDesc")}</p>
			<button
				type="button"
				aria-pressed={enabled}
				onClick={() => onKeymapChange(enabled ? "default" : "iterm2")}
				className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50 transition-[border-color,box-shadow,transform] duration-150 ease-out motion-safe:active:scale-[0.99] ${
					enabled ? "border-accent shadow-lg shadow-accent/10" : "border-edge hover:border-edge-active"
				}`}
			>
				<div
					className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
						enabled ? "border-accent bg-accent" : "border-edge-active"
					}`}
				>
					{enabled ? (
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
					<div className="text-fg text-sm font-semibold">{t("settings.keymapIterm2")}</div>
					<div className="text-fg-3 text-xs mt-0.5">{t("settings.keymapIterm2Desc")}</div>
				</div>
			</button>
		</div>
	);
}
