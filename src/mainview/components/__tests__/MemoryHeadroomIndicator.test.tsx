import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import MemoryHeadroomIndicator from "../MemoryHeadroomIndicator";
import type { SystemMemorySnapshot } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: { request: { getSystemMemory: vi.fn() } },
}));

import { api } from "../../rpc";

const mockedGet = api.request.getSystemMemory as ReturnType<typeof vi.fn>;

const GIB = 1024 ** 3;

function snapshot(overrides?: Partial<SystemMemorySnapshot>): SystemMemorySnapshot {
	return {
		headroom: 12 * GIB,
		used: 52 * GIB,
		total: 64 * GIB,
		cached: 8 * GIB,
		pressure: "normal",
		pressureEstimated: false,
		swapUsed: 0,
		swapTotal: 2 * GIB,
		swapping: false,
		topConsumers: [
			{ name: "Docker", rss: 12 * GIB, processCount: 1, path: "/usr/local/bin/dockerd", cmdline: "/usr/local/bin/dockerd --host=fd://" },
			{ name: "Google Chrome", rss: 9 * GIB, processCount: 80, path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", cmdline: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
		],
		appRss: 300 * 1024 * 1024,
		activeTaskCount: 14,
		tasksRssApprox: 31 * GIB,
		topTasks: [
			{ shortId: "abc12345", taskId: "abc12345-full-id", title: "Fix the parser", projectId: "p1", rss: 4 * GIB },
			{ shortId: "def67890", taskId: null, title: "", projectId: "", rss: 3 * GIB },
		],
		medianTaskRss: 2 * GIB,
		...overrides,
	};
}

/** Stub innerWidth + matchMedia so useNarrowViewport resolves deterministically. */
function mockViewport(width: number) {
	Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
	Object.defineProperty(window, "matchMedia", {
		writable: true,
		configurable: true,
		value: vi.fn((query: string) => {
			const m = query.match(/max-width:\s*(\d+)/);
			return {
				matches: m ? width <= Number(m[1]) : false,
				media: query,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
				dispatchEvent: vi.fn(),
			};
		}),
	});
}

function renderIndicator(navigate = vi.fn()) {
	const result = render(
		<I18nProvider>
			<MemoryHeadroomIndicator navigate={navigate} />
		</I18nProvider>,
	);
	return { ...result, navigate };
}

function pill() {
	return screen.getByTestId("memory-headroom-indicator");
}

/** Deliver a push update the way rpc.ts does. */
async function pushSnapshot(next: SystemMemorySnapshot) {
	await act(async () => {
		window.dispatchEvent(new CustomEvent("rpc:systemMemoryUpdated", { detail: next }));
	});
}

beforeEach(() => {
	mockedGet.mockReset();
	mockedGet.mockResolvedValue(snapshot());
	mockViewport(1920);
});

describe("MemoryHeadroomIndicator — the pill", () => {
	it("shows how much memory is LEFT, not how much is used", async () => {
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());

		// 12 GiB free out of 64 — the used figure (52) must not be the headline.
		expect(pill()).toHaveTextContent("12G");
		expect(pill()).not.toHaveTextContent("52");
	});

	it("says 'free' in its accessible name, so the number is never ambiguous", async () => {
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		expect(pill().getAttribute("aria-label")).toMatch(/free/i);
	});

	it("renders nothing before the first snapshot arrives", async () => {
		mockedGet.mockResolvedValue(null);
		renderIndicator();
		await waitFor(() => expect(mockedGet).toHaveBeenCalled());
		expect(screen.queryByTestId("memory-headroom-indicator")).toBeNull();
	});

	it("survives a failing snapshot request without throwing", async () => {
		mockedGet.mockRejectedValue(new Error("rpc down"));
		renderIndicator();
		await waitFor(() => expect(mockedGet).toHaveBeenCalled());
		expect(screen.queryByTestId("memory-headroom-indicator")).toBeNull();
	});

	it("is neutral at normal pressure — green would read as a claim", async () => {
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		expect(pill().className).toContain("text-fg-3");
		expect(pill().className).not.toContain("text-success");
	});

	it("turns warning yellow under pressure", async () => {
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await pushSnapshot(snapshot({ pressure: "warn" }));
		expect(pill().className).toContain("text-warning");
	});

	it("turns danger red when the OS reports critical", async () => {
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await pushSnapshot(snapshot({ pressure: "critical" }));
		expect(pill().className).toContain("text-danger");
	});

	it("tracks live updates pushed from the backend", async () => {
		renderIndicator();
		await waitFor(() => expect(pill()).toHaveTextContent("12G"));
		await pushSnapshot(snapshot({ headroom: 3 * GIB }));
		expect(pill()).toHaveTextContent("3.0G");
	});

	it("stays visible on a narrow viewport with a touch-sized target", async () => {
		mockViewport(390);
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		// >= 44px: h-11 is Tailwind's 2.75rem.
		expect(pill().className).toContain("h-11");
	});
});

