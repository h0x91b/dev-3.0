import { useState, useCallback, useEffect, useRef } from "react";
import { Gauge, type GaugeTheme } from "./Gauge";
import { useT } from "../../i18n";

interface PresetConfig {
	nameKey: string;
	min: number;
	max: number;
	step: number;
	value: number;
	redZone?: number;
	angleRange: [number, number];
	label: string;
	unit: string;
	formatLabel?: (v: number) => string;
}

const PRESETS: PresetConfig[] = [
	{
		nameKey: "gaugeDemo.presetInvestment",
		min: 0,
		max: 100000,
		step: 20000,
		value: 45000,
		angleRange: [45, 315],
		label: "Invest",
		unit: "Goal",
	},
	{
		nameKey: "gaugeDemo.presetIncome",
		min: 0,
		max: 200000,
		step: 40000,
		value: 120000,
		angleRange: [30, 330],
		label: "Income",
		unit: "p/m",
	},
	{
		nameKey: "gaugeDemo.presetExpense",
		min: 0,
		max: 200000,
		step: 40000,
		value: 150000,
		redZone: 160000,
		angleRange: [30, 330],
		label: "Outflow",
		unit: "p/m",
	},
	{
		nameKey: "gaugeDemo.presetLimit",
		min: 0,
		max: 1,
		step: 0.25,
		value: 0.65,
		angleRange: [60, 300],
		label: "Limit",
		unit: "Usage",
		formatLabel: (v) => `${Math.round(v * 100)}%`,
	},
];

interface PlaygroundState {
	value: number;
	min: number;
	max: number;
	step: number;
	size: number;
	redZoneEnabled: boolean;
	redZone: number;
	angleStart: number;
	angleEnd: number;
	label: string;
	unit: string;
}

const DEFAULT_PLAYGROUND: PlaygroundState = {
	value: 65,
	min: 0,
	max: 100,
	step: 20,
	size: 280,
	redZoneEnabled: false,
	redZone: 80,
	angleStart: 30,
	angleEnd: 330,
	label: "Speed",
	unit: "km/h",
};

interface GaugeDemoProps {
	navigate: (route: { screen: "dashboard" }) => void;
}

const THEME_OPTIONS: Array<"auto" | "dark" | "light"> = ["auto", "dark", "light"];

