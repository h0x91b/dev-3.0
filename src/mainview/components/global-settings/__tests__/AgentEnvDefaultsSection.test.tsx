import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { GlobalSettings } from "../../../../shared/types";
import AgentEnvDefaultsSection from "../AgentEnvDefaultsSection";

vi.mock("../../../i18n", () => ({ useT: () => (key: string) => key }));

const t = ((key: string) => key) as never;

function renderSection(settings: Partial<GlobalSettings> = {}) {
	const onChange = vi.fn();
	render(<AgentEnvDefaultsSection t={t} globalSettings={settings as GlobalSettings} onChange={onChange} />);
	return { onChange, textarea: screen.getByRole("textbox", { name: "settings.agentEnvDefaults" }) };
}

describe("AgentEnvDefaultsSection", () => {
	it("saves the parsed defaults once, on blur", () => {
		const { onChange, textarea } = renderSection();
		fireEvent.change(textarea, { target: { value: "CLAUDE_CONFIG_DIR={home}/.claude-projects/{projectName}" } });
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.blur(textarea);
		expect(onChange).toHaveBeenCalledExactlyOnceWith({ CLAUDE_CONFIG_DIR: "{home}/.claude-projects/{projectName}" });
	});

	it("clears the setting when the text is emptied", () => {
		const { onChange, textarea } = renderSection({ agentEnvDefaults: { A: "1" } });
		fireEvent.change(textarea, { target: { value: "" } });
		fireEvent.blur(textarea);
		expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined);
	});

	it("does not save invalid text or an unchanged value", () => {
		const { onChange, textarea } = renderSection({ agentEnvDefaults: { A: "1" } });
		fireEvent.blur(textarea);
		fireEvent.change(textarea, { target: { value: "not a line" } });
		fireEvent.blur(textarea);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("never saves a partial value while the text has an invalid line", () => {
		const { onChange, textarea } = renderSection({ agentEnvDefaults: { A: "1" } });
		fireEvent.change(textarea, { target: { value: "A=1\nB=2" } });
		fireEvent.change(textarea, { target: { value: "A=1\nB=2\noops" } });
		fireEvent.blur(textarea);
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.change(textarea, { target: { value: "A=1\nB=2" } });
		fireEvent.blur(textarea);
		expect(onChange).toHaveBeenCalledExactlyOnceWith({ A: "1", B: "2" });
	});

	it("turns the per-project Claude folder on and off without touching other keys", () => {
		const { onChange } = renderSection({ agentEnvDefaults: { A: "1" } });
		const toggle = screen.getByRole("switch", { name: "settings.projectClaudeFolder" });
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		fireEvent.click(toggle);
		expect(onChange).toHaveBeenLastCalledWith({ A: "1", CLAUDE_CONFIG_DIR: "{projectPath}/.claude" });
	});

	it("shows the switch on when the default is set, and clears the setting when it was the only key", () => {
		const { onChange } = renderSection({ agentEnvDefaults: { CLAUDE_CONFIG_DIR: "{projectPath}/.claude" } });
		const toggle = screen.getByRole("switch", { name: "settings.projectClaudeFolder" });
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		fireEvent.click(toggle);
		expect(onChange).toHaveBeenLastCalledWith(undefined);
	});

	it("keeps a just-saved text edit when the switch is clicked right after", () => {
		const { onChange, textarea } = renderSection();
		fireEvent.change(textarea, { target: { value: "B=2" } });
		fireEvent.blur(textarea);
		fireEvent.click(screen.getByRole("switch", { name: "settings.projectClaudeFolder" }));
		expect(onChange).toHaveBeenLastCalledWith({ B: "2", CLAUDE_CONFIG_DIR: "{projectPath}/.claude" });
	});

	it("reads a trailing-slash spelling of the default as the switch being on", () => {
		renderSection({ agentEnvDefaults: { CLAUDE_CONFIG_DIR: "{projectPath}/.claude/" } });
		expect(screen.getByRole("switch", { name: "settings.projectClaudeFolder" }).getAttribute("aria-checked")).toBe("true");
	});
});
