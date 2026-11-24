import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryItem } from "../../../../shared/library";
import { I18nProvider } from "../../../i18n";
import { setSensitiveProjectIds } from "../../../sensitive-projects";
import { setStreamerMode } from "../../../streamer-mode";
import LibraryScreen from "../LibraryScreen";

vi.mock("../../../rpc", () => ({
	api: { request: { getLibrary: vi.fn(), getAgents: vi.fn(async () => [{ id: "claude", name: "Claude" }]) } },
}));
vi.mock("../../../hooks/useNarrowViewport", () => ({ useNarrowViewport: () => false }));

import { api } from "../../../rpc";
const mockGet = api.request.getLibrary as unknown as ReturnType<typeof vi.fn>;

const NOW = Date.now();

function item(over: Partial<LibraryItem>): LibraryItem {
	return {
		key: "k", kind: "image", projectId: "p1", projectName: "dev-3.0", taskId: "t1", taskSeq: 12, taskTitle: "Fix login race",
		taskStatus: "completed", agentId: "claude", title: "Shot", name: "shot.png", createdAt: NOW, bytes: 1024, versions: 1,
		unread: false, missing: false, goneBytes: 0, live: false, order: 0, ...over,
	};
}

const ITEMS: LibraryItem[] = [
	item({
		key: "r1", kind: "report", title: "Login race audit", versions: 3, unread: true, bytes: 2048,
		artifact: { id: "a1", kind: "html", title: "Login race audit", name: "index.html", storedPath: "/s/a1/index.html", originalPath: "/o", bytes: 2048, createdAt: NOW, assets: [], isUnread: true },
	}),
	item({
		key: "v1", kind: "video", title: "Promo cut", projectId: "p2", projectName: "video-edit", taskId: "t2", taskSeq: 3, taskTitle: "Render promo",
		taskStatus: "in-progress", bytes: 0, goneBytes: 300 * 1024 * 1024, createdAt: NOW - 3 * 86_400_000, missing: true,
		image: { id: "m1", storedPath: "/s/m1.mp4", originalPath: "/o", name: "cut.mp4", mime: "video/mp4", bytes: 1, createdAt: NOW },
	}),
];

async function renderScreen(items = ITEMS, projectId: string | null = null) {
	mockGet.mockResolvedValue({ items, generatedAt: new Date(NOW).toISOString() });
	const onOpenTask = vi.fn();
	render(
		<I18nProvider>
			<LibraryScreen projectId={projectId} onOpenTask={onOpenTask} />
		</I18nProvider>,
	);
	await act(async () => {});
	return { onOpenTask };
}

beforeEach(() => mockGet.mockReset());
afterEach(() => {
	setSensitiveProjectIds([]);
	setStreamerMode(false);
});

