import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SecretRequestModal from "../SecretRequestModal";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import type { SecretRequest } from "../../../shared/secret-request";

vi.mock("../../rpc", () => ({ api: { request: { respondToSecretRequest: vi.fn() } } }));
const request: SecretRequest = { requestId: "r", projectId: "p", taskId: "t", taskTitle: "Upload", env: "TOKEN", command: ["node", "upload.mjs", "a b"], cwd: "/worktree", expiresAt: Date.now() + 60_000, runStartedAt: null };
const respond = vi.mocked(api.request.respondToSecretRequest);
beforeEach(() => { respond.mockReset().mockResolvedValue(true); });
afterEach(cleanup);
const mount = () => render(<I18nProvider><SecretRequestModal request={request} onDone={() => {}} /></I18nProvider>);

describe("secret dialog", () => {
	it("shows exact command and a masked input excluded from automatic capture", () => {
		mount();
		expect(screen.getByText(JSON.stringify(request.command, null, 2), { normalizer: (text) => text })).toBeInTheDocument();
		const input = screen.getByLabelText("Secret for TOKEN");
		expect(input).toHaveAttribute("type", "password");
		expect(input).toHaveAttribute("autocomplete", "off");
		expect(input).toHaveAttribute("data-ph-mask");
		expect(screen.getByRole("dialog")).toHaveClass("ph-no-capture");
		expect(screen.getByRole("button", { name: "Decline" })).toHaveFocus();
	});
	it("submits once and clears the field before the RPC completes", async () => {
		let submitted: unknown;
		respond.mockImplementation((params) => { submitted = { ...params }; return new Promise(() => {}); });
		mount();
		const user = userEvent.setup();
		const input = screen.getByLabelText("Secret for TOKEN");
		await user.click(input);
		await user.type(input, "test-private-value");
		await user.click(screen.getByRole("button", { name: "Use secret and run" }));
		expect(input).toHaveValue("");
		expect(submitted).toEqual({ requestId: "r", secret: "test-private-value" });
		expect(respond).toHaveBeenCalledTimes(1);
	});
	it("declines without sending the value", async () => {
		mount();
		const user = userEvent.setup();
		const input = screen.getByLabelText("Secret for TOKEN");
		await user.click(input);
		await user.type(input, "test-value");
		await user.click(screen.getByRole("button", { name: "Decline" }));
		expect(respond).toHaveBeenCalledWith({ requestId: "r" });
		expect(input).toHaveValue("");
	});
	it("clears the value when another client resolves or the dialog unmounts", async () => {
		const { unmount } = mount();
		const user = userEvent.setup();
		const input = screen.getByLabelText("Secret for TOKEN");
		await user.click(input);
		await user.type(input, "test-value");
		unmount();
		expect(input).toHaveValue("");
	});
	it("displays only a generic error if the RPC fails", async () => {
		respond.mockRejectedValue(new Error("test-private-value"));
		mount();
		const user = userEvent.setup();
		const input = screen.getByLabelText("Secret for TOKEN");
		await user.click(input);
		await user.type(input, "test-private-value");
		await user.click(screen.getByRole("button", { name: "Use secret and run" }));
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not submit"));
		expect(document.body.textContent).not.toContain("test-private-value");
		expect(input).toHaveValue("");
	});
});
