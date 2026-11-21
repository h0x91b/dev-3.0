import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GlobalSettings } from "../../../../shared/types";
import AgentEnvDefaultsSection from "../AgentEnvDefaultsSection";

vi.mock("../../../i18n", () => ({ useT: () => (key: string) => key }));

const { impact, confirmMock } = vi.hoisted(() => ({ impact: vi.fn(), confirmMock: vi.fn() }));
vi.mock("../../../rpc", () => ({ api: { request: { claudeFolderSwitchImpact: impact } } }));
vi.mock("../../../confirm", () => ({ confirm: confirmMock }));

const t = Object.assign((key: string) => key, {
	plural: (key: string, count: number, vars?: Record<string, string>) => `${key}:${count}:${vars?.projects}`,
}) as never;

beforeEach(() => {
	impact.mockReset().mockResolvedValue({ taskCount: 0, projectNames: [] });
	confirmMock.mockReset();
});

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

	it("turns the per-project Claude folder on and off without touching other keys", async () => {
		const { onChange } = renderSection({ agentEnvDefaults: { A: "1" } });
		const toggle = screen.getByRole("switch", { name: "settings.projectClaudeFolder" });
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		fireEvent.click(toggle);
		await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ A: "1", CLAUDE_CONFIG_DIR: "{projectPath}/.claude" }));
		expect(confirmMock).not.toHaveBeenCalled();
	});

	it("shows the switch on when the default is set, and clears the setting when it was the only key", async () => {
		const { onChange } = renderSection({ agentEnvDefaults: { CLAUDE_CONFIG_DIR: "{projectPath}/.claude" } });
		const toggle = screen.getByRole("switch", { name: "settings.projectClaudeFolder" });
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		fireEvent.click(toggle);
		await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(undefined));
	});

	it("keeps a just-saved text edit when the switch is clicked right after", async () => {
		const { onChange, textarea } = renderSection();
		fireEvent.change(textarea, { target: { value: "B=2" } });
		fireEvent.blur(textarea);
		fireEvent.click(screen.getByRole("switch", { name: "settings.projectClaudeFolder" }));
		await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ B: "2", CLAUDE_CONFIG_DIR: "{projectPath}/.claude" }));
	});

	it("reads a trailing-slash spelling of the default as the switch being on", () => {
		renderSection({ agentEnvDefaults: { CLAUDE_CONFIG_DIR: "{projectPath}/.claude/" } });
		expect(screen.getByRole("switch", { name: "settings.projectClaudeFolder" }).getAttribute("aria-checked")).toBe("true");
	});

	it("asks first when the switch would change the folder of active tasks, and keeps it on cancel", async () => {
		impact.mockResolvedValue({ taskCount: 2, projectNames: ["web", "api"] });
		confirmMock.mockResolvedValue(false);
		const { onChange } = renderSection();
		fireEvent.click(screen.getByRole("switch", { name: "settings.projectClaudeFolder" }));
		await waitFor(() => expect(confirmMock).toHaveBeenCalledOnce());
		expect(impact).toHaveBeenCalledWith({ enabled: true });
		expect(confirmMock.mock.calls[0][0]).toMatchObject({
			message: "settings.projectClaudeFolderConfirmMessage:2:web, api",
			confirmLabel: "settings.projectClaudeFolderConfirmOn",
		});
		expect(onChange).not.toHaveBeenCalled();
	});

	it("flips the switch once the user confirms", async () => {
		impact.mockResolvedValue({ taskCount: 1, projectNames: ["web"] });
		confirmMock.mockResolvedValue(true);
		const { onChange } = renderSection({ agentEnvDefaults: { CLAUDE_CONFIG_DIR: "{projectPath}/.claude" } });
		fireEvent.click(screen.getByRole("switch", { name: "settings.projectClaudeFolder" }));
		await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(undefined));
		expect(impact).toHaveBeenCalledWith({ enabled: false });
	});
});
