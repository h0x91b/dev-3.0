import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellAvailability } from "../../../../shared/types";
import { I18nProvider, useT, type TFunction } from "../../../i18n";
import TerminalSettingsSection from "../TerminalSettingsSection";
import {
	bootstrapTerminalFont,
	DEFAULT_TERMINAL_FONT_SIZE,
	getTerminalFontFamily,
	getTerminalFontSize,
} from "../../../terminal-font";

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
			terminalFontFamily=""
			terminalFontSize={DEFAULT_TERMINAL_FONT_SIZE}
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

// The font tests read raw keys instead of English, so a copy change cannot turn a
// passing assertion red — they are about the control's behaviour, not its wording.
const t = Object.assign((key: string) => key, {
	plural: (key: string, count: number) => `${key}|${count}`,
}) as unknown as TFunction;

function renderFontSection(family = "", size = DEFAULT_TERMINAL_FONT_SIZE) {
	render(
		<I18nProvider>
			<TerminalSettingsSection
				t={t}
				scrollSpeed={2}
				terminalFontFamily={family}
				terminalFontSize={size}
				newTaskTerminalBackend="tmux"
				nativeTerminalAvailability={null}
				terminalPathOpenMode="preview"
				terminalShell={undefined}
				shellAvailability={MAC}
				onNewTaskTerminalBackendChange={vi.fn()}
				onTerminalPathOpenModeChange={vi.fn()}
				onTerminalShellChange={vi.fn()}
			/>
		</I18nProvider>,
	);
}

beforeEach(() => {
	localStorage.clear();
	bootstrapTerminalFont();
});

const realCreateElement = document.createElement;

afterEach(() => vi.restoreAllMocks());

describe("terminal font controls", () => {
	it("commits a family the app never shipped in its list", async () => {
		// The whole point of `allowCustom`: our shortlist cannot know what this
		// machine has installed, so typing a family must be enough.
		renderFontSection();
		const user = userEvent.setup();

		await user.click(screen.getByLabelText("settings.terminalFontFamily", { selector: "button" }));
		await user.type(screen.getByLabelText("settings.terminalFontFamily", { selector: "input" }), "Comic Mono");
		await user.click(screen.getByText(/Comic Mono/));

		expect(getTerminalFontFamily()).toBe("Comic Mono");
	});

	it("warns when the chosen family is not on this device, and stays quiet otherwise", () => {
		// Widths keyed off the first resolvable family, like a real canvas: a missing
		// family measures as its generic, an installed one does not.
		function stubCanvas(installed: string[]) {
			const widths: Record<string, number> = { monospace: 100, serif: 130, "sans-serif": 160 };
			const ctx = {
				font: "",
				measureText: () => {
					const families = ctx.font.replace(/^\d+px\s*/, "").split(",").map((f) => f.trim().replace(/^'|'$/g, ""));
					const hit = families.find((f) => installed.includes(f) || f in widths);
					return { width: hit && hit in widths ? widths[hit] : 999 };
				},
			};
			vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
				tag === "canvas" ? { getContext: () => ctx } : realCreateElement.call(document, tag)) as never);
		}

		stubCanvas([]);
		renderFontSection("Nope Mono");
		expect(screen.getByText("settings.terminalFontMissing")).toBeTruthy();

		stubCanvas(["Menlo"]);
		renderFontSection("Menlo");
		// Still exactly the one from the first render — the second one stays quiet.
		expect(screen.queryAllByText("settings.terminalFontMissing")).toHaveLength(1);
	});

	it("the size slider writes through to the preference", () => {
		renderFontSection();
		const slider = screen.getByLabelText("settings.terminalFontSize") as HTMLInputElement;
		expect(slider.value).toBe(String(DEFAULT_TERMINAL_FONT_SIZE));

		fireEvent.change(slider, { target: { value: "22" } });

		expect(getTerminalFontSize()).toBe(22);
	});

	it("both resets are dead while the settings are already at their defaults", () => {
		renderFontSection();
		const resets = screen.getAllByText("settings.zoomReset") as HTMLButtonElement[];
		// Font family, font size, scroll speed — scroll speed is at its default too.
		for (const reset of resets) expect(reset.hasAttribute("disabled")).toBe(true);
	});
});