describe("MemoryHeadroomIndicator — the breakdown", () => {
	it("opens on hover on a pointer device", async () => {
		const user = userEvent.setup();
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());

		await user.hover(pill());
		expect(await screen.findByTestId("memory-breakdown-popover")).toBeInTheDocument();
	});

	it("opens on click, and clicking again closes it", async () => {
		const user = userEvent.setup();
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());

		await user.click(pill());
		expect(await screen.findByTestId("memory-breakdown-popover")).toBeInTheDocument();
		expect(pill().getAttribute("aria-expanded")).toBe("true");

		await user.click(pill());
		expect(screen.queryByTestId("memory-breakdown-popover")).toBeNull();
	});

	it("opens as a bottom sheet on narrow, not a floating popover", async () => {
		mockViewport(390);
		const user = userEvent.setup();
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());

		await user.click(pill());
		expect(await screen.findByTestId("memory-breakdown-sheet")).toBeInTheDocument();
		expect(screen.queryByTestId("memory-breakdown-popover")).toBeNull();
	});

	it("shows the system figures and the swap line", async () => {
		const user = userEvent.setup();
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await user.click(pill());

		const popover = await screen.findByTestId("memory-breakdown-popover");
		expect(popover).toHaveTextContent("12.0 GB");
		expect(popover).toHaveTextContent(/52\.0 GB of 64\.0 GB in use/);
		expect(popover).toHaveTextContent(/not swapping/i);
	});

	it("flags an actively swapping machine", async () => {
		const user = userEvent.setup();
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await pushSnapshot(snapshot({ swapping: true, swapUsed: 4 * GIB }));
		await user.click(pill());

		expect(await screen.findByTestId("memory-breakdown-popover")).toHaveTextContent(/swapping right now/i);
	});

	it("says when the pressure level is only estimated", async () => {
		const user = userEvent.setup();
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await pushSnapshot(snapshot({ pressureEstimated: true }));
		await user.click(pill());

		expect(await screen.findByTestId("memory-breakdown-popover")).toHaveTextContent(/estimated/i);
	});

	it("shows a grouped app's process count, so 9 GB in one row is explained", async () => {
		const user = userEvent.setup();
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await user.click(pill());

		const popover = await screen.findByTestId("memory-breakdown-popover");
		expect(popover).toHaveTextContent("Google Chrome");
		expect(popover).toHaveTextContent("(80 processes)");
	});

	it("separates the app's own share from the share its agents spend", async () => {
		const user = userEvent.setup();
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await user.click(pill());

		const popover = await screen.findByTestId("memory-breakdown-popover");
		// 300 MB for the app itself, ~31 GB across 14 tasks — the whole argument.
		expect(popover).toHaveTextContent("300 MB");
		expect(popover).toHaveTextContent("14 active tasks");
		expect(popover).toHaveTextContent("~31.0 GB");
	});

	it("marks the task subtotal as an approximation and explains why", async () => {
		const user = userEvent.setup();
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await user.click(pill());

		expect(await screen.findByTestId("memory-breakdown-popover")).toHaveTextContent(/overstates/i);
	});

	it("navigates to a heavy task and closes the popover", async () => {
		const user = userEvent.setup();
		const { navigate } = renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await user.click(pill());

		await user.click(await screen.findByRole("button", { name: /Fix the parser/ }));

		expect(navigate).toHaveBeenCalledWith({
			screen: "project",
			projectId: "p1",
			activeTaskId: "abc12345-full-id",
		});
		expect(screen.queryByTestId("memory-breakdown-popover")).toBeNull();
	});

	it("shows an unresolvable task's number but leaves the row unclickable", async () => {
		const user = userEvent.setup();
		const { navigate } = renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await user.click(pill());

		const row = await screen.findByRole("button", { name: /def67890/ });
		expect(row).toBeDisabled();
		await user.click(row);
		expect(navigate).not.toHaveBeenCalled();
	});

	it("masks process and task names for streamer mode", async () => {
		const user = userEvent.setup();
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await user.click(pill());

		const popover = await screen.findByTestId("memory-breakdown-popover");
		const masked = popover.querySelectorAll(".streamer-private");
		const maskedText = [...masked].map((el) => el.textContent ?? "").join(" ");

		expect(maskedText).toContain("Docker");
		expect(maskedText).toContain("Fix the parser");
		// The executable path leaks the home directory, so it is masked too.
		expect(maskedText).toContain("/usr/local/bin/dockerd");
	});

	it("closes on Escape", async () => {
		const user = userEvent.setup();
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await user.click(pill());
		expect(await screen.findByTestId("memory-breakdown-popover")).toBeInTheDocument();

		await user.keyboard("{Escape}");
		expect(screen.queryByTestId("memory-breakdown-popover")).toBeNull();
	});

	it("copes with an empty consumer list and no active tasks", async () => {
		const user = userEvent.setup();
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await pushSnapshot(
			snapshot({ topConsumers: [], topTasks: [], activeTaskCount: 0, tasksRssApprox: 0, medianTaskRss: null }),
		);
		await user.click(pill());

		const popover = await screen.findByTestId("memory-breakdown-popover");
		expect(popover).toHaveTextContent(/Nothing outside dev-3\.0/i);
		expect(popover).toHaveTextContent("0 active tasks");
	});
});
