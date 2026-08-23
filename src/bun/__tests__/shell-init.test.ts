import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { SHELL_INIT_DIR, writeShellInit } from "../shell-init";

describe("shell init word motion", () => {
	beforeAll(() => {
		writeShellInit();
	});

	it("binds modifier+arrow to word motion in zsh, after the user's .zshrc", () => {
		const zshrc = readFileSync(`${SHELL_INIT_DIR}/.zshrc`, "utf8");
		for (const [seq, widget] of [
			["^[[1;3D", "backward-word"],
			["^[[1;3C", "forward-word"],
			["^[[1;5D", "backward-word"],
			["^[[1;5C", "forward-word"],
		]) {
			expect(zshrc).toContain(`bindkey "${seq}" ${widget}`);
			// Order matters: sourcing the user's config later would clobber these.
			expect(zshrc.indexOf(seq)).toBeGreaterThan(zshrc.indexOf('source "$HOME/.zshrc"'));
		}
	});

	it("binds modifier+arrow to word motion in bash", () => {
		const bashrc = readFileSync(`${SHELL_INIT_DIR}/.bashrc`, "utf8");
		expect(bashrc).toContain(String.raw`bind '"\e[1;3D": backward-word'`);
		expect(bashrc).toContain(String.raw`bind '"\e[1;3C": forward-word'`);
		expect(bashrc).toContain(String.raw`bind '"\e[1;5D": backward-word'`);
		expect(bashrc).toContain(String.raw`bind '"\e[1;5C": forward-word'`);
	});
});
