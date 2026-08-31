import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RemoteAccessDialog from "../RemoteAccessDialog";

/**
 * The modal's content grows with tunnel state, access code and exposed ports.
 * Before the height cap it ran off both edges of a 720px-tall window: the
 * heading was clipped at the top and the action row at the bottom, with
 * nothing scrollable. These assertions guard that shape.
 */
describe("RemoteAccessDialog", () => {
	function renderDialog() {
		return render(
			<RemoteAccessDialog
				titleId="t"
				onClose={vi.fn()}
				header={<h2 id="t">Remote access</h2>}
				footer={<button type="button">Close</button>}
			>
				<p>body content</p>
			</RemoteAccessDialog>,
		);
	}

	it("caps the dialog against the viewport and stacks header/body/footer", () => {
		renderDialog();
		const dialog = screen.getByTestId("remote-access-dialog");
		expect(dialog.className).toContain("max-h-full");
		expect(dialog.className).toContain("flex-col");
		// The backdrop keeps the dialog off the window edges on short/narrow screens.
		expect(dialog.parentElement?.className).toContain("p-4");
	});

	it("scrolls the body instead of growing the dialog", () => {
		renderDialog();
		const body = screen.getByTestId("remote-access-dialog-body");
		expect(body.className).toContain("overflow-y-auto");
		// Without min-h-0 a flex child refuses to shrink and the cap does nothing.
		expect(body.className).toContain("min-h-0");
	});

	it("keeps the heading and the action row outside the scroll area", () => {
		renderDialog();
		const body = screen.getByTestId("remote-access-dialog-body");
		expect(body).not.toContainElement(screen.getByRole("heading", { name: "Remote access" }));
		expect(body).not.toContainElement(screen.getByRole("button", { name: "Close" }));
		expect(body).toContainElement(screen.getByText("body content"));
	});

	it("fits a narrow phone viewport", () => {
		renderDialog();
		const dialog = screen.getByTestId("remote-access-dialog");
		// w-full + max-w, never a fixed w-[28rem] that overflows a 390px screen.
		expect(dialog.className).toContain("w-full");
		expect(dialog.className).toContain("max-w-[28rem]");
		expect(dialog.className).not.toMatch(/(^|\s)w-\[28rem\]/);
	});
});
