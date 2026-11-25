import { describe, it, expect } from "vitest";
import {
	DEV_SERVER_LOG_TRIM_NOTICE,
	DevServerLogFilter,
	devServerLogPath,
	tailLines,
	trimLogContent,
} from "../../shared/dev-server-log";

const ESC = "\u001b";

describe("devServerLogPath", () => {
	it("sits beside the worktree, never inside it", () => {
		expect(devServerLogPath("/root/task")).toBe("/root/task/logs/dev-server.log");
	});
});

describe("DevServerLogFilter", () => {
	it("emits only complete lines", () => {
		const filter = new DevServerLogFilter();
		expect(filter.push("VITE ready")).toBe("");
		expect(filter.push(" in 300ms\n")).toBe("VITE ready in 300ms\n");
	});

	it("strips SGR colour, OSC titles, charset designations and control bytes, but keeps tabs", () => {
		const cases: Array<[string, string, string]> = [
			["SGR (a coloured line still greps)", `${ESC}[32mready${ESC}[0m on ${ESC}[1m5173${ESC}[22m\n`, "ready on 5173\n"],
			["OSC title", `${ESC}]0;vite dev\u0007built\n`, "built\n"],
			["charset designation every shell prompt leaves", `${ESC}(Bplain text${ESC}(B\n`, "plain text\n"],
			["control bytes", "col\tvalue\u0000\u0007\n", "col\tvalue\n"],
		];
		for (const [name, input, output] of cases) {
			expect(new DevServerLogFilter().push(input), name).toBe(output);
		}
	});

	it("never lets an escape split across two chunks leak its tail", () => {
		const filter = new DevServerLogFilter();
		const whole = `${ESC}[32mdone${ESC}[0m\n`;
		const cut = 2;
		let out = filter.push(whole.slice(0, cut));
		out += filter.push(whole.slice(cut));
		expect(out).toBe("done\n");
	});

	it("collapses progress-bar redraws, normalises CRLF, and keeps blank lines", () => {
		expect(new DevServerLogFilter().push("build 10%\rbuild 60%\rbuild 100%\n")).toBe("build 100%\n");
		expect(new DevServerLogFilter().push("windows line\r\nsecond\r\n")).toBe("windows line\nsecond\n");
		expect(new DevServerLogFilter().push("a\n\nb\n")).toBe("a\n\nb\n");
	});

	it("flushes a held partial line, terminated, but never half an escape", () => {
		const filter = new DevServerLogFilter();
		expect(filter.push("$ waiting for input")).toBe("");
		expect(filter.flush()).toBe("$ waiting for input\n");
		expect(filter.flush()).toBe("");

		// A partial escape is held back on flush rather than written half.
		const escaped = new DevServerLogFilter();
		escaped.push(`text${ESC}[3`);
		expect(escaped.flush()).toBe("");
	});
});

describe("tailLines", () => {
	it("returns the newest lines, everything when asked for more, nothing for a non-positive count", () => {
		expect(tailLines("a\nb\nc\n", 2)).toBe("b\nc");
		expect(tailLines("a\nb\n", 10)).toBe("a\nb");
		expect(tailLines("a\nb\n", 0)).toBe("");
	});
});

describe("trimLogContent", () => {
	it("leaves a small log alone, and keeps a big one's tail, line-aligned, behind a notice", () => {
		expect(trimLogContent("short\n", 1000)).toBe("short\n");
		const content = `${"x".repeat(50)}\nkept line one\nkept line two\n`;
		const trimmed = trimLogContent(content, 30);
		expect(trimmed.startsWith(`${DEV_SERVER_LOG_TRIM_NOTICE}\n`)).toBe(true);
		expect(trimmed).toContain("kept line two\n");
		expect(trimmed).not.toContain("xxxxx");
		expect(trimmed.split("\n")[1]).toBe("kept line one");
	});
});
