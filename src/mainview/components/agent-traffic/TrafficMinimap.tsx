import { useRef, type PointerEvent } from "react";
import { useT } from "../../i18n";
import type { TrafficScene } from "./nodes-layout";

interface View { x: number; y: number; scale: number }

export default function TrafficMinimap({ scene, selected, view, width, height, onNavigate, onFit }: {
	scene: TrafficScene;
	selected: string | null;
	view: View;
	width: number;
	height: number;
	onNavigate: (view: View) => void;
	onFit: () => void;
}) {
	const t = useT();
	const svg = useRef<SVGSVGElement>(null);
	const drag = useRef<{ id: number; x: number; y: number; scale: number } | null>(null);
	const point = (event: PointerEvent) => {
		const matrix = svg.current?.getScreenCTM();
		if (!matrix) return null;
		// SVG's matrix includes letterboxing and any ancestor's entrance transform.
		return new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
	};
	const navigate = (x: number, y: number, scale: number) => onNavigate({
		x: width / 2 - x * scale,
		y: height / 2 - y * scale,
		scale,
	});
	return (
		<button
			type="button"
			className="traffic-minimap"
			aria-label={t("traffic.nodes.minimap")}
			title={t("traffic.nodes.minimapHelp")}
			aria-description={t("traffic.nodes.minimapHelp")}
			onWheel={(event) => event.stopPropagation()}
			onClick={(event) => { if (event.detail === 0) onFit(); }}
			onKeyDown={(event) => {
				const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
				if (event.key === "Home") {
					event.preventDefault();
					event.stopPropagation();
					onFit();
				} else if (delta) {
					event.preventDefault();
					event.stopPropagation();
					const step = event.shiftKey ? 240 : 80;
					onNavigate({ ...view, x: view.x - delta[0] * step, y: view.y - delta[1] * step });
				}
			}}
			onPointerDown={(event) => {
				event.stopPropagation();
				if (event.button !== 0 || drag.current) return;
				const p = point(event);
				if (!p) return;
				const centerX = (width / 2 - view.x) / view.scale;
				const centerY = (height / 2 - view.y) / view.scale;
				const inside = Math.abs(p.x - centerX) <= width / view.scale / 2 &&
					Math.abs(p.y - centerY) <= height / view.scale / 2;
				drag.current = { id: event.pointerId, x: inside ? centerX - p.x : 0, y: inside ? centerY - p.y : 0, scale: view.scale };
				event.currentTarget.setPointerCapture(event.pointerId);
				event.currentTarget.focus({ preventScroll: true });
				navigate(p.x + drag.current.x, p.y + drag.current.y, view.scale);
			}}
			onPointerMove={(event) => {
				if (drag.current?.id !== event.pointerId) return;
				const p = point(event);
				if (p) navigate(p.x + drag.current.x, p.y + drag.current.y, drag.current.scale);
			}}
			onPointerUp={(event) => {
				if (drag.current?.id !== event.pointerId) return;
				drag.current = null;
				event.currentTarget.releasePointerCapture(event.pointerId);
			}}
			onPointerCancel={() => { drag.current = null; }}
			onLostPointerCapture={() => { drag.current = null; }}
		>
			<svg ref={svg} viewBox={`0 0 ${scene.width} ${scene.height}`} aria-hidden="true">
				{scene.placed.map((p) => (
					<rect key={p.node.key}
						className={`traffic-minimap-node ${p.hub ? "is-hub" : ""} ${selected === p.node.key ? "is-selected" : ""}`}
						x={p.x} y={p.y} width={p.width} height={p.height} rx={8} />
				))}
				<rect className="traffic-minimap-view" x={-view.x / view.scale} y={-view.y / view.scale}
					width={width / view.scale} height={height / view.scale} />
			</svg>
			<span>{t.plural("traffic.nodes.nodeCount", scene.placed.length)}</span>
		</button>
	);
}
