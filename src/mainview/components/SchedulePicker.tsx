import { useEffect, useState } from "react";
import { formatCountdown } from "../../shared/duration";
import {
	type ScheduleMode,
	resolveScheduleTarget,
	scheduleDayOffset,
	toTimeInputValue,
} from "../../shared/schedule";
import { useT, type TranslationKey } from "../i18n";

/**
 * `− [ n ] +` stepper for the "in X" schedule mode. Buttons step by `step`
 * (minutes wrap around, hours clamp); typing accepts any value in range and
 * ArrowUp/ArrowDown mirror the buttons.
 */
function NumberStepper({
	label,
	value,
	max,
	step,
	wrap = false,
	disabled = false,
	onChange,
}: {
	label: string;
	value: number;
	max: number;
	step: number;
	wrap?: boolean;
	disabled?: boolean;
	onChange: (v: number) => void;
}) {
	const bump = (dir: 1 | -1) => {
		const next = value + dir * step;
		if (wrap) {
			const range = max + 1;
			onChange(((next % range) + range) % range);
		} else {
			onChange(Math.min(max, Math.max(0, next)));
		}
	};
	return (
		<div className="flex items-center gap-2">
			<span className="text-fg-3 text-xs">{label}</span>
			<div className="flex items-center gap-1">
				<button
					onClick={() => bump(-1)}
					disabled={disabled}
					aria-label={`${label} −`}
					className="w-8 h-8 rounded-lg border border-edge text-fg-3 hover:text-fg hover:border-edge-active transition-colors text-base leading-none disabled:opacity-50"
				>
					−
				</button>
				<input
					value={String(value)}
					disabled={disabled}
					inputMode="numeric"
					aria-label={label}
					onChange={(e) => {
						const digits = e.target.value.replace(/\D/g, "");
						onChange(Math.min(max, digits ? Number.parseInt(digits, 10) : 0));
					}}
					onKeyDown={(e) => {
						if (e.key === "ArrowUp") { e.preventDefault(); bump(1); }
						if (e.key === "ArrowDown") { e.preventDefault(); bump(-1); }
					}}
					className="w-12 h-8 bg-transparent border border-edge rounded-lg text-center text-fg text-base outline-none focus:border-accent"
				/>
				<button
					onClick={() => bump(1)}
					disabled={disabled}
					aria-label={`${label} +`}
					className="w-8 h-8 rounded-lg border border-edge text-fg-3 hover:text-fg hover:border-edge-active transition-colors text-base leading-none disabled:opacity-50"
				>
					+
				</button>
			</div>
		</div>
	);
}

interface SchedulePickerProps {
	disabled?: boolean;
	/**
	 * Reports the resolved target (and the active mode) whenever the picker state
	 * changes (and every 30 s so an "in X" target stays honest). `null` means the
	 * current input is invalid/zero — the parent disables submit. The reported
	 * target is at most one tick (30 s) stale for relative delays; absolute times
	 * never drift.
	 */
	onTargetChange: (target: Date | null, mode: ScheduleMode) => void;
	/** Enter inside the "at" time field submits (used by the launch modal). */
	onSubmit?: () => void;
	/** Initial relative delay in minutes (default 60 → 1h). */
	initialDelayMinutes?: number;
	/**
	 * Interpolated hint template `{day} {time} {rel}` — differs by verb per caller
	 * ("Will launch…" vs "Will send…"). Defaults to the launch phrasing.
	 */
	hintKey?: TranslationKey;
}

/**
 * Shared in/at schedule picker: a `"in" | "at"` mode switch + hour/minute
 * steppers or a `<input type="time">`, plus a live today/tomorrow hint. Extracted
 * from `LaunchVariantsModal` so both deferred launch ("Start in…") and scheduled
 * messages ("Send later") agree on the grammar and range (`in` ≤ 99h, `at`
 * today/tomorrow). Pure time resolution lives in `src/shared/schedule.ts`.
 */
function SchedulePicker({ disabled = false, onTargetChange, onSubmit, initialDelayMinutes = 60, hintKey = "launch.scheduleHint" }: SchedulePickerProps) {
	const t = useT();
	const [mode, setMode] = useState<ScheduleMode>("in");
	const [delayHours, setDelayHours] = useState(Math.floor(initialDelayMinutes / 60));
	const [delayMinutes, setDelayMinutes] = useState(initialDelayMinutes % 60);
	const [atTime, setAtTime] = useState(() => toTimeInputValue(new Date(Date.now() + initialDelayMinutes * 60_000)));
	// Re-render every 30s so the today/tomorrow hint and countdown stay honest.
	const [nowTick, setNowTick] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNowTick(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, []);

	const draft = { mode, delayHours, delayMinutes, atTime };
	const target = resolveScheduleTarget(draft, nowTick);

	// Report the resolved target to the parent on every change / tick.
	useEffect(() => {
		onTargetChange(resolveScheduleTarget(draft, Date.now()), mode);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mode, delayHours, delayMinutes, atTime, nowTick]);

	const hint = (() => {
		if (!target) return t("launch.scheduleInvalid");
		const dayDiff = scheduleDayOffset(target, nowTick);
		const day = dayDiff === 0 ? t("launch.today") : dayDiff === 1 ? t("launch.tomorrow") : target.toLocaleDateString();
		const time = target.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		return t(hintKey, { day, time, rel: formatCountdown(target.getTime() - nowTick) });
	})();

	return (
		<div>
			<div className="flex flex-wrap items-center gap-4">
				<div className="inline-flex h-8 flex-shrink-0 items-center rounded-lg border border-edge p-0.5">
					{(["in", "at"] as const).map((m) => (
						<button
							key={m}
							onClick={() => setMode(m)}
							className={`text-sm px-2.5 py-1 rounded-md whitespace-nowrap transition-colors ${
								mode === m ? "bg-elevated text-fg font-medium" : "text-fg-3 hover:text-fg"
							}`}
						>
							{m === "in" ? t("launch.modeIn") : t("launch.modeAt")}
						</button>
					))}
				</div>

				{mode === "in" ? (
					<div className="flex items-center gap-4">
						<NumberStepper
							label={t("launch.hours")}
							value={delayHours}
							max={99}
							step={1}
							disabled={disabled}
							onChange={setDelayHours}
						/>
						<NumberStepper
							label={t("launch.minutes")}
							value={delayMinutes}
							max={59}
							step={5}
							wrap
							disabled={disabled}
							onChange={setDelayMinutes}
						/>
					</div>
				) : (
					<input
						type="time"
						value={atTime}
						disabled={disabled}
						aria-label={t("launch.atTimeLabel")}
						onChange={(e) => setAtTime(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && target && !disabled) onSubmit?.();
						}}
						className="bg-transparent border border-edge rounded-lg px-2.5 h-8 text-fg text-base outline-none focus:border-accent"
					/>
				)}
			</div>

			<p className={`text-sm mt-2 ${target ? "text-fg-3" : "text-danger"}`}>
				{hint}
				{mode === "at" && target && (
					<span className="text-fg-3"> · {t("launch.atTimeLabel").toLowerCase()}</span>
				)}
			</p>
		</div>
	);
}

export default SchedulePicker;