describe("LibraryScreen", () => {
	it("lists every project's outputs with provenance, size and the unseen count", async () => {
		await renderScreen();
		const rows = screen.getAllByTestId("library-row");
		expect(rows).toHaveLength(2);
		expect(rows[0]).toHaveTextContent("Login race audit");
		expect(rows[0]).toHaveTextContent("v3");
		expect(rows[0]).toHaveTextContent("#12");
		expect(rows[0]).toHaveTextContent("Claude");
		expect(rows[1]).toHaveTextContent("File removed");
		expect(rows[1]).not.toHaveTextContent("MB");
		expect(screen.getByTestId("library-unseen-toggle")).toHaveTextContent("1");
		expect(screen.getByText("Largest projects")).toBeInTheDocument();
	});

	it("filters by search, type and unseen", async () => {
		const user = userEvent.setup();
		await renderScreen();
		await user.type(screen.getByTestId("library-search"), "promo");
		expect(screen.getAllByTestId("library-row")).toHaveLength(1);
		await user.clear(screen.getByTestId("library-search"));
		await user.click(within(screen.getByTestId("library-kind-switch")).getByRole("radio", { name: "Reports" }));
		expect(screen.getAllByTestId("library-row")).toHaveLength(1);
		await user.click(within(screen.getByTestId("library-kind-switch")).getByRole("radio", { name: "All" }));
		await user.click(screen.getByTestId("library-unseen-toggle"));
		expect(screen.getAllByTestId("library-row").map((r) => r.textContent)).toEqual([expect.stringContaining("Login race audit")]);
	});

	it("narrows to one project from the disk strip", async () => {
		const user = userEvent.setup();
		await renderScreen();
		await user.click(screen.getByRole("button", { name: "Show only video-edit" }));
		expect(screen.getAllByTestId("library-row")).toHaveLength(1);
		expect(screen.getByText("Promo cut")).toBeInTheDocument();
	});

	it("opens a report in the artifact viewer as a popup and marks it seen", async () => {
		const user = userEvent.setup();
		await renderScreen();
		const listener = vi.fn();
		window.addEventListener("dev3:openArtifactViewer", listener);
		await user.click(screen.getByRole("button", { name: "Open Login race audit" }));
		window.removeEventListener("dev3:openArtifactViewer", listener);
		expect(listener.mock.calls[0][0].detail).toMatchObject({ taskId: "t1", projectId: "p1", index: 0, paneless: true, artifacts: [{ id: "a1" }] });
		expect(screen.getByTestId("library-unseen-toggle")).toHaveTextContent("0");
	});

	it("opens a clip in the image viewer and a finished task as archived", async () => {
		const user = userEvent.setup();
		const { onOpenTask } = await renderScreen();
		const listener = vi.fn();
		window.addEventListener("dev3:openImageViewer", listener);
		await user.click(screen.getByRole("button", { name: "Open Promo cut" }));
		window.removeEventListener("dev3:openImageViewer", listener);
		expect(listener.mock.calls[0][0].detail).toMatchObject({ taskId: "t2", projectId: "p2", index: 0, images: [{ id: "m1" }] });
		await user.click(screen.getAllByTitle("Open the task")[0]);
		expect(onOpenTask).toHaveBeenCalledWith("t1", "p1", { archived: true });
	});

	it("tells what is already gone, and keeps it out of the size", async () => {
		await renderScreen();
		expect(screen.getByTestId("library-total-bytes")).toHaveTextContent("2 KB");
		expect(screen.getByTestId("library-missing-note")).toHaveTextContent("1 file already removed (300 MB) is not counted");
	});

	it("patches one task from a push instead of refetching the archive", async () => {
		await renderScreen();
		expect(mockGet).toHaveBeenCalledTimes(1);
		const task = {
			id: "t1", seq: 12, title: "Fix login race", status: "completed", agentId: "claude",
			sharedImages: [{ id: "n1", storedPath: "/s/n1.png", originalPath: "/o", name: "new.png", mime: "image/png", bytes: 10, createdAt: NOW + 1, isUnread: true, caption: "Fresh capture" }],
		};
		await act(async () => {
			window.dispatchEvent(new CustomEvent("rpc:taskUpdated", { detail: { projectId: "p1", task } }));
		});
		expect(mockGet).toHaveBeenCalledTimes(1);
		const rows = screen.getAllByTestId("library-row");
		expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Fresh capture"), expect.stringContaining("Promo cut")]);
	});

	it("drops a removed task's items locally", async () => {
		await renderScreen();
		await act(async () => {
			window.dispatchEvent(new CustomEvent("rpc:taskRemoved", { detail: { projectId: "p2", taskId: "t2" } }));
		});
		expect(screen.getAllByTestId("library-row")).toHaveLength(1);
		expect(mockGet).toHaveBeenCalledTimes(1);
	});

	it("refetches when a push brings the first output of a project it has never listed", async () => {
		await renderScreen();
		const task = { id: "t7", seq: 1, title: "New", status: "in-progress", sharedImages: [{ id: "z", storedPath: "/z", originalPath: "/o", name: "z.png", mime: "image/png", bytes: 1, createdAt: NOW }] };
		await act(async () => {
			window.dispatchEvent(new CustomEvent("rpc:taskUpdated", { detail: { projectId: "p9", task } }));
		});
		expect(mockGet).toHaveBeenCalledTimes(2);
	});

	it("shows the empty state when nothing was ever shown", async () => {
		await renderScreen([]);
		expect(screen.getByTestId("library-empty")).toHaveTextContent("Nothing shown yet");
	});

	it("offers to clear filters when nothing matches", async () => {
		const user = userEvent.setup();
		await renderScreen();
		await user.type(screen.getByTestId("library-search"), "zzz");
		await user.click(screen.getByRole("button", { name: "Clear filters" }));
		expect(screen.getAllByTestId("library-row")).toHaveLength(2);
	});

	it("hides a privacy-locked project's titles in streamer mode and keeps them out of search", async () => {
		setSensitiveProjectIds(["p2"]);
		setStreamerMode(true);
		const user = userEvent.setup();
		await renderScreen();
		expect(screen.queryByText("Promo cut")).toBeNull();
		await user.type(screen.getByTestId("library-search"), "promo");
		expect(screen.queryAllByTestId("library-row")).toHaveLength(0);
	});
});
