import { describe, it, expect, vi } from "vitest";

// Reproduces the v1.29.2 startup crash: on installs with a poisoned
// (self-referential) ~/.dev3.0/bin/tmux shim, sanitizeTmuxShim() — which runs
// at module load — enters its catch branch and calls `log.warn`, but the
// module-level `const log = createLogger("pty")` was declared hundreds of
// lines BELOW the call site. The TDZ access crashed module evaluation, so the
// whole app died before showing a window — exactly on the machines the
// self-heal was supposed to fix. This file loads the module in that poisoned
// state; it must import cleanly and delete the broken shim.

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const isShim = (p: unknown) => typeof p === "string" && p.endsWith("/bin/tmux");
	return {
		...actual,
		existsSync: vi.fn(() => true),
		writeFileSync: vi.fn(),
		mkdirSync: vi.fn(),
		lstatSync: vi.fn((p: string) => {
			if (isShim(p)) return { isSymbolicLink: () => true } as never;
			throw new Error("ENOENT");
		}),
		readlinkSync: vi.fn((p: string) => {
			if (isShim(p)) return p; // self-referential
			throw new Error("EINVAL");
		}),
		realpathSync: vi.fn((p: string) => {
			if (isShim(p)) throw new Error("ELOOP: too many symbolic links encountered");
			return p;
		}),
		unlinkSync: vi.fn(),
		symlinkSync: vi.fn(),
	};
});

vi.mock("../spawn", () => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

import { unlinkSync } from "node:fs";

describe("pty-server module load with a poisoned tmux shim (v1.29.2 startup crash)", () => {
	it("imports cleanly and removes the self-referential shim", async () => {
		const mod = await import("../pty-server");
		expect(mod.TMUX_SHIM_PATH.endsWith("/bin/tmux")).toBe(true);
		expect(vi.mocked(unlinkSync)).toHaveBeenCalledWith(mod.TMUX_SHIM_PATH);
	});
});
