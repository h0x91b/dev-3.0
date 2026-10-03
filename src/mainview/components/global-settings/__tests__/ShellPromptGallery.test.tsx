import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellPromptPreview } from "../../../../shared/types";
import { SHELL_PROMPT_STYLES } from "../../../../shared/shell-prompt-styles";
import type { TFunction } from "../../../i18n";
import ShellPromptGallery, { clearShellPromptPreviewCache } from "../ShellPromptGallery";

vi.mock("../../../rpc", () => ({
	api: { request: { previewShellPrompt: vi.fn() } },
}));

import { api } from "../../../rpc";

const t = Object.assign((key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key), {
	plural: (key: string, count: number) => `${key}|${count}`,
}) as unknown as TFunction;

const preview = vi.mocked(api.request.previewShellPrompt);
const RED_ARROW = "\u001b[31m❯\u001b[39m";

function Harness({ shell = "zsh", onSaveCustom = vi.fn() }: { shell?: string; onSaveCustom?: (s: string) => void }) {
	const [value, setValue] = useState<string | undefined>(undefined);
	const [custom, setCustom] = useState<string | undefined>(undefined);
	return (
		<ShellPromptGallery
			t={t}
			value={value}
			custom={custom}
			shell={shell}
			onSelect={setValue}
			onSaveCustom={(source) => {
				setCustom(source);
				setValue("custom");
				onSaveCustom(source);
			}}
		/>
	);
}

beforeEach(() => {
	clearShellPromptPreviewCache();
	preview.mockReset();
	preview.mockImplementation(async ({ source }): Promise<ShellPromptPreview> =>
		source.includes("broken")
			? { ok: false, reason: "invalid", error: "unmatched '" }
			: { ok: true, afterSlowCommand: [`ok ${source.length}`], afterFailedCommand: [RED_ARROW] },
	);
});

describe("ShellPromptGallery", () => {
	it("offers every built-in style plus custom and own, with the default selected", async () => {
		render(<Harness />);
		const radios = screen.getAllByRole("radio");
		expect(radios).toHaveLength(SHELL_PROMPT_STYLES.length + 2);
		expect(screen.getByRole("radio", { name: /^dev3/ })).toHaveAttribute("aria-checked", "true");
		// The selected style shows its source so it can be copied.
		expect(screen.getByText(SHELL_PROMPT_STYLES[0].source)).toBeInTheDocument();
		await waitFor(() => expect(preview).toHaveBeenCalledTimes(SHELL_PROMPT_STYLES.length));
	});

	it("renders ANSI colours from the preview instead of printing escape codes", async () => {
		render(<Harness />);
		const arrow = await screen.findByText("❯");
		expect(arrow).toHaveStyle({ color: "#f7768e" });
		expect(document.body.textContent).not.toContain("\u001b[");
	});

	it("draws reverse video with the terminal background as the text colour", async () => {
		preview.mockImplementation(async (): Promise<ShellPromptPreview> => ({
			ok: true,
			afterSlowCommand: ["\u001b[35;7m #42 \u001b[27m"],
			afterFailedCommand: [""],
		}));
		render(<Harness />);
		const badge = (await screen.findAllByText("#42", { exact: false }))[0];
		expect(badge).toHaveStyle({ color: "#1a1b26", background: "#bb9af7" });
	});

	it("draws solid powerline separators as shapes, so they match the segment height", async () => {
		preview.mockImplementation(async (): Promise<ShellPromptPreview> => ({
			ok: true,
			afterSlowCommand: ["\u001b[35;7m #42 \u001b[34;45m\ue0bc\u001b[49m\u001b[34m app\ue0bc"],
			afterFailedCommand: [""],
		}));
		const { container } = render(<Harness />);
		await screen.findAllByText("#42", { exact: false });
		expect(container.querySelectorAll("[data-powerline-shape]").length).toBeGreaterThanOrEqual(2);
		expect(container.textContent).not.toContain("\ue0bc");
	});

	it("copies a style into the custom editor and applies it only after zsh accepts it", async () => {
		const onSaveCustom = vi.fn();
		render(<Harness onSaveCustom={onSaveCustom} />);
		await userEvent.click(screen.getByRole("radio", { name: /^Minimal/ }));
		await userEvent.click(screen.getByRole("button", { name: "settings.shellPromptCustomize" }));

		const editor = screen.getByRole("textbox", { name: "settings.shellPromptCustom" });
		expect(editor).toHaveValue(SHELL_PROMPT_STYLES.find((s) => s.id === "minimal")!.source);

		await userEvent.clear(editor);
		await userEvent.type(editor, "PROMPT=broken");
		await userEvent.click(screen.getByRole("button", { name: "settings.shellPromptApply" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("unmatched '");
		expect(onSaveCustom).not.toHaveBeenCalled();

		await userEvent.clear(editor);
		await userEvent.type(editor, "PROMPT=fine");
		await userEvent.click(screen.getByRole("button", { name: "settings.shellPromptApply" }));
		await waitFor(() => expect(onSaveCustom).toHaveBeenCalledWith("PROMPT=fine"));
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("warns that styles are zsh-only when the terminals run another shell", () => {
		render(<Harness shell="bash" />);
		expect(screen.getByText(/settings\.shellPromptNotZsh/)).toHaveTextContent('"shell":"bash"');
	});

	it("says nothing about the shell when it is zsh", () => {
		render(<Harness />);
		expect(screen.queryByText(/settings\.shellPromptNotZsh/)).toBeNull();
	});
});
