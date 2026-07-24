// Guards the localStorage substitute installed by test-setup.ts — Node 26's
// experimental global shadows happy-dom's and is undefined without
// --localstorage-file, which took the whole mainview suite down (decision 164).

describe("test environment storage", () => {
	it("exposes a working localStorage on both globalThis and window", () => {
		localStorage.setItem("dev3-probe", "value");
		expect(localStorage.getItem("dev3-probe")).toBe("value");
		expect(window.localStorage.getItem("dev3-probe")).toBe("value");
		localStorage.removeItem("dev3-probe");
		expect(localStorage.getItem("dev3-probe")).toBeNull();
	});

	it("reports length and clears", () => {
		localStorage.clear();
		localStorage.setItem("a", "1");
		localStorage.setItem("b", "2");
		expect(localStorage.length).toBe(2);
		expect(localStorage.key(0)).toBe("a");
		localStorage.clear();
		expect(localStorage.length).toBe(0);
	});

	it("returns null for a missing key", () => {
		expect(localStorage.getItem("never-written")).toBeNull();
		expect(localStorage.key(99)).toBeNull();
	});
});
