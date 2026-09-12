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

	it("strips SGR colour so a coloured line still greps", () => {
		const filter = new DevServerLogFilter();
		expect(filter.push(`${ESC}[32mready${ESC}[0m on ${ESC}[1m5173${ESC}[22m\n`)).toBe("ready on 5173\n");
	});

	it("strips an OSC title sequence", () => {
		const filter = new DevServerLogFilter();
		expect(filter.push(`${ESC}]0;vite dev\u0007built\n`)).toBe("built\n");
	});

	it("strips a charset designation, which every shell prompt leaves behind", () => {
		const filter = new DevServerLogFilter();
		expect(filter.push(`${ESC}(Bplain text${ESC}(B\n`)).toBe("plain text\n");
	});

	it("never lets an escape split across two chunks leak its tail", () => {
		const filter = new DevServerLogFilter();
		const whole = `${ESC}[32mdone${ESC}[0m\n`;
		const cut = 2;
		let out = filter.push(whole.slice(0, cut));
		out += filter.push(whole.slice(cut));
		expect(out).toBe("done\n");
	});

	it("collapses a progress bar's redraws into the line it ended on", () => {
		const filter = new DevServerLogFilter();
		expect(filter.push("build 10%\rbuild 60%\rbuild 100%\n")).toBe("build 100%\n");
	});

	it("normalises CRLF", () => {
		const filter = new DevServerLogFilter();
		expect(filter.push("windows line\r\nsecond\r\n")).toBe("windows line\nsecond\n");
	});

	it("keeps blank lines", () => {
		const filter = new DevServerLogFilter();
		expect(filter.push("a\n\nb\n")).toBe("a\n\nb\n");
	});

	it("drops remaining control bytes but keeps tabs", () => {
		const filter = new DevServerLogFilter();
		expect(filter.push("col\tvalue\u0000\u0007\n")).toBe("col\tvalue\n");
	});

	it("flushes a held partial line, terminated", () => {
		const filter = new DevServerLogFilter();
		expect(filter.push("$ waiting for input")).toBe("");
		expect(filter.flush()).toBe("$ waiting for input\n");
		expect(filter.flush()).toBe("");
	});

	it("holds a partial escape back on flush rather than writing half of it", () => {
		const filter = new DevServerLogFilter();
		filter.push(`text${ESC}[3`);
		expect(filter.flush()).toBe("");
	});
});

describe("tailLines", () => {
	it("returns the newest lines", () => {
		expect(tailLines("a\nb\nc\n", 2)).toBe("b\nc");
	});

	it("returns everything when asked for more than there is", () => {
		expect(tailLines("a\nb\n", 10)).toBe("a\nb");
	});

	it("returns nothing for a non-positive count", () => {
		expect(tailLines("a\nb\n", 0)).toBe("");
	});
});

describe("trimLogContent", () => {
	it("leaves a small log alone", () => {
		expect(trimLogContent("short\n", 1000)).toBe("short\n");
	});

	it("keeps the tail, aligned to a line boundary, behind a notice", () => {
		const content = `${"x".repeat(50)}\nkept line one\nkept line two\n`;
		const trimmed = trimLogContent(content, 30);
		expect(trimmed.startsWith(`${DEV_SERVER_LOG_TRIM_NOTICE}\n`)).toBe(true);
		expect(trimmed).toContain("kept line two\n");
		expect(trimmed).not.toContain("xxxxx");
		expect(trimmed.split("\n")[1]).toBe("kept line one");
	});
});
