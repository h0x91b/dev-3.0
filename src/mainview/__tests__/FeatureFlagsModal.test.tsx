/**
 * Debug → Feature Flags. What must hold: the values shown are the ones bun gates
 * code on (re-read while the window is open), the id shown is the one PostHog
 * evaluates this renderer as (copyable, masked in streamer mode), a disagreement
 * with the host's stored id is surfaced rather than hidden, and Refresh reports
 * whether an answer actually arrived.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { I18nProvider } from "../i18n";

const { state } = vi.hoisted(() => ({
	state: {
		flags: { "remote-terminal-latency": false } as Record<string, boolean>,
		storedId: "01234567-89ab-cdef",
		evaluatingId: "01234567-89ab-cdef",
		answered: true,
	},
}));

vi.mock("../rpc", () => ({
	api: {
		request: {
			getFeatureFlags: vi.fn(() => Promise.resolve(state.flags)),
			// The host's own copy of the id — normally identical to the evaluating one.
			resolveAnalyticsDistinctId: vi.fn(() => Promise.resolve({ distinctId: state.storedId })),
		},
	},
	isElectrobun: true,
}));

const { reload } = vi.hoisted(() => ({ reload: vi.fn(() => Promise.resolve(state.answered)) }));

vi.mock("../feature-flags", () => ({
	refreshFeatureFlagsNow: reload,
	evaluatingDistinctId: () => state.evaluatingId,
}));

import FeatureFlagsModal from "../components/FeatureFlagsModal";

function renderModal(onClose = vi.fn()) {
	return render(
		<I18nProvider>
			<FeatureFlagsModal onClose={onClose} />
		</I18nProvider>,
	);
}

beforeEach(() => {
	state.flags = { "remote-terminal-latency": false };
	state.storedId = "01234567-89ab-cdef";
	state.evaluatingId = "01234567-89ab-cdef";
	state.answered = true;
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("FeatureFlagsModal", () => {
	it("shows every declared flag with the value bun reports", async () => {
		state.flags = { "remote-terminal-latency": true, "some-other-flag": false };
		renderModal();

		await screen.findByText("remote-terminal-latency");
		expect(screen.getByText("some-other-flag")).toBeInTheDocument();
		expect(screen.getByText("On")).toBeInTheDocument();
		expect(screen.getByText("Off")).toBeInTheDocument();
	});

	it("picks up a flag that flips while the window stays open", async () => {
		renderModal();
		await screen.findByText("Off");

		state.flags = { "remote-terminal-latency": true };
		await waitFor(() => expect(screen.getByText("On")).toBeInTheDocument(), { timeout: 3000 });
	});

	it("copies the distinct id and confirms it", async () => {
		// setup() installs its own navigator.clipboard stub, so override it after.
		const user = userEvent.setup();
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		renderModal();

		await user.click(await screen.findByRole("button", { name: "Copy" }));

		expect(writeText).toHaveBeenCalledWith("01234567-89ab-cdef");
		await screen.findByText("Copied");
	});

	it("shows the id PostHog evaluates this renderer as, because that is what a rollout targets", async () => {
		state.evaluatingId = "evaluating-id";
		state.storedId = "evaluating-id";
		renderModal();
		await screen.findByText("evaluating-id");
	});

	// The bug this window exists to catch: the host handing over its id can fail,
	// and then targeting the displayed id silently matches nobody.
	it("surfaces a disagreement between the evaluating id and the host's stored one", async () => {
		state.evaluatingId = "renderer-minted-id";
		state.storedId = "host-stored-id";
		renderModal();

		await screen.findByText("renderer-minted-id");
		await waitFor(() => expect(screen.getByText(/host-stored-id/)).toBeInTheDocument());
	});

	// A worktree build has no PostHog key, so the client is a no-op: nothing ever
	// evaluates and every value shown is a shipped default. Saying so beats an
	// empty id row that reads like a bug in the window.
	it("says the build has no PostHog key and falls back to the host's id", async () => {
		state.evaluatingId = "";
		renderModal();

		await screen.findByText(/no PostHog key/);
		await screen.findByText("01234567-89ab-cdef");
	});

	it("stays quiet when both ids agree", async () => {
		renderModal();
		await screen.findByText("01234567-89ab-cdef");
		expect(screen.queryByText(/different id/)).not.toBeInTheDocument();
	});

	it("masks the distinct id in streamer mode", async () => {
		renderModal();
		const id = await screen.findByText("01234567-89ab-cdef");
		expect(id).toHaveClass("streamer-private");
	});

	it("asks PostHog for fresh values instead of waiting out the timer", async () => {
		const user = userEvent.setup();
		renderModal();

		await user.click(await screen.findByRole("button", { name: "Refresh now" }));
		expect(reload).toHaveBeenCalled();
	});

	it("confirms a refresh that got an answer", async () => {
		const user = userEvent.setup();
		renderModal();

		await user.click(await screen.findByRole("button", { name: "Refresh now" }));
		await screen.findByText("Values updated");
	});

	// Silence used to be indistinguishable from success, which is how a dead
	// refresh path survived: the button looked like it had worked.
	it("says so when PostHog never answers", async () => {
		state.answered = false;
		const user = userEvent.setup();
		renderModal();

		await user.click(await screen.findByRole("button", { name: "Refresh now" }));
		await screen.findByText("No answer from PostHog");
	});

	it("closes on the Close button", async () => {
		const onClose = vi.fn();
		const user = userEvent.setup();
		renderModal(onClose);

		await user.click(await screen.findByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalled();
	});
});
