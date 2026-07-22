import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cwd = process.cwd();
const mainviewRoot = cwd.endsWith(join("src", "mainview")) ? cwd : resolve(cwd, "src/mainview");
const LAB_SOURCES = [
	resolve(mainviewRoot, "labs/native-pane/NativePaneLayoutLab.tsx"),
	resolve(mainviewRoot, "labs/native-pane/fake-terminal.ts"),
	resolve(mainviewRoot, "labs/native-pane/stress.ts"),
];

describe("native pane layout lab isolation sentinel", () => {
	it("keeps the SplitTree model free of runtime and platform dependencies", () => {
		const source = readFileSync(resolve(mainviewRoot, "../shared/split-tree.ts"), "utf8");
		expect(source).not.toMatch(/^\s*import\s/m);
		expect(source).not.toMatch(/\b(?:React|tmux|Bun\.Terminal|WebSocket|api\.request|node:fs)\b/i);
	});

	it("prevents the fake renderer lab from invoking tmux, RPC, PTY, or real terminal surfaces", () => {
		const source = LAB_SOURCES.map((url) => readFileSync(url, "utf8")).join("\n");
		expect(source).not.toMatch(/\b(?:tmux|Bun\.Terminal|WebSocket|api\.request|TerminalView)\b/i);
		expect(source).not.toMatch(/from\s+["'][^"']*(?:rpc|tmux|pty)[^"']*["']/i);
	});
});
