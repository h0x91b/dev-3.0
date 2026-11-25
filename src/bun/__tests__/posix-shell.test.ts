import { describe, expect, it } from "vitest";
import { resolvePosixShell, shellFlavorOf } from "../../shared/posix-shell";

/** Only the named paths "exist" on this imaginary machine. */
function machine(...installed: string[]) {
	const set = new Set(installed);
	return (path: string) => set.has(path);
}

const MAC = machine("/bin/zsh", "/bin/bash", "/bin/sh");
const MINIMAL_LINUX = machine("/bin/sh");

describe("shellFlavorOf", () => {
	it("names the three configured flavors, reads dash/ash as sh, strips a login dash, and rejects the rest", () => {
		expect(shellFlavorOf("/bin/zsh")).toBe("zsh");
		expect(shellFlavorOf("/opt/homebrew/bin/bash")).toBe("bash");
		expect(shellFlavorOf("/bin/sh")).toBe("sh");
		// dash and busybox ash are a POSIX sh — that is what /bin/sh is on Debian.
		expect(shellFlavorOf("/bin/dash")).toBe("sh");
		expect(shellFlavorOf("/bin/ash")).toBe("sh");
		// The login dash a passwd entry can carry.
		expect(shellFlavorOf("-zsh")).toBe("zsh");
		expect(shellFlavorOf("/usr/local/bin/fish")).toBeNull();
		expect(shellFlavorOf("")).toBeNull();
		expect(shellFlavorOf(null)).toBeNull();
	});
});

describe("resolvePosixShell — auto", () => {
	it("keeps the account shell, even one dev3 does not configure, rather than switching the user's terminal", () => {
		expect(resolvePosixShell({ accountShell: "/bin/bash", exists: MAC })).toEqual({
			path: "/bin/bash",
			flavor: "bash",
			requested: "auto",
			fellBack: false,
		});
		const fishMachine = machine("/usr/local/bin/fish", "/bin/zsh");
		expect(resolvePosixShell({ accountShell: "/usr/local/bin/fish", exists: fishMachine })).toMatchObject({
			path: "/usr/local/bin/fish",
			flavor: null,
		});
	});

	it("falls through to $SHELL for an empty account record, and ignores a recorded shell that is not installed", () => {
		expect(resolvePosixShell({ accountShell: null, envShell: "/bin/zsh", exists: MAC }).path).toBe("/bin/zsh");
		expect(resolvePosixShell({ accountShell: "/bin/zsh", exists: MINIMAL_LINUX }).path).toBe("/bin/sh");
	});

	it("with nothing recorded prefers zsh, and lands on sh on a minimal Linux box", () => {
		expect(resolvePosixShell({ exists: MAC }).path).toBe("/bin/zsh");
		expect(resolvePosixShell({ exists: MINIMAL_LINUX })).toEqual({
			path: "/bin/sh",
			flavor: "sh",
			requested: "auto",
			fellBack: false,
		});
	});
});

describe("resolvePosixShell — explicit preference", () => {
	it("honours the chosen flavor, using the user's own binary so a homebrew zsh wins over /bin/zsh", () => {
		expect(resolvePosixShell({ preference: "sh", accountShell: "/bin/zsh", exists: MAC })).toEqual({
			path: "/bin/sh",
			flavor: "sh",
			requested: "sh",
			fellBack: false,
		});
		const brew = machine("/opt/homebrew/bin/zsh", "/bin/zsh", "/bin/sh");
		expect(resolvePosixShell({ preference: "zsh", accountShell: "/opt/homebrew/bin/zsh", exists: brew }).path).toBe(
			"/opt/homebrew/bin/zsh",
		);
	});

	it("falls back (bash before sh) and says so, never returning a shell-less answer", () => {
		expect(resolvePosixShell({ preference: "zsh", exists: MINIMAL_LINUX })).toEqual({
			path: "/bin/sh",
			flavor: "sh",
			requested: "zsh",
			fellBack: true,
		});
		expect(resolvePosixShell({ preference: "zsh", exists: machine("/bin/bash", "/bin/sh") })).toMatchObject({
			path: "/bin/bash",
			fellBack: true,
		});
		expect(resolvePosixShell({ preference: "bash", exists: machine() })).toEqual({
			path: "/bin/sh",
			flavor: "sh",
			requested: "bash",
			fellBack: true,
		});
	});
});
