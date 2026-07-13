import { describe, expect, it } from "vitest";
import { isTaskTerminalRoute, terminalFullscreenShortcutLabel } from "../terminalFullscreen";

describe("terminal immersive fullscreen helpers", () => {
	it("only treats task terminal routes as fullscreen-capable", () => {
		expect(isTaskTerminalRoute({ screen: "task", projectId: "p1", taskId: "t1" })).toBe(true);
		expect(isTaskTerminalRoute({ screen: "project", projectId: "p1", activeTaskId: "t1" })).toBe(true);
		expect(isTaskTerminalRoute({ screen: "project", projectId: "p1" })).toBe(false);
		expect(isTaskTerminalRoute({ screen: "settings" })).toBe(false);
	});

	it("formats platform-aware shortcut labels", () => {
		expect(terminalFullscreenShortcutLabel(true)).toBe("F11 · ⌘⇧F");
		expect(terminalFullscreenShortcutLabel(false)).toBe("F11 · Ctrl+Shift+F");
	});
});
