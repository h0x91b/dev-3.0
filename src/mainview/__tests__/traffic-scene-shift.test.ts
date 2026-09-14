import { renderHook } from "@testing-library/react";
import {
	sceneSignature,
	useSceneShift,
} from "../components/agent-traffic/scene-shift";
import type { TrafficScene } from "../components/agent-traffic/nodes-layout";

const scene = (
	keys: string[],
	positions: number[] = keys.map((_, index) => index * 100),
	size = { width: 900, height: 400 },
): TrafficScene =>
	({
		...size,
		placed: keys.map((key, index) => ({
			node: { key },
			x: positions[index],
			y: 0,
		})),
		groups: [],
		edges: [],
	}) as unknown as TrafficScene;

it("keeps one signature while the same cards only change slot", () => {
	const before = sceneSignature(scene(["a", "b", "c"], [0, 100, 200]));
	const after = sceneSignature(scene(["c", "a", "b"], [0, 100, 200]));
	expect(after).toBe(before);
});

it("changes signature when a card arrives or the box grows", () => {
	const base = sceneSignature(scene(["a", "b"]));
	expect(sceneSignature(scene(["a", "b", "c"]))).not.toBe(base);
	expect(sceneSignature(scene(["a", "b"], [0, 100], { width: 1200, height: 400 }))).not.toBe(base);
});

it("allows the slide only from the second render of one scene", () => {
	const { result, rerender } = renderHook(({ s }) => useSceneShift(s), {
		initialProps: { s: scene(["a", "b"], [0, 100]) },
	});
	// First sight of a scene: positions are wherever the layout says, nothing slides.
	expect(result.current).toBe(false);

	rerender({ s: scene(["b", "a"], [0, 100]) });
	expect(result.current).toBe(true);

	// A new card re-lays the whole scene out: no eighty-card glide.
	rerender({ s: scene(["a", "b", "c"]) });
	expect(result.current).toBe(false);
});
