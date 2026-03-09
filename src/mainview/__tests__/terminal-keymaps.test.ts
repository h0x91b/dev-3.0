import {
	TERMINAL_KEYMAPS,
	KEYMAP_LS_KEY,
	KEYMAP_CHANGED_EVENT,
	getKeymapPreset,
	setKeymapPreset,
} from "../terminal-keymaps";

beforeEach(() => {
	localStorage.clear();
});

describe("getKeymapPreset", () => {
	it("returns 'default' when nothing is stored", () => {
		expect(getKeymapPreset()).toBe("default");
	});

	it("returns 'iterm2' when iterm2 is stored", () => {
		localStorage.setItem(KEYMAP_LS_KEY, "iterm2");
		expect(getKeymapPreset()).toBe("iterm2");
	});

	it("normalizes legacy 'dev3' value to 'default'", () => {
		localStorage.setItem(KEYMAP_LS_KEY, "dev3");
		expect(getKeymapPreset()).toBe("default");
	});

	it("normalizes legacy 'tmux-native' value to 'default'", () => {
		localStorage.setItem(KEYMAP_LS_KEY, "tmux-native");
		expect(getKeymapPreset()).toBe("default");
	});
});

describe("setKeymapPreset", () => {
	it("persists to localStorage", () => {
		setKeymapPreset("iterm2");
		expect(localStorage.getItem(KEYMAP_LS_KEY)).toBe("iterm2");
	});

	it("dispatches the change event with the new preset as detail", () => {
		const handler = vi.fn();
		window.addEventListener(KEYMAP_CHANGED_EVENT, handler);
		setKeymapPreset("default");
		expect(handler).toHaveBeenCalledOnce();
		const event = handler.mock.calls[0][0] as CustomEvent;
		expect(event.detail).toBe("default");
		window.removeEventListener(KEYMAP_CHANGED_EVENT, handler);
	});

	it("makes getKeymapPreset return the new preset", () => {
		setKeymapPreset("iterm2");
		expect(getKeymapPreset()).toBe("iterm2");
	});
});

describe("TERMINAL_KEYMAPS", () => {
	it("default preset has no bindings", () => {
		expect(TERMINAL_KEYMAPS["default"]).toHaveLength(0);
	});

	it("iterm2 preset has 6 bindings", () => {
		expect(TERMINAL_KEYMAPS["iterm2"]).toHaveLength(6);
	});

	it("all iterm2 bindings use code (not key)", () => {
		for (const b of TERMINAL_KEYMAPS["iterm2"]) {
			expect(typeof b.code).toBe("string");
			expect(b.code.length).toBeGreaterThan(0);
		}
	});

	it("Cmd+W maps to killPane", () => {
		const binding = TERMINAL_KEYMAPS["iterm2"].find((b) => b.action === "killPane");
		expect(binding).toBeDefined();
		expect(binding!.code).toBe("KeyW");
		expect(binding!.meta).toBe(true);
	});

	it("Cmd+D (no shift) maps to splitV", () => {
		const binding = TERMINAL_KEYMAPS["iterm2"].find((b) => b.action === "splitV");
		expect(binding).toBeDefined();
		expect(binding!.code).toBe("KeyD");
		expect(binding!.meta).toBe(true);
		expect(binding!.shift).toBe(false);
	});

	it("Shift+Cmd+D maps to splitH", () => {
		const binding = TERMINAL_KEYMAPS["iterm2"].find((b) => b.action === "splitH");
		expect(binding).toBeDefined();
		expect(binding!.code).toBe("KeyD");
		expect(binding!.meta).toBe(true);
		expect(binding!.shift).toBe(true);
	});

	it("splitV and splitH share the same code but differ by shift", () => {
		const splitV = TERMINAL_KEYMAPS["iterm2"].find((b) => b.action === "splitV")!;
		const splitH = TERMINAL_KEYMAPS["iterm2"].find((b) => b.action === "splitH")!;
		expect(splitV.code).toBe(splitH.code);
		expect(splitV.shift).toBe(false);
		expect(splitH.shift).toBe(true);
	});
});
