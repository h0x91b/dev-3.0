import { useMemo, useSyncExternalStore, type CSSProperties } from "react";

export type GaugeTheme = "dark" | "light" | "auto";

export interface GaugeProps {
	/** Current value */
	value: number;
	/** Minimum value (default: 0) */
	min?: number;
	/** Maximum value */
	max: number;
	/** Step between major tick marks (auto-calculated if omitted) */
	step?: number;
	/** Value at which red zone starts (optional) */
	redZone?: number;
	/** Gauge diameter in px (default: 240) */
	size?: number;
	/** Label text (e.g. "Income") */
	label?: string;
	/** Unit text (e.g. "p/m") */
	unit?: string;
	/** Format function for tick labels */
	formatLabel?: (value: number) => string;
	/** Sweep angle range [start, end] in degrees (default: [30, 330]) */
	angleRange?: [number, number];
	/** Color theme: "dark", "light", or "auto" (follows app theme). Default: "auto" */
	theme?: GaugeTheme;
}

const DEG = Math.PI / 180;

// --- Color palettes ---

interface GaugePalette {
	bezelGradient: string;
	bezelShadow: string;
	bezelInnerBg: string;
	bezelInnerShadow: string;
	faceGradient: string;
	faceBorder: string;
	faceShadow: string;
	faceGlare: string;
	needleColor: string;
	needleShadow: string;
	needleShine: string;
	pivotGradient: string;
	pivotBorder: string;
	pivotShadow: string;
	tickColor: string;
	tickRedColor: string;
	labelColor: string;
	labelRedColor: string;
	unitColor: string;
}

const DARK_PALETTE: GaugePalette = {
	bezelGradient: "linear-gradient(145deg, #CFD6DA 0%, #7F8A93 45%, #5F6A73 55%, #A7B0B7 100%)",
	bezelShadow: "0 15px 35px rgba(0,0,0,1), inset 0 2px 3px rgba(255,255,255,0.8), inset 0 -2px 3px rgba(0,0,0,0.5)",
	bezelInnerBg: "radial-gradient(circle at 50% 50%, #08090b 0%, #121518 60%, #1e2228 100%)",
	bezelInnerShadow: "inset 0 10px 20px rgba(0,0,0,0.9)",
	faceGradient: "radial-gradient(circle at 50% 50%, #151a24, #0a0e14)",
	faceBorder: "#141820",
	faceShadow: "inset 0 10px 30px rgba(0,0,0,1), 0 5px 15px rgba(255,255,255,0.05)",
	faceGlare: "radial-gradient(circle at 30% 30%, rgba(255,255,255,0.1) 0%, transparent 70%)",
	needleColor: "#e11d48",
	needleShadow: "0 4px 8px rgba(0,0,0,0.5)",
	needleShine: "linear-gradient(to right, rgba(0,0,0,0.2), transparent, rgba(0,0,0,0.2))",
	pivotGradient: "radial-gradient(circle at 30% 30%, #444, #111)",
	pivotBorder: "#222",
	pivotShadow: "0 4px 10px rgba(0,0,0,0.8), inset 0 2px 4px rgba(255,255,255,0.1)",
	tickColor: "#334155",
	tickRedColor: "#ef4444",
	labelColor: "#475569",
	labelRedColor: "#ef4444",
	unitColor: "#64748b",
};

const LIGHT_PALETTE: GaugePalette = {
	// Gunmetal chrome bezel — neutral silver, Porsche-strict
	bezelGradient: "linear-gradient(160deg, #ededee 0%, #d4d6da 15%, #a0a4ac 40%, #8e9098 55%, #a0a4ac 70%, #d4d6da 85%, #ededee 100%)",
	bezelShadow: "0 14px 40px rgba(0,0,0,0.5), 0 4px 12px rgba(0,0,0,0.3), inset 0 3px 4px rgba(255,255,255,0.85), inset 0 -3px 4px rgba(0,0,0,0.4)",
	// Inner ring — gunmetal tunnel, dark center, lighter edge
	bezelInnerBg: "radial-gradient(circle, #3e4048 0%, #5c5f68 55%, #a8aab2 100%)",
	bezelInnerShadow: "inset 0 8px 20px rgba(0,0,0,0.6), inset 0 -3px 6px rgba(0,0,0,0.3)",
	// Face gradient — user-tuned values
	faceGradient: "radial-gradient(circle at 46% 42%, rgb(247,247,247) 0%, rgb(237,238,240) 25%, rgb(216,218,222) 55%, rgb(192,196,202) 80%, rgb(176,181,188) 100%)",
	faceBorder: "#383c42",
	faceShadow: "inset 0 6px 20px rgba(0,0,0,0.1), inset 0 -2px 6px rgba(0,0,0,0.04), 0 2px 8px rgba(255,255,255,0.2)",
	// Very subtle glass highlight
	faceGlare: "radial-gradient(circle at 35% 25%, rgba(255,255,255,0.3) 0%, transparent 50%)",
	// Classic Porsche red/orange needle
	needleColor: "#e03e2d",
	needleShadow: "0 3px 6px rgba(224,62,45,0.35), 0 1px 3px rgba(0,0,0,0.25)",
	needleShine: "linear-gradient(to right, rgba(0,0,0,0.15), transparent, rgba(0,0,0,0.15))",
	// Dark chrome pivot cap
	pivotGradient: "radial-gradient(circle at 30% 30%, #555, #1a1a1a)",
	pivotBorder: "#2a2a2a",
	pivotShadow: "0 3px 8px rgba(0,0,0,0.6), inset 0 1px 2px rgba(255,255,255,0.2)",
	// Dark crisp tick marks on light face — Porsche uses near-black
	tickColor: "#2c2c2c",
	tickRedColor: "#d42020",
	labelColor: "#1a1a1a",
	labelRedColor: "#d42020",
	unitColor: "#3a3a3a",
};