export function GaugeDemo({ navigate }: GaugeDemoProps) {
	const t = useT();
	const [pg, setPg] = useState<PlaygroundState>(DEFAULT_PLAYGROUND);
	const [gaugeTheme, setGaugeTheme] = useState<GaugeTheme>("auto");
	const originalThemeRef = useRef<string | null>(null);

	// On mount, save original app theme. On unmount, restore it.
	useEffect(() => {
		originalThemeRef.current = document.documentElement.dataset.theme || null;
		return () => {
			// Restore original theme when leaving the page
			if (originalThemeRef.current) {
				document.documentElement.dataset.theme = originalThemeRef.current;
			} else {
				delete document.documentElement.dataset.theme;
			}
		};
	}, []);

	// When gaugeTheme changes, apply it to <html> for full app simulation
	useEffect(() => {
		if (gaugeTheme === "auto") {
			// Restore original theme
			if (originalThemeRef.current) {
				document.documentElement.dataset.theme = originalThemeRef.current;
			}
		} else {
			document.documentElement.dataset.theme = gaugeTheme;
		}
	}, [gaugeTheme]);

	const update = useCallback(
		<K extends keyof PlaygroundState>(key: K, val: PlaygroundState[K]) => {
			setPg((prev) => ({ ...prev, [key]: val }));
		},
		[],
	);

	const loadPreset = useCallback((preset: PresetConfig) => {
		setPg({
			value: preset.value,
			min: preset.min,
			max: preset.max,
			step: preset.step,
			size: 280,
			redZoneEnabled: preset.redZone != null,
			redZone: preset.redZone ?? preset.max * 0.8,
			angleStart: preset.angleRange[0],
			angleEnd: preset.angleRange[1],
			label: preset.label,
			unit: preset.unit,
		});
	}, []);

	return (
		<div className="flex-1 overflow-y-auto p-6 space-y-8">
			{/* Header */}
			<div className="flex items-center gap-4">
				<button
					onClick={() => navigate({ screen: "dashboard" })}
					className="text-fg-3 hover:text-fg transition-colors text-sm"
				>
					&larr; {t("gaugeDemo.back")}
				</button>
				<h1 className="text-fg text-2xl font-bold flex-1">{t("gaugeDemo.title")}</h1>

				{/* Theme switcher */}
				<div className="flex items-center gap-1 bg-elevated rounded-lg p-0.5 border border-edge">
					{THEME_OPTIONS.map((opt) => (
						<button
							key={opt}
							onClick={() => setGaugeTheme(opt)}
							className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
								gaugeTheme === opt
									? "bg-accent text-white"
									: "text-fg-3 hover:text-fg"
							}`}
						>
							{t(`gaugeDemo.theme${opt[0].toUpperCase()}${opt.slice(1)}` as Parameters<typeof t>[0])}
						</button>
					))}
				</div>
			</div>

			{/* Presets row */}
			<section>
				<h2 className="text-fg-2 text-sm font-semibold mb-4 uppercase tracking-wider">
					{t("gaugeDemo.presets")}
				</h2>
				<div className="flex flex-wrap gap-8 items-end justify-center p-8 bg-raised rounded-2xl border border-edge">
					{PRESETS.map((preset, i) => (
						<div key={i} className="flex flex-col items-center gap-3">
							<Gauge
								value={preset.value}
								min={preset.min}
								max={preset.max}
								step={preset.step}
								redZone={preset.redZone}
								size={i === 1 || i === 2 ? 200 : 160}
								label={preset.label}
								unit={preset.unit}
								formatLabel={preset.formatLabel}
								angleRange={preset.angleRange}
								theme={gaugeTheme}
							/>
							<button
								onClick={() => loadPreset(preset)}
								className="text-xs text-accent hover:text-accent/80 font-semibold uppercase tracking-wider transition-colors"
							>
								{t(preset.nameKey as Parameters<typeof t>[0])}
							</button>
						</div>
					))}
				</div>
			</section>

			{/* Playground */}
			<section>
				<h2 className="text-fg-2 text-sm font-semibold mb-4 uppercase tracking-wider">
					{t("gaugeDemo.playground")}
				</h2>
				<div className="flex flex-col lg:flex-row gap-8">
					{/* Live gauge */}
					<div className="flex-1 flex items-center justify-center p-8 bg-raised rounded-2xl border border-edge min-h-[400px]">
						<Gauge
							value={pg.value}
							min={pg.min}
							max={pg.max}
							step={pg.step}
							redZone={pg.redZoneEnabled ? pg.redZone : undefined}
							size={pg.size}
							label={pg.label}
							unit={pg.unit}
							angleRange={[pg.angleStart, pg.angleEnd]}
							theme={gaugeTheme}
						/>
					</div>

					{/* Controls */}
					<div className="w-full lg:w-80 space-y-4 p-6 bg-raised rounded-2xl border border-edge">
						<SliderControl
							label={t("gaugeDemo.value")}
							value={pg.value}
							min={pg.min}
							max={pg.max}
							step={pg.step / 10 || 1}
							onChange={(v) => update("value", v)}
						/>
						<div className="grid grid-cols-2 gap-3">
							<NumberInput
								label={t("gaugeDemo.min")}
								value={pg.min}
								onChange={(v) => update("min", v)}
							/>
							<NumberInput
								label={t("gaugeDemo.max")}
								value={pg.max}
								onChange={(v) => update("max", v)}
							/>
						</div>
						<NumberInput
							label={t("gaugeDemo.step")}
							value={pg.step}
							onChange={(v) => update("step", v)}
						/>
						<SliderControl
							label={t("gaugeDemo.size")}
							value={pg.size}
							min={100}
							max={500}
							step={10}
							onChange={(v) => update("size", v)}
						/>

						{/* Red zone toggle + slider */}
						<div className="space-y-2">
							<label className="flex items-center gap-2 cursor-pointer select-none">
								<input
									type="checkbox"
									checked={pg.redZoneEnabled}
									onChange={(e) => update("redZoneEnabled", e.target.checked)}
									className="w-4 h-4 rounded accent-accent"
								/>
								<span className="text-fg-2 text-sm">
									{t("gaugeDemo.redZoneEnabled")}
								</span>
							</label>
							{pg.redZoneEnabled && (
								<SliderControl
									label={t("gaugeDemo.redZone")}
									value={pg.redZone}
									min={pg.min}
									max={pg.max}
									step={pg.step / 10 || 1}
									onChange={(v) => update("redZone", v)}
								/>
							)}
						</div>

						{/* Angle range */}
						<div className="space-y-2">
							<span className="text-fg-3 text-xs font-medium">
								{t("gaugeDemo.angleRange")}
							</span>
							<div className="grid grid-cols-2 gap-3">
								<NumberInput
									label="Start°"
									value={pg.angleStart}
									onChange={(v) => update("angleStart", v)}
								/>
								<NumberInput
									label="End°"
									value={pg.angleEnd}
									onChange={(v) => update("angleEnd", v)}
								/>
							</div>
						</div>

						{/* Label / Unit */}
						<div className="grid grid-cols-2 gap-3">
							<TextInput
								label={t("gaugeDemo.label")}
								value={pg.label}
								onChange={(v) => update("label", v)}
							/>
							<TextInput
								label={t("gaugeDemo.unit")}
								value={pg.unit}
								onChange={(v) => update("unit", v)}
							/>
						</div>
					</div>
				</div>
			</section>
		</div>
	);
}

// --- Small control components ---

function SliderControl({
	label,
	value,
	min,
	max,
	step,
	onChange,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	onChange: (v: number) => void;
}) {
	return (
		<div className="space-y-1">
			<div className="flex justify-between">
				<span className="text-fg-3 text-xs font-medium">{label}</span>
				<span className="text-fg-2 text-xs font-mono">{value}</span>
			</div>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				className="w-full h-1.5 rounded-full appearance-none bg-elevated cursor-pointer accent-accent"
			/>
		</div>
	);
}

function NumberInput({
	label,
	value,
	onChange,
}: {
	label: string;
	value: number;
	onChange: (v: number) => void;
}) {
	return (
		<div className="space-y-1">
			<span className="text-fg-3 text-xs font-medium">{label}</span>
			<input
				type="number"
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				className="w-full px-2 py-1.5 text-sm rounded-lg bg-elevated border border-edge text-fg focus:outline-none focus:border-accent transition-colors"
			/>
		</div>
	);
}

function TextInput({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
}) {
	return (
		<div className="space-y-1">
			<span className="text-fg-3 text-xs font-medium">{label}</span>
			<input
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="w-full px-2 py-1.5 text-sm rounded-lg bg-elevated border border-edge text-fg focus:outline-none focus:border-accent transition-colors"
			/>
		</div>
	);
}

export default GaugeDemo;
