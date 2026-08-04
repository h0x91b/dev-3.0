import type { TFunction } from "../../i18n";
import type { NativeTerminalAvailability } from "../../../shared/types";
import type { TerminalBackendIdentity } from "../../../shared/terminal-backend-identity";
import { handleRadioGroupKeys } from "../../utils/radioGroupKeys";

/**
 * Machine-local "which terminal backend do NEW tasks get" picker.
 *
 * An unavailable choice stays visible but disabled with its reason spelled out —
 * hiding it would leave the user guessing why the rollout never reached them.
 * The preference is forward-only: nothing here rewrites an existing task.
 */
export default function TerminalBackendSetting({
	t,
	value,
	availability,
	onChange,
}: {
	t: TFunction;
	/** Stored preference; undefined ⇒ this platform's default. */
	value: TerminalBackendIdentity | undefined;
	/** Null while the probe is in flight — both options stay inert until it lands. */
	availability: NativeTerminalAvailability | null;
	onChange: (backend: TerminalBackendIdentity) => void;
}) {
	const tmuxSupported = availability?.tmuxSupported !== false;
	const nativeAvailable = availability?.available === true;
	const selected: TerminalBackendIdentity = value ?? (tmuxSupported ? "tmux" : "native");

	const options: Array<{
		id: TerminalBackendIdentity;
		title: string;
		description: string;
		disabled: boolean;
		reasons: string[];
	}> = [
		{
			id: "tmux",
			title: t("settings.terminalBackendTmux"),
			description: t("settings.terminalBackendTmuxDesc"),
			disabled: !tmuxSupported,
			reasons: tmuxSupported ? [] : [t("settings.terminalBackendTmuxUnavailable")],
		},
		{
			id: "native",
			title: t("settings.terminalBackendNative"),
			description: t("settings.terminalBackendNativeDesc"),
			disabled: !nativeAvailable,
			reasons: nativeAvailable
				? []
				: [
						t("settings.terminalBackendNativeUnavailable"),
						...(availability?.diagnostics ?? []),
						t("settings.terminalBackendNativeUnavailableFix"),
					],
		},
	];

	return (
		<div>
			<p className="block text-fg text-sm font-semibold mb-2">
				{t("settings.terminalBackend")}
			</p>
			<p className="text-fg-3 text-sm mb-3">{t("settings.terminalBackendDesc")}</p>
			<div
				role="radiogroup"
				aria-label={t("settings.terminalBackend")}
				className="space-y-2"
				onKeyDown={(event) =>
					handleRadioGroupKeys(
						event,
						options.filter((option) => !option.disabled).map((option) => option.id),
						selected,
						onChange,
					)
				}
			>
				{options.map((option) => {
					const active = selected === option.id;
					return (
						<button
							key={option.id}
							type="button"
							role="radio"
							aria-checked={active}
							aria-disabled={option.disabled || undefined}
							disabled={option.disabled || availability === null}
							onClick={() => onChange(option.id)}
							className={`w-full flex items-start gap-4 p-4 rounded-xl border-2 transition-colors text-left disabled:cursor-not-allowed ${
								active
									? "border-accent shadow-lg shadow-accent/10"
									: "border-edge hover:border-edge-active"
							} ${option.disabled ? "opacity-50 hover:border-edge" : ""}`}
						>
							<div
								className={`w-5 h-5 mt-0.5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
									active ? "border-accent" : "border-edge-active"
								}`}
							>
								{active ? <div className="w-2.5 h-2.5 rounded-full bg-accent" /> : null}
							</div>
							<div className="min-w-0">
								<div className="text-fg text-sm font-semibold">{option.title}</div>
								<div className="text-fg-3 text-xs mt-0.5">{option.description}</div>
								{option.reasons.map((reason) => (
									<div key={reason} className="text-warning text-xs mt-1 break-words">
										{reason}
									</div>
								))}
							</div>
						</button>
					);
				})}
			</div>
			<p className="text-fg-muted text-xs mt-2">{t("settings.terminalBackendPerTaskHint")}</p>
		</div>
	);
}