// --- Detect app theme from DOM ---

function getAppTheme(): "dark" | "light" {
	if (typeof document === "undefined") return "dark";
	return (document.documentElement.dataset.theme as "dark" | "light") || "dark";
}

function subscribeToTheme(cb: () => void): () => void {
	const observer = new MutationObserver(cb);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	return () => observer.disconnect();
}

/** Format large numbers compactly: 1500 → "1.5K", 2000000 → "2M", etc. */
function compactNumber(v: number): string {
	const abs = Math.abs(v);
	if (abs >= 1_000_000_000) {
		const n = v / 1_000_000_000;
		return (Number.isInteger(n) ? n : +n.toFixed(1)) + "B";
	}
	if (abs >= 1_000_000) {
		const n = v / 1_000_000;
		return (Number.isInteger(n) ? n : +n.toFixed(1)) + "M";
	}
	if (abs >= 1_000) {
		const n = v / 1_000;
		return (Number.isInteger(n) ? n : +n.toFixed(1)) + "K";
	}
	return String(v);
}

function defaultStep(min: number, max: number): number {
	const range = max - min;
	const magnitude = Math.pow(10, Math.floor(Math.log10(range)));
	const normalized = range / magnitude;
	if (normalized <= 2) return magnitude / 4;
	if (normalized <= 5) return magnitude / 2;
	return magnitude;
}

export function Gauge({
	value,
	min = 0,
	max,
	step: stepProp,
	redZone,
	size = 240,
	label,
	unit,
	formatLabel = compactNumber,
	angleRange = [30, 330],
	theme = "auto",
}: GaugeProps) {
	const appTheme = useSyncExternalStore(subscribeToTheme, getAppTheme, () => "dark" as const);
	const resolvedTheme = theme === "auto" ? appTheme : theme;
	const p = resolvedTheme === "light" ? LIGHT_PALETTE : DARK_PALETTE;

	const step = stepProp ?? defaultStep(min, max);
	const [angleMin, angleMax] = angleRange;
	const scale = size / 240;

	const bezelSize = Math.round(size * 1.17);
	const needleLength = Math.round(size * 0.42);
	const pivotSize = Math.round(size * 0.13);
	const tickMargin = 12;

	const clampedValue = Math.min(Math.max(value, min), max);
	const pct = (clampedValue - min) / (max - min);
	const needleAngle = pct * (angleMax - angleMin) + angleMin;

	const ticks = useMemo(() => {
		const MAX_TICKS = 20;
		let steps = Math.round((max - min) / step);
		const effectiveStep = steps > MAX_TICKS
			? (max - min) / MAX_TICKS
			: step;
		if (steps > MAX_TICKS) steps = MAX_TICKS;
		const angleStep = (angleMax - angleMin) / steps;
		const items: Array<{
			value: number;
			angle: number;
			isRed: boolean;
			halfAngle?: number;
		}> = [];

		for (let n = 0; n <= steps; n++) {
			const v = min + n * effectiveStep;
			const angle = angleMin + n * angleStep;
			const isRed = redZone != null && v >= redZone;
			items.push({
				value: v,
				angle,
				isRed,
				halfAngle: n < steps ? angle + angleStep / 2 : undefined,
			});
		}
		return items;
	}, [min, max, step, angleMin, angleMax, redZone]);

	// --- Styles ---
	const bezelStyle: CSSProperties = {
		width: bezelSize,
		height: bezelSize,
		borderRadius: "50%",
		background: p.bezelGradient,
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		boxShadow: p.bezelShadow,
		position: "relative",
	};

	const bezelInnerStyle: CSSProperties = {
		position: "absolute",
		inset: 5 * scale,
		borderRadius: "50%",
		background: p.bezelInnerBg,
		boxShadow: p.bezelInnerShadow,
	};

	const faceStyle: CSSProperties = {
		width: size,
		height: size,
		borderRadius: "50%",
		background: p.faceGradient,
		position: "relative",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		overflow: "hidden",
		border: `${Math.round(2 * scale)}px solid ${p.faceBorder}`,
		boxShadow: p.faceShadow,
		zIndex: 10,
	};

	const faceGlareStyle: CSSProperties = {
		position: "absolute",
		inset: 0,
		background: p.faceGlare,
		pointerEvents: "none",
		borderRadius: "inherit",
	};

	const needleStyle: CSSProperties = {
		position: "absolute",
		top: "50%",
		left: "50%",
		display: "block",
		width: Math.round(4 * scale),
		height: needleLength,
		transformOrigin: "50% 0",
		transform: `translate3d(-50%, 0, 0) rotate(${Math.round(needleAngle)}deg)`,
		backgroundColor: p.needleColor,
		boxShadow: p.needleShadow,
		zIndex: 10,
		transition: "transform 1.5s cubic-bezier(0.19, 1, 0.22, 1)",
		borderRadius: `${Math.round(4 * scale)}px ${Math.round(4 * scale)}px 0 0`,
	};

	const needleShineStyle: CSSProperties = {
		position: "absolute",
		top: 0,
		left: -2 * scale,
		width: 8 * scale,
		height: "100%",
		background: p.needleShine,
	};

	const pivotStyle: CSSProperties = {
		position: "absolute",
		top: "50%",
		left: "50%",
		width: pivotSize,
		height: pivotSize,
		transform: "translate(-50%, -50%)",
		background: p.pivotGradient,
		border: `2px solid ${p.pivotBorder}`,
		borderRadius: "50%",
		boxShadow: p.pivotShadow,
		zIndex: 20,
	};

	const unitLabelStyle: CSSProperties = {
		position: "absolute",
		left: "50%",
		top: "75%",
		transform: "translate(-50%, -50%)",
		textAlign: "center",
		color: p.unitColor,
		fontSize: Math.round(10 * scale),
		fontWeight: 800,
		textTransform: "uppercase",
		letterSpacing: 2 * scale,
		pointerEvents: "none",
		lineHeight: 1.4,
	};

	return (
		<div style={bezelStyle}>
			<div style={bezelInnerStyle} />
			<div style={faceStyle}>
				<div style={faceGlareStyle} />

				{ticks.map((tick, i) => (
					<GaugeTick
						key={i}
						tick={tick}
						scale={scale}
						tickMargin={tickMargin}
						formatLabel={formatLabel}
						palette={p}
					/>
				))}

				{(label || unit) && (
					<div style={unitLabelStyle}>
						{label && <div>{label}</div>}
						{unit && <span style={{ fontSize: Math.round(9 * scale), opacity: 0.7 }}>{unit}</span>}
					</div>
				)}

				<div style={needleStyle}>
					<div style={needleShineStyle} />
				</div>

				<div style={pivotStyle} />
			</div>
		</div>
	);
}

