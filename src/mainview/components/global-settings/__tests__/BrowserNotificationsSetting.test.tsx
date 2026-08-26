import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, type TFunction } from "../../../i18n";
import BrowserNotificationsSetting from "../BrowserNotificationsSetting";

const push = vi.hoisted(() => ({
	isSubscribed: vi.fn(),
	subscribeToPush: vi.fn(),
	unsubscribeFromPush: vi.fn(),
}));

vi.mock("../../../rpc", () => ({ isElectrobun: false }));
vi.mock("../../../utils/webNotification", () => ({
	browserNotificationsEnabled: () => true,
	setBrowserNotificationsEnabled: vi.fn(),
	webNotificationsSupported: () => true,
}));
vi.mock("../../../utils/webPush", () => ({
	isSubscribed: push.isSubscribed,
	pushReadiness: () => ({ ready: true }),
	subscribeToPush: push.subscribeToPush,
	unsubscribeFromPush: push.unsubscribeFromPush,
}));

const t = ((key: string) => key) as unknown as TFunction;

function renderSetting() {
	return render(
		<I18nProvider>
			<BrowserNotificationsSetting t={t} />
		</I18nProvider>,
	);
}

beforeEach(() => {
	push.isSubscribed.mockReset();
	push.subscribeToPush.mockReset();
	push.unsubscribeFromPush.mockReset();
	Object.defineProperty(globalThis, "Notification", {
		configurable: true,
		value: { permission: "granted", requestPermission: vi.fn() },
	});
});

describe("BrowserNotificationsSetting", () => {
	it("does not show a false push state while subscription lookup is pending", async () => {
		let resolveSubscription!: (subscribed: boolean) => void;
		push.isSubscribed.mockReturnValue(
			new Promise<boolean>((resolve) => {
				resolveSubscription = resolve;
			}),
		);
		renderSetting();

		expect(screen.getByText("settings.pushChecking")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "settings.pushEnable" })).not.toBeInTheDocument();

		await act(async () => resolveSubscription(false));
		expect(await screen.findByRole("button", { name: "settings.pushEnable" })).toBeInTheDocument();
	});

	it("shows a safe localized failure and keeps the prior subscription state", async () => {
		push.isSubscribed.mockResolvedValue(false);
		push.subscribeToPush.mockRejectedValue(new Error("private endpoint details"));
		renderSetting();

		const button = await screen.findByRole("button", { name: "settings.pushEnable" });
		await userEvent.click(button);

		expect(await screen.findByRole("alert")).toHaveTextContent("settings.pushError");
		expect(screen.queryByText(/private endpoint details/)).not.toBeInTheDocument();
		expect(button).toHaveTextContent("settings.pushEnable");
	});

	it("uses the shared secondary-button radius and press feedback", async () => {
		push.isSubscribed.mockResolvedValue(false);
		renderSetting();

		const button = await screen.findByRole("button", { name: "settings.pushEnable" });
		expect(button.className).toContain("rounded-lg");
		expect(button.className).toContain("motion-safe:active:scale-[0.96]");
	});
});
