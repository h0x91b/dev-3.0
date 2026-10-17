import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AgentInstallNotice from "../AgentInstallNotice";
import { I18nProvider } from "../../i18n";
import { DEFAULT_AGENTS } from "../../../shared/types";
import type { AgentCheckResult } from "../../../shared/types";

const pi = DEFAULT_AGENTS.find((a) => a.id === "builtin-pi")!;

function renderNotice(check: Partial<AgentCheckResult>) {
	const full: AgentCheckResult = { agentId: pi.id, name: pi.name, baseCommand: "pi", installed: false, ...check };
	return render(
		<I18nProvider>
			<AgentInstallNotice id="n" state="ready" missing={{ agent: pi, check: full }} installedNow={null} onRecheck={() => {}} />
		</I18nProvider>,
	);
}

describe("AgentInstallNotice", () => {
	it("offers the alternative install beside the upstream one, each copied on its own", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		renderNotice({ installCommand: "curl -fsSL https://pi.dev/install.sh | sh", alternativeInstallCommand: "brew install pi-coding-agent" });

		expect(screen.getByTestId("agent-install-command").textContent).toBe("curl -fsSL https://pi.dev/install.sh | sh");
		expect(screen.getByTestId("agent-install-alternative").textContent).toBe("brew install pi-coding-agent");

		const copyButtons = screen.getAllByRole("button", { name: "Copy" });
		expect(copyButtons).toHaveLength(2);
		await userEvent.click(copyButtons[1]);
		expect(writeText).toHaveBeenCalledWith("brew install pi-coding-agent");
		await waitFor(() => expect(screen.getAllByRole("button", { name: "Copied" })).toHaveLength(1));
	});

	it("shows only the upstream command when the host has no alternative", () => {
		renderNotice({ installCommand: 'powershell -c "irm https://pi.dev/install.ps1 | iex"' });
		expect(screen.getByTestId("agent-install-command")).toBeTruthy();
		expect(screen.queryByTestId("agent-install-alternative")).toBeNull();
	});
});