interface GaugeTickProps {
	tick: { value: number; angle: number; isRed: boolean; halfAngle?: number };
	scale: number;
	tickMargin: number;
	formatLabel: (v: number) => string;
	palette: GaugePalette;
}

function GaugeTick({ tick, scale, tickMargin, formatLabel, palette }: GaugeTickProps) {
	const { angle, isRed, halfAngle } = tick;
	const labelColor = isRed ? palette.labelRedColor : palette.labelColor;
	const tickColor = isRed ? palette.tickRedColor : palette.tickColor;

	const labelStyle: CSSProperties = {
		position: "absolute",
		display: "inline-block",
		fontSize: Math.round(14 * scale),
		color: labelColor,
		transform: "translate(-50%, -50%)",
		fontWeight: 900,
		fontFamily: "'Inter', sans-serif",
		zIndex: 5,
		pointerEvents: "none",
		left: `${50 - (50 - tickMargin) * Math.sin(angle * DEG)}%`,
		top: `${50 + (50 - tickMargin) * Math.cos(angle * DEG)}%`,
	};

	const mainTickStyle: CSSProperties = {
		position: "absolute",
		display: "block",
		width: Math.round(3 * scale),
		height: Math.round(10 * scale),
		transformOrigin: "50% 0",
		backgroundColor: tickColor,
		zIndex: 4,
		left: `${50 - 50 * Math.sin(angle * DEG)}%`,
		top: `${50 + 50 * Math.cos(angle * DEG)}%`,
		transform: `translate(-50%, 0) rotate(${angle + 180}deg)`,
	};

	const halfTickStyle: CSSProperties | undefined = halfAngle != null ? {
		position: "absolute",
		display: "block",
		width: Math.round(2 * scale),
		height: Math.round(7 * scale),
		transformOrigin: "50% 0",
		backgroundColor: tickColor,
		zIndex: 4,
		opacity: 0.6,
		left: `${50 - 50 * Math.sin(halfAngle * DEG)}%`,
		top: `${50 + 50 * Math.cos(halfAngle * DEG)}%`,
		transform: `translate(-50%, 0) rotate(${halfAngle + 180}deg)`,
	} : undefined;

	return (
		<>
			<div style={labelStyle}>{formatLabel(tick.value)}</div>
			<div style={mainTickStyle} />
			{halfTickStyle && <div style={halfTickStyle} />}
		</>
	);
}

export default Gauge;
