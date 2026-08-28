/**
 * The browser sign-in screen. This is the only place the permanent access code
 * is ever entered — it deliberately never travels in a URL — so these tests pin
 * that a rejection is recoverable rather than terminal.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { I18nProvider } from "../../i18n";
import RemoteSignIn from "../RemoteSignIn";

const submitRemoteAccessCode = vi.hoisted(() => vi.fn());
vi.mock("../../rpc", () => ({ submitRemoteAccessCode }));

function renderSignIn() {
	const onSignedIn = vi.fn();
	render(
		<I18nProvider>
			<RemoteSignIn onSignedIn={onSignedIn} />
		</I18nProvider>,
	);
	return { onSignedIn };
}

const field = () => screen.getByTestId("remote-access-code") as HTMLInputElement;
const submit = () => screen.getByRole("button", { name: "Sign in" });

describe("RemoteSignIn", () => {
	beforeEach(() => {
		submitRemoteAccessCode.mockReset();
	});

	it("sends the typed code and reports success upwards", async () => {
		submitRemoteAccessCode.mockResolvedValue("ok");
		const { onSignedIn } = renderSignIn();

		await userEvent.type(field(), "correct-horse");
		await userEvent.click(submit());

		expect(submitRemoteAccessCode).toHaveBeenCalledWith("correct-horse");
		expect(onSignedIn).toHaveBeenCalledOnce();
	});

	it("masks the code — this screen gets screenshotted", () => {
		renderSignIn();
		expect(field()).toHaveAttribute("type", "password");
	});

	it("trims before sending, so a pasted code with a stray space still works", async () => {
		submitRemoteAccessCode.mockResolvedValue("ok");
		renderSignIn();

		await userEvent.type(field(), "  sesame  ");
		await userEvent.click(submit());

		expect(submitRemoteAccessCode).toHaveBeenCalledWith("sesame");
	});

	it("shows an error and stays on the form when the code is refused", async () => {
		submitRemoteAccessCode.mockResolvedValue("rejected");
		const { onSignedIn } = renderSignIn();

		await userEvent.type(field(), "wrong");
		await userEvent.click(submit());

		expect(await screen.findByTestId("remote-access-code-error")).toHaveTextContent(
			"That code was not accepted. Check it and try again.",
		);
		expect(onSignedIn).not.toHaveBeenCalled();
		// The code is multi-use and permanent: a refusal is never terminal.
		expect(field()).toBeEnabled();
		expect(field()).toHaveFocus();
	});

	it("distinguishes an unreachable host from a bad code", async () => {
		submitRemoteAccessCode.mockResolvedValue("network");
		renderSignIn();

		await userEvent.type(field(), "sesame");
		await userEvent.click(submit());

		expect(await screen.findByTestId("remote-access-code-error")).toHaveTextContent(
			"Could not reach the host. Check the connection and try again.",
		);
	});

	it("clears the error as soon as the user edits the code again", async () => {
		submitRemoteAccessCode.mockResolvedValue("rejected");
		renderSignIn();

		await userEvent.type(field(), "wrong");
		await userEvent.click(submit());
		expect(await screen.findByTestId("remote-access-code-error")).toBeInTheDocument();

		await userEvent.type(field(), "er");
		expect(screen.queryByTestId("remote-access-code-error")).not.toBeInTheDocument();
	});

	it("refuses to submit an empty code", async () => {
		renderSignIn();
		expect(submit()).toBeDisabled();
		await userEvent.click(submit());
		expect(submitRemoteAccessCode).not.toHaveBeenCalled();
	});
});
