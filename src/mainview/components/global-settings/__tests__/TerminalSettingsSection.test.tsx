import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellAvailability } from "../../../../shared/types";
import { I18nProvider, useT, type TFunction } from "../../../i18n";
import TerminalSettingsSection from "../TerminalSettingsSection";
import {
	bootstrapTerminalFont,
	BUNDLED_TERMINAL_FONTS,
	DEFAULT_TERMINAL_FONT_SIZE,
	getTerminalFontFamily,
	getTerminalFontSize,
	REFERENCE_TERMINAL_FONT,
	terminalFontStack,
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
			dimInactivePanes={undefined}
			onNewTaskTerminalBackendChange={vi.fn()}
			onTerminalPathOpenModeChange={vi.fn()}
			onTerminalShellChange={props.onTerminalShellChange}
			onDimInactivePanesToggle={vi.fn()}
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

describe("TerminalSettingsSection — pane dimming", () => {
	function renderDimming(dimInactivePanes: boolean | undefined) {
		const onDimInactivePanesToggle = vi.fn();
		render(
			<I18nProvider>
				<DimHarness value={dimInactivePanes} onToggle={onDimInactivePanesToggle} />
			</I18nProvider>,
		);
		return { onDimInactivePanesToggle };
	}

	it("reads as on for an install that never touched the setting", () => {
		renderDimming(undefined);
		expect(screen.getByRole("switch", { name: "Dim inactive panes" })).toHaveAttribute("aria-checked", "true");
	});

	it("switches dimming off", async () => {
		const { onDimInactivePanesToggle } = renderDimming(undefined);
		await userEvent.click(screen.getByRole("switch", { name: "Dim inactive panes" }));
		expect(onDimInactivePanesToggle).toHaveBeenCalledWith(false);
	});

	it("switches dimming back on", async () => {
		const { onDimInactivePanesToggle } = renderDimming(false);
		const toggle = screen.getByRole("switch", { name: "Dim inactive panes" });
		expect(toggle).toHaveAttribute("aria-checked", "false");
		await userEvent.click(toggle);
		expect(onDimInactivePanesToggle).toHaveBeenCalledWith(true);
	});
});

function DimHarness({ value, onToggle }: { value: boolean | undefined; onToggle: (enabled: boolean) => void }) {
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
			terminalShell={undefined}
			shellAvailability={MAC}
			dimInactivePanes={value}
			onNewTaskTerminalBackendChange={vi.fn()}
			onTerminalPathOpenModeChange={vi.fn()}
			onTerminalShellChange={vi.fn()}
			onDimInactivePanesToggle={onToggle}
		/>
	);
}

// The font tests read raw keys instead of English, so a copy change cannot turn a
// passing assertion red — they are about the control's behaviour, not its wording.
/** The gallery has its own radiogroup; the backend picker on the same page has another. */
const GALLERY = "settings.terminalFontGallery";
/** The count is plural, so the fake `t` renders `<key>|<count>` — see below. */
const COMPARE = `settings.terminalFontCompare|${BUNDLED_TERMINAL_FONTS.length}`;

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
				dimInactivePanes={undefined}
				onNewTaskTerminalBackendChange={vi.fn()}
				onTerminalPathOpenModeChange={vi.fn()}
				onTerminalShellChange={vi.fn()}
				onDimInactivePanesToggle={vi.fn()}
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

	it("the comparison gallery is closed until asked for, then offers every bundled font", async () => {
		// It is fifteen tall preview rows: opening it by default would bury the four
		// unrelated terminal settings underneath them.
		renderFontSection();
		const user = userEvent.setup();
		expect(screen.queryByRole("radiogroup", { name: GALLERY })).toBeNull();

		await user.click(screen.getByText(COMPARE));

		const rows = within(screen.getByRole("radiogroup", { name: GALLERY })).getAllByRole("radio");
		expect(rows).toHaveLength(BUNDLED_TERMINAL_FONTS.length);
	});

	it("picking a font in the gallery commits it", async () => {
		renderFontSection();
		const user = userEvent.setup();
		await user.click(screen.getByText(COMPARE));

		// Read the label out of the registry rather than spelling it: the labels are
		// wording, and this test is about the row committing its family.
		const target = BUNDLED_TERMINAL_FONTS.find((f) => f.family === "IosevkaTerm Nerd Font Mono")!;
		await user.click(screen.getByText(target.label));

		expect(getTerminalFontFamily()).toBe("IosevkaTerm Nerd Font Mono");
	});

	it("offers unpatched JetBrains Mono as its own row, not only the Nerd Font one", async () => {
		// The #1625 complaint: the picker labelled the patched face "JetBrains Mono", so
		// asking for the upstream typeface silently handed over the Nerd Font instead.
		renderFontSection();
		const user = userEvent.setup();
		await user.click(screen.getByText(COMPARE));

		await user.click(screen.getByText("JetBrains Mono"));

		expect(getTerminalFontFamily()).toBe("JetBrains Mono");
		// The Nerd Font stays in the tail, so an icon glyph the plain face lacks still resolves.
		expect(terminalFontStack()).toContain(REFERENCE_TERMINAL_FONT);
	});

	it("marks the current font as chosen rather than leaving the group unset", async () => {
		// An empty stored family means "never chose one", which renders as the
		// reference font — so the reference row is the one that must read as checked.
		renderFontSection();
		const user = userEvent.setup();
		await user.click(screen.getByText(COMPARE));

		const checked = within(screen.getByRole("radiogroup", { name: GALLERY }))
			.getAllByRole("radio")
			.filter((r) => r.getAttribute("aria-checked") === "true");
		expect(checked).toHaveLength(1);
		expect(checked[0].textContent).toContain("JetBrains Mono");
	});

	it("never prints a 0% trim — a rounded-away difference is noise, not information", async () => {
		// Go Mono is 0.02% wider than the reference. True, and useless to say.
		renderFontSection();
		const user = userEvent.setup();
		await user.click(screen.getByText(COMPARE));

		const shown = screen.queryAllByText("settings.terminalFontNarrowed").length;
		const rounded = BUNDLED_TERMINAL_FONTS.filter((f) => Math.round((1 - f.scale) * 1000) / 10 > 0);
		const anyTrim = BUNDLED_TERMINAL_FONTS.filter((f) => f.scale < 1);
		expect(shown).toBe(rounded.length);
		// The guard has to actually bite: some fonts are trimmed by less than 0.05%.
		expect(rounded.length).toBeLessThan(anyTrim.length);
	});

	it("says so when the chosen font had to be narrowed to fit the reference cell", () => {
		renderFontSection("0xProto Nerd Font Mono");
		expect(screen.getByText("settings.terminalFontNarrowedNote")).toBeTruthy();
	});

	it("stays quiet for a font that already fits", () => {
		renderFontSection("Iosevka Nerd Font Mono");
		expect(screen.queryByText("settings.terminalFontNarrowedNote")).toBeNull();
	});

	it("both resets are dead while the settings are already at their defaults", () => {
		renderFontSection();
		const resets = screen.getAllByText("settings.zoomReset") as HTMLButtonElement[];
		// Font family, font size, scroll speed — scroll speed is at its default too.
		for (const reset of resets) expect(reset.hasAttribute("disabled")).toBe(true);
	});
});
