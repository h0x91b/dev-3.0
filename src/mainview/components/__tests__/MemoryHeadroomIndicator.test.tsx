import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import MemoryHeadroomIndicator from "../MemoryHeadroomIndicator";
import type { SystemMemorySnapshot } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: { request: { getSystemMemory: vi.fn(), scanWorktreeOrphans: vi.fn(), killWorktreeOrphans: vi.fn() } },
}));

vi.mock("../../confirm", () => ({ confirm: vi.fn() }));
vi.mock("../../toast", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { confirm } from "../../confirm";
import { api } from "../../rpc";

const mockedConfirm = confirm as unknown as ReturnType<typeof vi.fn>;
const mockedGet = api.request.getSystemMemory as ReturnType<typeof vi.fn>;
const mockedScan = api.request.scanWorktreeOrphans as ReturnType<typeof vi.fn>;
const mockedKill = api.request.killWorktreeOrphans as ReturnType<typeof vi.fn>;

const GIB = 1024 ** 3;

function snapshot(overrides?: Partial<SystemMemorySnapshot>): SystemMemorySnapshot {
	return {
		headroom: 12 * GIB,
		used: 52 * GIB,
		total: 64 * GIB,
		cached: 8 * GIB,
		// The header pill only renders while the OS reports pressure, so the shared
		// fixture is a machine under warning — the tests that need a calm machine
		// (and the menu row) pass `normal` explicitly.
		pressure: "warn",
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

function renderIndicator(navigate = vi.fn(), variant: "bar" | "menu" = "bar") {
	const result = render(
		<I18nProvider>
			<MemoryHeadroomIndicator navigate={navigate} variant={variant} />
		</I18nProvider>,
	);
	return { ...result, navigate };
}

function renderMenuRow(navigate = vi.fn()) {
	return renderIndicator(navigate, "menu");
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
	// Nothing leaked is the default: the leftovers section must be absent unless a
	// test says otherwise.
	mockedScan.mockReset();
	mockedScan.mockResolvedValue([]);
	mockedKill.mockReset();
	mockedKill.mockResolvedValue({ killed: 0, leftovers: 0 });
	mockedConfirm.mockReset();
	mockedConfirm.mockResolvedValue(true);
	mockViewport(1920);
});

describe("MemoryHeadroomIndicator — where it lives", () => {
	it("keeps the header bar clean while the OS says the memory is fine", async () => {
		mockedGet.mockResolvedValue(snapshot({ pressure: "normal" }));
		renderIndicator();
		await waitFor(() => expect(mockedGet).toHaveBeenCalled());
		expect(screen.queryByTestId("memory-headroom-indicator")).toBeNull();
	});

	it("appears in the bar the moment the OS starts warning", async () => {
		mockedGet.mockResolvedValue(snapshot({ pressure: "normal" }));
		renderIndicator();
		await waitFor(() => expect(mockedGet).toHaveBeenCalled());
		expect(screen.queryByTestId("memory-headroom-indicator")).toBeNull();

		await pushSnapshot(snapshot({ pressure: "warn" }));
		expect(pill()).toBeInTheDocument();
		expect(pill().className).toContain("text-warning");
	});

	it("leaves again once the pressure is gone", async () => {
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await pushSnapshot(snapshot({ pressure: "normal" }));
		expect(screen.queryByTestId("memory-headroom-indicator")).toBeNull();
	});

	it("is always there as a menu row, pressure or not", async () => {
		mockedGet.mockResolvedValue(snapshot({ pressure: "normal" }));
		renderMenuRow();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		expect(pill()).toHaveAttribute("role", "menuitem");
		expect(pill()).toHaveTextContent("Memory left");
		expect(pill()).toHaveTextContent("12 GB");
	});

	it("is neutral in the menu at normal pressure — green would read as a claim", async () => {
		mockedGet.mockResolvedValue(snapshot({ pressure: "normal" }));
		renderMenuRow();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		const number = pill().querySelector(".tabular-nums") as HTMLElement;
		expect(number.className).toContain("text-fg-3");
		expect(number.className).not.toContain("text-success");
	});

	it("colours the level bar from the OS verdict, never from the percentage", async () => {
		mockedGet.mockResolvedValue(snapshot({ pressure: "normal" }));
		renderMenuRow();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		const bar = () => pill().querySelector(".hdr-mem-bar") as HTMLElement;
		// 81% used, yet the OS says normal — on a big machine that is genuinely fine,
		// so the bar must stay accent rather than turning red on our own threshold.
		expect(bar().className).toContain("bg-accent");

		await pushSnapshot(snapshot({ pressure: "critical" }));
		expect(bar().className).toContain("bg-danger");
		expect(bar().className).not.toContain("bg-accent");
	});

	it("opens the breakdown from the menu row on click", async () => {
		const user = userEvent.setup();
		mockedGet.mockResolvedValue(snapshot({ pressure: "normal" }));
		renderMenuRow();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await user.click(pill());
		expect(await screen.findByTestId("memory-breakdown-popover")).toBeInTheDocument();
	});
});

describe("MemoryHeadroomIndicator — the pill", () => {
	it("shows how much memory is LEFT, not how much is used", async () => {
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());

		// 12 GiB free out of 64 — the used figure (52) must not be the headline.
		expect(pill()).toHaveTextContent("12 GB");
		expect(pill()).not.toHaveTextContent("52");
	});

	it("spells the unit out, because the number carries the widget on its own", async () => {
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		// There is no glyph beside it, so a bare "12G" would read as a code.
		expect(pill().textContent).toMatch(/\bGB\b/);
	});

	it("puts the level in a bar under the number, sized by memory used", async () => {
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		const bar = pill().querySelector(".hdr-mem-bar") as HTMLElement;
		expect(bar).not.toBeNull();
		// 52 of 64 GiB used.
		expect(bar.style.width).toBe("81%");
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
		await waitFor(() => expect(pill()).toHaveTextContent("12 GB"));
		await pushSnapshot(snapshot({ headroom: 3 * GIB }));
		expect(pill()).toHaveTextContent("3.0 GB");
	});

	it("keeps a touch-sized target on narrow, where it lives inside the header sheet", async () => {
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

describe("MemoryHeadroomIndicator — leftover processes", () => {
	const LEFTOVERS = [
		{
			shortId: "aaaa1111",
			taskId: "aaaa1111-full",
			title: "Fix the toast dismiss button",
			projectId: "p1",
			command: "node dist/daemon.js",
			pids: [101, 102],
			processCount: 2,
			rss: 6 * GIB,
		},
		{
			shortId: "bbbb2222",
			taskId: null,
			title: "",
			projectId: "",
			command: "node dist/daemon.js",
			pids: [201],
			processCount: 1,
			rss: 1 * GIB,
		},
	];

	it("says nothing at all when nothing leaked", async () => {
		const user = userEvent.setup();
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await user.click(pill());
		await screen.findByTestId("memory-breakdown-popover");

		// A permanent "all clean" line would train the eye to skip the region.
		expect(screen.queryByTestId("memory-leftovers")).toBeNull();
	});

	it("lists the leftovers per task with a total, and names an unresolved task by its id", async () => {
		mockedScan.mockResolvedValue(LEFTOVERS);
		const user = userEvent.setup();
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await user.click(pill());

		const section = await screen.findByTestId("memory-leftovers");
		expect(section).toHaveTextContent("3 processes still running");
		expect(section).toHaveTextContent("7.0 GB");
		expect(section).toHaveTextContent("Fix the toast dismiss button");
		expect(section).toHaveTextContent("bbbb2222");
	});

	it("kills exactly the PIDs it listed, after a confirmation", async () => {
		mockedScan.mockResolvedValue(LEFTOVERS);
		mockedKill.mockResolvedValue({ killed: 3, leftovers: 0 });
		const user = userEvent.setup();
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await user.click(pill());
		await screen.findByTestId("memory-leftovers");

		await user.click(screen.getByTestId("memory-leftovers-kill-all"));

		// The popover closes before the dialog: a confirm under a hover-dismissed
		// popover reads as a dialog with no context.
		expect(screen.queryByTestId("memory-breakdown-popover")).toBeNull();
		await waitFor(() => expect(mockedConfirm).toHaveBeenCalled());
		expect(mockedConfirm.mock.calls[0][0]).toMatchObject({ danger: true });
		await waitFor(() => expect(mockedKill).toHaveBeenCalledWith({ pids: [101, 102, 201] }));
	});

	it("kills nothing when the confirmation is declined", async () => {
		mockedScan.mockResolvedValue(LEFTOVERS);
		mockedConfirm.mockResolvedValue(false);
		const user = userEvent.setup();
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await user.click(pill());
		await screen.findByTestId("memory-leftovers");

		await user.click(screen.getByTestId("memory-leftovers-kill-all"));

		await waitFor(() => expect(mockedConfirm).toHaveBeenCalled());
		expect(mockedKill).not.toHaveBeenCalled();
	});

	it("kills one task's leftovers straight from its row, without a dialog", async () => {
		mockedScan.mockResolvedValue(LEFTOVERS);
		mockedKill.mockResolvedValue({ killed: 2, leftovers: 0 });
		const user = userEvent.setup();
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await user.click(pill());
		await screen.findByTestId("memory-leftovers");

		await user.click(screen.getByTestId("memory-leftovers-kill-aaaa1111"));

		// One named task with its count on screen — the row vanishing is the receipt.
		await waitFor(() => expect(mockedKill).toHaveBeenCalledWith({ pids: [101, 102] }));
		expect(mockedConfirm).not.toHaveBeenCalled();
		await waitFor(() => expect(screen.queryByTestId("memory-leftovers-kill-aaaa1111")).toBeNull());
		// The other task survives, and the totals follow it down.
		expect(screen.getByTestId("memory-leftovers")).toHaveTextContent("1 process still running");
	});

	it("rescans on demand", async () => {
		mockedScan.mockResolvedValue(LEFTOVERS);
		const user = userEvent.setup();
		renderIndicator();
		await waitFor(() => expect(pill()).toBeInTheDocument());
		await user.click(pill());
		await screen.findByTestId("memory-leftovers");
		expect(mockedScan).toHaveBeenCalledTimes(1);

		mockedScan.mockResolvedValue([LEFTOVERS[1]]);
		await user.click(screen.getByTestId("memory-leftovers-rescan"));

		await waitFor(() => expect(screen.getByTestId("memory-leftovers")).toHaveTextContent("1 process still running"));
	});
});
