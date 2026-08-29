/**
 * The app now survives a remote-access port it cannot bind, which means the only
 * thing standing between the user and a silent failure is this notice. It has to
 * name the port, offer the way out, and disappear the moment remote access works.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RemoteAccessStatus } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import RemoteAccessDownNotice from "../RemoteAccessDownNotice";

const down: RemoteAccessStatus = {
	running: false,
	port: 0,
	failure: { port: 45999, reason: "port-in-use", message: "Failed to start server. Is port 45999 in use?" },
};

function renderNotice(status: RemoteAccessStatus | null, props: Partial<Parameters<typeof RemoteAccessDownNotice>[0]> = {}) {
	return render(
		<I18nProvider>
			<RemoteAccessDownNotice status={status} {...props} />
		</I18nProvider>,
	);
}

describe("RemoteAccessDownNotice", () => {
	it("names the port that is taken, so a broken pin is not guesswork", () => {
		renderNotice(down);
		expect(screen.getByTestId("remote-access-down")).toHaveTextContent("45999");
	});

	it("stays quiet while remote access is serving", () => {
		renderNotice({ running: true, port: 51473, failure: null });
		expect(screen.queryByTestId("remote-access-down")).not.toBeInTheDocument();
	});

	it("renders nothing before the status has arrived", () => {
		renderNotice(null);
		expect(screen.queryByTestId("remote-access-down")).not.toBeInTheDocument();
	});

	it("drops the port from the copy when the failure was not about a port", () => {
		renderNotice({ running: false, port: 0, failure: { port: 0, reason: "other", message: "boom" } });
		expect(screen.getByTestId("remote-access-down")).not.toHaveTextContent("45999");
	});

	it("retries on demand and re-enables itself afterwards", async () => {
		const onRetry = vi.fn().mockResolvedValue(down);
		renderNotice(down, { onRetry });

		await userEvent.click(screen.getByTestId("remote-access-retry"));

		expect(onRetry).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(screen.getByTestId("remote-access-retry")).not.toBeDisabled());
	});

	it("offers a settings link only where one was wired", () => {
		const onOpenSettings = vi.fn();
		const { unmount } = renderNotice(down, { onOpenSettings });
		expect(screen.getByTestId("remote-access-down-settings-link")).toBeInTheDocument();
		unmount();

		renderNotice(down);
		expect(screen.queryByTestId("remote-access-down-settings-link")).not.toBeInTheDocument();
	});

	it("announces itself to a screen reader when it appears", () => {
		renderNotice(down);
		const notice = screen.getByTestId("remote-access-down");
		expect(notice).toHaveAttribute("role", "status");
		expect(notice).toHaveAttribute("aria-live", "polite");
	});
});
