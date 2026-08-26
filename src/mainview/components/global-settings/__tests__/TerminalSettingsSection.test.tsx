import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ShellAvailability } from "../../../../shared/types";
import { I18nProvider, useT } from "../../../i18n";
import TerminalSettingsSection from "../TerminalSettingsSection";

vi.mock("../TerminalBackendSetting", () => ({ default: () => null }));

const MAC: ShellAvailability = {
	resolved: { path: "/bin/zsh", flavor: "zsh", requested: "auto", fellBack: false },
	installed: { zsh: "/bin/zsh", bash: "/bin/bash", sh: "/bin/sh" },
};

const MINIMAL_LINUX: ShellAvailability = {
	resolved: { path: "/bin/sh", flavor: "sh", requested: "zsh", fellBack: true },
	installed: { sh: "/bin/sh" },
};

function Harness(props: {
	availability: ShellAvailability | null;
	terminalShell?: "zsh" | "bash" | "sh";
	onTerminalShellChange: (shell: "zsh" | "bash" | "sh" | undefined) => void;
}) {
	const t = useT();
	return (
		<TerminalSettingsSection
			t={t}
			scrollSpeed={1}
			newTaskTerminalBackend={undefined}
			nativeTerminalAvailability={null}
			terminalPathOpenMode={undefined}
			terminalShell={props.terminalShell}
			shellAvailability={props.availability}
			onNewTaskTerminalBackendChange={vi.fn()}
			onTerminalPathOpenModeChange={vi.fn()}
			onTerminalShellChange={props.onTerminalShellChange}
		/>
	);
}

function renderSection(availability: ShellAvailability | null, terminalShell?: "zsh" | "bash" | "sh") {
	const onTerminalShellChange = vi.fn();
	render(
		<I18nProvider>
			<Harness
				availability={availability}
				terminalShell={terminalShell}
				onTerminalShellChange={onTerminalShellChange}
			/>
		</I18nProvider>,
	);
	return { onTerminalShellChange };
}

describe("TerminalSettingsSection — shell picker", () => {
	it("offers automatic plus the three flavors", () => {
		renderSection(MAC);
		expect(screen.getByRole("button", { name: "Automatic" })).toBeInTheDocument();
		for (const flavor of ["zsh", "bash", "sh"]) {
			expect(screen.getByRole("button", { name: flavor })).toBeInTheDocument();
		}
	});

	it("clears the setting back to auto-detect", async () => {
		const { onTerminalShellChange } = renderSection(MAC, "bash");
		await userEvent.click(screen.getByRole("button", { name: "Automatic" }));
		expect(onTerminalShellChange).toHaveBeenCalledWith(undefined);
	});

	it("stores the chosen flavor", async () => {
		const { onTerminalShellChange } = renderSection(MAC);
		await userEvent.click(screen.getByRole("button", { name: "sh" }));
		expect(onTerminalShellChange).toHaveBeenCalledWith("sh");
	});

	it("marks the shells this machine does not have", () => {
		renderSection(MINIMAL_LINUX);
		expect(screen.getByRole("button", { name: "zsh (not installed)" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "sh" })).toBeInTheDocument();
	});

	it("says which shell actually runs when the chosen one is missing", () => {
		renderSection(MINIMAL_LINUX, "zsh");
		expect(screen.getByText("zsh is not installed on this machine — using /bin/sh instead.")).toBeInTheDocument();
	});

	it("hides the picker on Windows, where there is no POSIX shell to choose", () => {
		renderSection({ resolved: null, installed: {} });
		expect(screen.queryByRole("button", { name: "Automatic" })).not.toBeInTheDocument();
	});
});
