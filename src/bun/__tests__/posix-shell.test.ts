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
	it("names the three flavors dev3 configures", () => {
		expect(shellFlavorOf("/bin/zsh")).toBe("zsh");
		expect(shellFlavorOf("/opt/homebrew/bin/bash")).toBe("bash");
		expect(shellFlavorOf("/bin/sh")).toBe("sh");
	});

	it("treats dash and busybox ash as a POSIX sh — that is what /bin/sh is on Debian", () => {
		expect(shellFlavorOf("/bin/dash")).toBe("sh");
		expect(shellFlavorOf("/bin/ash")).toBe("sh");
	});

	it("strips the login dash a passwd entry can carry", () => {
		expect(shellFlavorOf("-zsh")).toBe("zsh");
	});

	it("returns null for a shell dev3 does not configure", () => {
		expect(shellFlavorOf("/usr/local/bin/fish")).toBeNull();
		expect(shellFlavorOf("")).toBeNull();
		expect(shellFlavorOf(null)).toBeNull();
	});
});

describe("resolvePosixShell — auto", () => {
	it("keeps the account shell", () => {
		expect(resolvePosixShell({ accountShell: "/bin/bash", exists: MAC })).toEqual({
			path: "/bin/bash",
			flavor: "bash",
			requested: "auto",
			fellBack: false,
		});
	});

	it("keeps a shell dev3 does not configure rather than switching the user's terminal under them", () => {
		const fishMachine = machine("/usr/local/bin/fish", "/bin/zsh");
		expect(resolvePosixShell({ accountShell: "/usr/local/bin/fish", exists: fishMachine })).toMatchObject({
			path: "/usr/local/bin/fish",
			flavor: null,
		});
	});

	it("falls through to $SHELL when the account record is empty", () => {
		expect(resolvePosixShell({ accountShell: null, envShell: "/bin/zsh", exists: MAC }).path).toBe("/bin/zsh");
	});

	it("ignores a recorded shell that is not installed", () => {
		expect(resolvePosixShell({ accountShell: "/bin/zsh", exists: MINIMAL_LINUX }).path).toBe("/bin/sh");
	});

	it("lands on sh where a minimal Linux box has neither zsh nor bash", () => {
		expect(resolvePosixShell({ exists: MINIMAL_LINUX })).toEqual({
			path: "/bin/sh",
			flavor: "sh",
			requested: "auto",
			fellBack: false,
		});
	});

	it("prefers zsh over bash when nothing is recorded", () => {
		expect(resolvePosixShell({ exists: MAC }).path).toBe("/bin/zsh");
	});
});

describe("resolvePosixShell — explicit preference", () => {
	it("honours the chosen flavor", () => {
		expect(resolvePosixShell({ preference: "sh", accountShell: "/bin/zsh", exists: MAC })).toEqual({
			path: "/bin/sh",
			flavor: "sh",
			requested: "sh",
			fellBack: false,
		});
	});

	it("uses the user's own binary when it is the chosen flavor, so a homebrew zsh wins over /bin/zsh", () => {
		const brew = machine("/opt/homebrew/bin/zsh", "/bin/zsh", "/bin/sh");
		expect(resolvePosixShell({ preference: "zsh", accountShell: "/opt/homebrew/bin/zsh", exists: brew }).path).toBe(
			"/opt/homebrew/bin/zsh",
		);
	});

	it("falls back and says so when the chosen shell is not installed", () => {
		expect(resolvePosixShell({ preference: "zsh", exists: MINIMAL_LINUX })).toEqual({
			path: "/bin/sh",
			flavor: "sh",
			requested: "zsh",
			fellBack: true,
		});
	});

	it("prefers bash over sh when the chosen zsh is missing but bash is there", () => {
		const noZsh = machine("/bin/bash", "/bin/sh");
		expect(resolvePosixShell({ preference: "zsh", exists: noZsh })).toMatchObject({
			path: "/bin/bash",
			fellBack: true,
		});
	});

	it("never returns a shell-less answer, even when nothing at all is installed", () => {
		expect(resolvePosixShell({ preference: "bash", exists: machine() })).toEqual({
			path: "/bin/sh",
			flavor: "sh",
			requested: "bash",
			fellBack: true,
		});
	});
});
