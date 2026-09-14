import { useEffect, useRef } from "react";
import type { TrafficScene } from "./nodes-layout";

/**
 * The same cards in the same box, whatever order they sit in.
 *
 * Keys are joined sorted: a card that only changed slot must read as the same
 * scene, which is exactly the case the slide exists for.
 */
export function sceneSignature(scene: TrafficScene): string {
	const keys = scene.placed.map((placed) => placed.node.key).sort();
	return `${scene.width}x${scene.height}|${keys.join(",")}`;
}

/**
 * Whether cards may slide to their new slot on this render.
 *
 * A card's slot comes from its board column, so a status change relocates it —
 * and everything behind it shifts one place up. That move is the clearest signal
 * on the stage that something happened, but only while the scene is the same
 * scene: a filter toggle, an arrival or a resize re-lays everything out, and
 * eighty cards gliding at once reads as a glitch rather than as a board move.
 */
export function useSceneShift(scene: TrafficScene): boolean {
	const previous = useRef<string | null>(null);
	const signature = sceneSignature(scene);
	const same = previous.current === signature;
	useEffect(() => {
		previous.current = signature;
	}, [signature]);
	return same;
}
