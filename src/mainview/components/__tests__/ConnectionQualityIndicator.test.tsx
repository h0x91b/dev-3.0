import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ConnectionQualityIndicator from "../ConnectionQualityIndicator";
import { CONNECTION_QUALITY_EVENT } from "../../connection-quality";
import type { QualityStats } from "../../../shared/connection-quality";
import { I18nProvider } from "../../i18n";

vi.mock("../../connection-quality", async () => {
	const actual = await vi.importActual<typeof import("../../connection-quality")>("../../connection-quality");
	return {
		...actual,
		startConnectionQualitySampling: vi.fn(() => null),
		getConnectionQuality: vi.fn(() => ({
			count: 0,
			lost: 0,
			p50: 0,
			p95: 0,
			jitter: 0,
			serverP50: null,
			networkP50: null,
			verdict: "good" as const,
			recent: [],
		})),
	};
});

function stats(over: Partial<QualityStats> = {}): QualityStats {
	return {
		count: 12,
		lost: 0,
		p50: 42,
		p95: 61,
		jitter: 6,
		serverP50: 2,
		networkP50: 40,
		verdict: "good",
		recent: [40, 44, 42, 41, 43],
		...over,
	};
}

function mount(variant: "bar" | "menu" = "bar") {
	return render(
		<I18nProvider>
			<ConnectionQualityIndicator variant={variant} />
		</I18nProvider>,
	);
}

function publish(next: QualityStats) {
	window.dispatchEvent(new CustomEvent(CONNECTION_QUALITY_EVENT, { detail: next }));
}

describe("ConnectionQualityIndicator", () => {
	beforeEach(() => {
		// The renderer test setup reports browser-remote by default, which is the
		// only mode this widget exists in.
		delete (window as any).__electrobunWebviewId;
	});

	it("renders nothing before the first sample answers", () => {
		mount();
		expect(screen.queryByTestId("connection-quality-indicator")).toBeNull();
	});

	it("keeps the header clear while the link behaves", async () => {
		mount();
		publish(stats());
		await waitFor(() => expect(screen.queryByTestId("connection-quality-indicator")).toBeNull());
	});

	// The window that matters most: the socket is open, every ping missed its
	// deadline, so there is no median at all. Hiding here would take the readout
	// away on the worst link there is.
	it("shows a dash rather than vanishing when nothing answers", async () => {
		mount();
		publish(stats({ count: 0, lost: 5, p50: 0, jitter: 0, serverP50: null, networkP50: null, verdict: "bad", recent: [] }));
		const pill = await screen.findByTestId("connection-quality-indicator");
		expect(pill).toHaveTextContent("—");
		expect(pill).not.toHaveTextContent("0 ms");
		expect(pill.className).toContain("text-danger");
		expect(pill.getAttribute("aria-label")).toBe("No request is coming back — open the breakdown");
	});

	it("keeps quiet while nothing has been attempted yet", async () => {
		mount();
		publish(stats({ count: 0, lost: 0, p50: 0, verdict: "good", recent: [] }));
		await waitFor(() => expect(screen.queryByTestId("connection-quality-indicator")).toBeNull());
	});

	it("says nothing answered instead of printing zeros in the breakdown", async () => {
		const user = userEvent.setup();
		mount();
		publish(stats({ count: 0, lost: 5, p50: 0, jitter: 0, serverP50: null, networkP50: null, verdict: "bad", recent: [] }));
		await user.hover(await screen.findByTestId("connection-quality-indicator"));
		const pop = await screen.findByTestId("connection-quality-popover");
		expect(pop).toHaveTextContent("every request timed out");
		expect(pop).not.toHaveTextContent("Typical round trip");
		expect(pop).toHaveTextContent("0 (5 lost)");
	});

	it("climbs into the header the moment the link stops being fine", async () => {
		mount();
		publish(stats({ verdict: "degraded", p50: 220 }));
		expect(await screen.findByTestId("connection-quality-indicator")).toHaveTextContent("220 ms");
	});

	it("shows the median in the overflow menu even on a quiet link", async () => {
		mount("menu");
		publish(stats());
		const row = await screen.findByTestId("connection-quality-indicator");
		expect(row).toHaveTextContent("42 ms");
		expect(row).toHaveTextContent("Connection");
		expect(row.getAttribute("role")).toBe("menuitem");
	});

	it("stays neutral on a quiet link — green means Completed in this app", async () => {
		mount("menu");
		publish(stats());
		const row = await screen.findByTestId("connection-quality-indicator");
		expect(row.innerHTML).toContain("text-fg-3");
		expect(row.innerHTML).not.toContain("success");
	});

	it("warns on a degraded link and escalates to danger on a bad one", async () => {
		mount();
		publish(stats({ verdict: "degraded", p50: 220 }));
		await waitFor(() =>
			expect(screen.getByTestId("connection-quality-indicator").className).toContain("text-warning"),
		);
		publish(stats({ verdict: "bad", p50: 900 }));
		await waitFor(() =>
			expect(screen.getByTestId("connection-quality-indicator").className).toContain("text-danger"),
		);
	});

	it("opens the breakdown on hover and shows the us-versus-network split", async () => {
		const user = userEvent.setup();
		mount();
		publish(stats({ verdict: "degraded", p50: 220 }));
		await user.hover(await screen.findByTestId("connection-quality-indicator"));
		const pop = await screen.findByTestId("connection-quality-popover");
		expect(pop).toHaveTextContent("Spent on this computer");
		expect(pop).toHaveTextContent("2 ms");
		expect(pop).toHaveTextContent("Spent on the network");
		expect(pop).toHaveTextContent("40 ms");
	});

	it("omits the split rather than inventing it when no server span arrived", async () => {
		const user = userEvent.setup();
		mount();
		publish(stats({ verdict: "degraded", p50: 220, serverP50: null, networkP50: null }));
		await user.hover(await screen.findByTestId("connection-quality-indicator"));
		const pop = await screen.findByTestId("connection-quality-popover");
		expect(pop).not.toHaveTextContent("Spent on the network");
	});

	it("reports lost samples instead of hiding them behind the median", async () => {
		const user = userEvent.setup();
		mount();
		publish(stats({ count: 8, lost: 4, verdict: "bad" }));
		await user.hover(await screen.findByTestId("connection-quality-indicator"));
		expect(await screen.findByTestId("connection-quality-popover")).toHaveTextContent("8 (4 lost)");
	});

	it("masks the address it shows, which names the tunnel", async () => {
		const user = userEvent.setup();
		mount();
		publish(stats({ verdict: "bad", p50: 900 }));
		await user.hover(await screen.findByTestId("connection-quality-indicator"));
		const pop = await screen.findByTestId("connection-quality-popover");
		expect(pop.querySelector(".streamer-private")).not.toBeNull();
	});

	it("opens the same breakdown from the menu row, after a hover dwell", async () => {
		const user = userEvent.setup();
		mount("menu");
		publish(stats());
		await user.hover(await screen.findByTestId("connection-quality-indicator"));
		const pop = await screen.findByTestId("connection-quality-popover");
		expect(pop).toHaveTextContent("Spent on the network");
		// Portaled out of the kebab, so the menu must be told to stay open.
		expect(pop.getAttribute("data-header-flyout")).toBe("true");
	});
});
