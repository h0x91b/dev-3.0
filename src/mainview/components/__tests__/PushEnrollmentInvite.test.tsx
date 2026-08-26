import { render } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "../../i18n";
import PushEnrollmentInvite from "../PushEnrollmentInvite";

const { maybeInvitePushEnrollment } = vi.hoisted(() => ({
	maybeInvitePushEnrollment: vi.fn(),
}));
vi.mock("../../utils/pushInvite", () => ({ maybeInvitePushEnrollment }));

const t = ((key: string) => key) as unknown as TFunction;

afterEach(() => {
	vi.useRealTimers();
	maybeInvitePushEnrollment.mockReset();
});

describe("PushEnrollmentInvite", () => {
	it("waits until the main application shell has settled", () => {
		vi.useFakeTimers();
		render(<PushEnrollmentInvite t={t} />);

		act(() => vi.advanceTimersByTime(3_999));
		expect(maybeInvitePushEnrollment).not.toHaveBeenCalled();

		act(() => vi.advanceTimersByTime(1));
		expect(maybeInvitePushEnrollment).toHaveBeenCalledOnce();
	});

	it("cancels the offer when the application shell unmounts", () => {
		vi.useFakeTimers();
		const { unmount } = render(<PushEnrollmentInvite t={t} />);
		unmount();

		act(() => vi.advanceTimersByTime(4_000));
		expect(maybeInvitePushEnrollment).not.toHaveBeenCalled();
	});
});
