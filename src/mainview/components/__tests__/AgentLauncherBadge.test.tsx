import { render, screen } from "@testing-library/react";
import type { CodingAgent } from "../../../shared/types";
import AgentLauncherBadge, { resolveAgentLauncherIcon } from "../AgentLauncherBadge";
import { ClaudeIcon, CodexIcon, CopilotIcon, CursorIcon, GeminiIcon, OpenCodeIcon } from "../agent-launcher-icons";

const agent = (id: string, name: string, baseCommand = name.toLowerCase()): CodingAgent => ({
	id,
	name,
	baseCommand,
	configurations: [],
});

describe("AgentLauncherBadge", () => {
	it.each([
		[agent("builtin-claude", "Claude"), ClaudeIcon],
		[agent("builtin-codex", "Codex"), CodexIcon],
		[agent("builtin-gemini", "Gemini"), GeminiIcon],
		[agent("builtin-cursor", "Cursor", "cursor-agent"), CursorIcon],
		[agent("builtin-opencode", "OpenCode"), OpenCodeIcon],
		[agent("builtin-copilot", "Copilot"), CopilotIcon],
		[agent("custom-1", "My Claude wrapper", "my-wrapper"), ClaudeIcon],
	])("resolves %o to its brand mark", (a, icon) => {
		expect(resolveAgentLauncherIcon(a)).toBe(icon);
	});

	it("renders nothing for an agent without a known brand", () => {
		const { container } = render(<AgentLauncherBadge agent={agent("custom-2", "Aider", "aider")} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("labels the badge with the agent name and sizes the mark", () => {
		const { container } = render(<AgentLauncherBadge agent={agent("builtin-claude", "Claude")} size={12} />);
		expect(screen.getByRole("img", { name: "Claude" })).toBeInTheDocument();
		const svg = container.querySelector("svg");
		expect(svg).toHaveAttribute("width", "12");
		expect(svg).toHaveAttribute("height", "12");
	});

	it("gives every gradient mark its own ids so two badges never share a fill", () => {
		const codex = agent("builtin-codex", "Codex");
		const { container } = render(
			<>
				<AgentLauncherBadge agent={codex} />
				<AgentLauncherBadge agent={codex} />
			</>,
		);
		const ids = [...container.querySelectorAll("linearGradient")].map((g) => g.id);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
		for (const id of ids) expect(container.querySelector(`path[fill="url(#${id})"]`)).not.toBeNull();
	});
});
