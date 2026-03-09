import { useState, useEffect, useCallback } from "react";

interface Dims {
	innerW: number;
	innerH: number;
	clientW: number;
	clientH: number;
	rootW: number;
	rootH: number;
	bodyW: number;
	bodyH: number;
	dvhH: number;
	svhH: number;
	lvhH: number;
	visualW: number;
	visualH: number;
	visualScale: number;
	visualOffsetTop: number;
	dpr: number;
	screenW: number;
	screenH: number;
}

function measure(): Dims {
	const root = document.getElementById("root");

	function measureUnit(unit: string): number {
		const probe = document.createElement("div");
		probe.style.cssText = `position:fixed;top:0;height:100${unit};pointer-events:none;visibility:hidden`;
		document.body.appendChild(probe);
		const h = probe.offsetHeight;
		probe.remove();
		return h;
	}

	const vv = window.visualViewport;
	return {
		innerW: window.innerWidth,
		innerH: window.innerHeight,
		clientW: document.documentElement.clientWidth,
		clientH: document.documentElement.clientHeight,
		rootW: root?.clientWidth ?? 0,
		rootH: root?.clientHeight ?? 0,
		bodyW: document.body.clientWidth,
		bodyH: document.body.clientHeight,
		dvhH: measureUnit("dvh"),
		svhH: measureUnit("svh"),
		lvhH: measureUnit("lvh"),
		visualW: vv?.width ?? 0,
		visualH: vv?.height ?? 0,
		visualScale: vv?.scale ?? 1,
		visualOffsetTop: vv?.offsetTop ?? 0,
		dpr: window.devicePixelRatio,
		screenW: screen.width,
		screenH: screen.height,
	};
}

interface ViewportLabProps {
	navigate: (route: { screen: "dashboard" }) => void;
}

export function ViewportLab({ navigate }: ViewportLabProps) {
	const [dims, setDims] = useState<Dims>(measure);
	const [markerH, setMarkerH] = useState(32);

	const refresh = useCallback(() => setDims(measure()), []);

	useEffect(() => {
		window.addEventListener("resize", refresh);
		window.visualViewport?.addEventListener("resize", refresh);
		return () => {
			window.removeEventListener("resize", refresh);
			window.visualViewport?.removeEventListener("resize", refresh);
		};
	}, [refresh]);

	const rows: [string, string | number][] = [
		["window.innerWidth x innerHeight", `${dims.innerW} x ${dims.innerH}`],
		["documentElement.clientWidth x clientHeight", `${dims.clientW} x ${dims.clientH}`],
		["body.clientWidth x clientHeight", `${dims.bodyW} x ${dims.bodyH}`],
		["#root.clientWidth x clientHeight", `${dims.rootW} x ${dims.rootH}`],
		["100dvh (measured)", `${dims.dvhH}px`],
		["100svh (measured)", `${dims.svhH}px`],
		["100lvh (measured)", `${dims.lvhH}px`],
		["visualViewport (w x h)", `${Math.round(dims.visualW)} x ${Math.round(dims.visualH)}`],
		["visualViewport.scale", dims.visualScale.toFixed(3)],
		["visualViewport.offsetTop", `${dims.visualOffsetTop}px`],
		["devicePixelRatio", dims.dpr.toFixed(2)],
		["screen (w x h)", `${dims.screenW} x ${dims.screenH}`],
	];

	const deltaInnerClient = dims.innerH - dims.clientH;
	const deltaInnerDvh = dims.innerH - dims.dvhH;
	const deltaInnerVisual = dims.innerH - Math.round(dims.visualH);

	return (
		<div className="flex-1 overflow-y-auto p-6 space-y-6">
			{/* Header */}
			<div className="flex items-center gap-4">
				<button
					onClick={() => navigate({ screen: "dashboard" })}
					className="text-fg-3 hover:text-fg transition-colors text-sm"
				>
					&larr; Back
				</button>
				<h1 className="text-fg text-2xl font-bold flex-1">Viewport Lab</h1>
				<button
					onClick={refresh}
					className="px-3 py-1 text-xs font-semibold rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
				>
					Refresh
				</button>
			</div>

			{/* Dimensions table */}
			<div className="bg-elevated border border-edge rounded-lg overflow-hidden">
				<table className="w-full text-sm font-mono">
					<tbody>
						{rows.map(([label, value], i) => (
							<tr key={i} className={i % 2 === 0 ? "bg-elevated" : "bg-raised"}>
								<td className="px-4 py-2 text-fg-3">{label}</td>
								<td className="px-4 py-2 text-accent font-bold text-right">{value}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{/* Deltas */}
			<div className="bg-elevated border border-edge rounded-lg p-4 space-y-2">
				<div className="text-fg text-sm font-bold">Deltas (clipping indicators)</div>
				<div className="font-mono text-sm">
					<span className="text-fg-3">innerHeight - clientHeight = </span>
					<span className={`font-bold ${deltaInnerClient !== 0 ? "text-danger" : "text-fg"}`}>
						{deltaInnerClient}px
					</span>
				</div>
				<div className="font-mono text-sm">
					<span className="text-fg-3">innerHeight - 100dvh = </span>
					<span className={`font-bold ${deltaInnerDvh !== 0 ? "text-danger" : "text-fg"}`}>
						{deltaInnerDvh}px
					</span>
				</div>
				<div className="font-mono text-sm">
					<span className="text-fg-3">innerHeight - visualViewport.height = </span>
					<span className={`font-bold ${deltaInnerVisual !== 0 ? "text-danger" : "text-fg"}`}>
						{deltaInnerVisual}px
					</span>
				</div>
			</div>

			{/* Bottom edge marker controls */}
			<div className="bg-elevated border border-edge rounded-lg p-4 space-y-3">
				<div className="text-fg text-sm font-bold">Bottom edge marker</div>
				<p className="text-fg-3 text-xs">
					A gradient bar fixed to the very bottom of the viewport.
					Red fades into green at bottom=0. If the green line is clipped, that shows how many px are lost.
				</p>
				<div className="flex items-center gap-3">
					<span className="text-fg-3 text-xs">Height:</span>
					<input
						type="range"
						min={4}
						max={64}
						value={markerH}
						onChange={(e) => setMarkerH(Number(e.target.value))}
						className="w-40 accent-accent"
					/>
					<span className="text-fg-2 text-xs font-mono">{markerH}px</span>
				</div>
			</div>

			{/* Fixed bottom edge markers */}
			<div
				style={{
					position: "fixed",
					bottom: 0,
					left: 0,
					right: 0,
					height: `${markerH}px`,
					background: "linear-gradient(to bottom, transparent 0%, #ff0000 40%, #00ff00 100%)",
					zIndex: 9999,
					pointerEvents: "none",
				}}
			/>
			<div
				style={{
					position: "fixed",
					bottom: 0,
					left: "50%",
					transform: "translateX(-50%)",
					color: "#fff",
					fontSize: "10px",
					fontFamily: "monospace",
					zIndex: 10000,
					background: "rgba(0,0,0,0.8)",
					padding: "2px 8px",
					borderRadius: "4px 4px 0 0",
					pointerEvents: "none",
				}}
			>
				BOTTOM EDGE (green = bottom:0)
			</div>
		</div>
	);
}

export default ViewportLab;
