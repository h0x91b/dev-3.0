import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import SystemLoadRows from "../SystemLoadRows";
import type { SystemLoadSnapshot } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: { request: { getSystemLoad: vi.fn(), scanWorktreeDiskUsage: vi.fn() } },
}));

import { api } from "../../rpc";

const mockedGet = api.request.getSystemLoad as ReturnType<typeof vi.fn>;
const mockedScan = api.request.scanWorktreeDiskUsage as ReturnType<typeof vi.fn>;

function snapshot(overrides?: Partial<SystemLoadSnapshot>): SystemLoadSnapshot {
	return {
		cpuBusy: 0.42,
		cpuLoadPercent: 42,
		cpuPressure: "normal",
		cores: 10,
		loadAvg: [3.5, 2.25, 1],
		topCpuConsumers: [{ name: "Docker", cpu: 120, processCount: 3, path: "/usr/local/bin/dockerd", cmdline: "dockerd" }],
		appCpu: 4,
		topCpuTasks: [{ shortId: "abc12345", taskId: "abc12345-full", title: "Fix the parser", projectId: "p1", cpu: 95 }],
		disk: { free: 120e9, total: 500e9, pressure: "normal" },
		...overrides,
	};
}

function renderRows(navigate = vi.fn(), variant: "menu" | "bar" = "menu") {
	render(
		<I18nProvider>
			<SystemLoadRows navigate={navigate} variant={variant} />
		</I18nProvider>,
	);
	return navigate;
}

beforeEach(() => {
	mockedGet.mockReset();
	mockedGet.mockResolvedValue(snapshot());
	mockedScan.mockReset();
	mockedScan.mockResolvedValue([]);
});

describe("SystemLoadRows", () => {
	it("renders nothing until the first snapshot", async () => {
		mockedGet.mockResolvedValue(null);
		renderRows();
		await act(async () => {});
		expect(screen.queryByTestId("cpu-load-row")).toBeNull();
		expect(screen.queryByTestId("disk-space-row")).toBeNull();
	});

	it("shows CPU busy % and disk free, and follows pushes", async () => {
		renderRows();
		expect(await screen.findByTestId("cpu-load-row")).toHaveTextContent("42%");
		expect(screen.getByTestId("disk-space-row")).toHaveTextContent("120 GB");
		// Decimal GB, so the number matches Finder.
		expect(screen.getByTestId("disk-space-row")).toHaveAccessibleName("120 GB of disk still free");

		await act(async () => {
			window.dispatchEvent(new CustomEvent("rpc:systemLoadUpdated", { detail: snapshot({ cpuLoadPercent: 90, disk: null }) }));
		});
		expect(screen.getByTestId("cpu-load-row")).toHaveTextContent("90%");
		expect(screen.queryByTestId("disk-space-row")).toBeNull();
	});

	it("CPU breakdown lists outsiders and jumps to a busy task", async () => {
		const user = userEvent.setup();
		const navigate = renderRows();
		await user.click(await screen.findByTestId("cpu-load-row"));
		const panel = await screen.findByTestId("cpu-load-row-popover");
		expect(panel).toHaveTextContent("Docker");
		expect(panel).toHaveTextContent("120%");
		expect(panel).toHaveTextContent("load 3.50 2.25 1.00");

		await user.click(within(panel).getByText("Fix the parser"));
		expect(navigate).toHaveBeenCalledWith({ screen: "project", projectId: "p1", activeTaskId: "abc12345-full" });
	});

	it("scans worktree sizes only when the disk breakdown opens", async () => {
		mockedScan.mockResolvedValue([
			{ shortId: "aaa00000", taskId: "aaa00000-full", title: "Big one", projectId: "p1", bytes: 3e9 },
			{ shortId: "bbb00000", taskId: "bbb00000-full", title: "Small one", projectId: "p1", bytes: 1e9 },
		]);
		const user = userEvent.setup();
		renderRows();
		await screen.findByTestId("disk-space-row");
		expect(mockedScan).not.toHaveBeenCalled();

		await user.click(screen.getByTestId("disk-space-row"));
		const section = await screen.findByTestId("disk-worktrees");
		expect(await within(section).findByText("Big one")).toBeInTheDocument();
		expect(section).toHaveTextContent("2 worktrees");
		expect(section).toHaveTextContent("4.0 GB");
		expect(mockedScan).toHaveBeenCalledTimes(1);
	});

	it("the disk breakdown names itself Disk and shows how full it is, never memory's heading", async () => {
		mockedScan.mockResolvedValue([]);
		const user = userEvent.setup();
		renderRows();
		await user.click(await screen.findByTestId("disk-space-row"));
		const panel = (await screen.findByTestId("disk-worktrees")).parentElement!;
		expect(panel).toHaveTextContent("Disk");
		expect(panel).not.toHaveTextContent("System");
		expect(panel).toHaveTextContent("76% of 500 GB in use");
	});

	it("each menu row leads with its own icon", async () => {
		renderRows();
		for (const id of ["cpu-load-row", "disk-space-row"]) {
			expect((await screen.findByTestId(id)).querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(1);
		}
	});

	it("header pills carry the icon beside the number", async () => {
		mockedGet.mockResolvedValue(
			snapshot({ cpuPressure: "warn", disk: { free: 12e9, total: 500e9, pressure: "warn" } }),
		);
		renderRows(vi.fn(), "bar");
		for (const id of ["cpu-load-pill", "disk-space-pill"]) {
			expect((await screen.findByTestId(id)).querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(1);
		}
	});

	it("header pills appear only for a resource at warn or critical, coloured by its level", async () => {
		mockedGet.mockResolvedValue(
			snapshot({ cpuLoadPercent: 160, cpuPressure: "critical", disk: { free: 120e9, total: 500e9, pressure: "normal" } }),
		);
		renderRows(vi.fn(), "bar");
		const cpu = await screen.findByTestId("cpu-load-pill");
		expect(cpu).toHaveTextContent("160%");
		expect(cpu.className).toContain("text-danger");
		expect(screen.queryByTestId("disk-space-pill")).toBeNull();

		await act(async () => {
			window.dispatchEvent(
				new CustomEvent("rpc:systemLoadUpdated", {
					detail: snapshot({ cpuPressure: "normal", disk: { free: 12e9, total: 500e9, pressure: "warn" } }),
				}),
			);
		});
		expect(screen.queryByTestId("cpu-load-pill")).toBeNull();
		expect(screen.getByTestId("disk-space-pill").className).toContain("text-warning-strong");
	});
});
