import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryItem } from "../../../../shared/library";
import { I18nProvider } from "../../../i18n";
import { setSensitiveProjectIds } from "../../../sensitive-projects";
import { setStreamerMode } from "../../../streamer-mode";
import { toast } from "../../../toast";
import LibraryScreen from "../LibraryScreen";

vi.mock("../../../rpc", () => ({
	isElectrobun: true,
	api: {
		request: {
			getLibrary: vi.fn(),
			getAgents: vi.fn(async () => [{ id: "claude", name: "Claude" }]),
			previewSharedMediaDelete: vi.fn(),
			deleteSharedMedia: vi.fn(),
			openTerminalPath: vi.fn(async () => {}),
		},
	},
}));
const confirmMock = vi.hoisted(() => ({ confirm: vi.fn(async (_opts: { title: string; message: string; danger?: boolean }) => true) }));
vi.mock("../../../confirm", () => confirmMock);
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

beforeEach(() => {
	mockGet.mockReset();
	confirmMock.confirm.mockReset().mockResolvedValue(true);
});
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

	describe("clean-up", () => {
		const clip = (id: string, taskId: string, over: Partial<LibraryItem> = {}) => item({
			key: `p1:${taskId}:${id}`, kind: "video", title: `Clip ${id}`, taskId, bytes: 20 * 1024 * 1024,
			image: { id, storedPath: `/pool/${id}.mp4`, originalPath: "/o", name: `${id}.mp4`, mime: "video/mp4", bytes: 20 * 1024 * 1024, createdAt: NOW },
			...over,
		});
		const CLIPS = [clip("c1", "t1"), clip("c2", "t2"), item({ key: "p1:t1:img", title: "Screenshot", image: { id: "img", storedPath: "/pool/s.png", originalPath: "/o", name: "s.png", mime: "image/png", bytes: 5, createdAt: NOW } })];
		const preview = api.request.previewSharedMediaDelete as unknown as ReturnType<typeof vi.fn>;
		const remove = api.request.deleteSharedMedia as unknown as ReturnType<typeof vi.fn>;
		const taskWith = (taskId: string, removedId: string) => ({
			id: taskId, seq: 12, title: "Fix login race", status: "completed",
			sharedVideos: [{ id: removedId, storedPath: `/pool/${removedId}.mp4`, originalPath: "/o", name: `${removedId}.mp4`, mime: "video/mp4", bytes: 20 * 1024 * 1024, createdAt: NOW, removedAt: NOW, removedBytes: 20 * 1024 * 1024 }],
		});

		beforeEach(() => {
			preview.mockReset().mockImplementation(async ({ mediaIds }: { mediaIds: string[] }) => ({ count: mediaIds.length, bytes: mediaIds.length * 20 * 1024 * 1024, freeableBytes: mediaIds.length * 20 * 1024 * 1024, failed: [], skipped: [] }));
			remove.mockReset().mockImplementation(async ({ taskId, mediaIds }: { taskId: string; mediaIds: string[] }) => ({
				task: taskWith(taskId, mediaIds[0]),
				summary: { count: mediaIds.length, bytes: 0, freeableBytes: mediaIds.length * 20 * 1024 * 1024, failed: [], skipped: [] },
			}));
		});

		it("offers selection only on clips and deletes a selection across tasks with one confirmation", async () => {
			const user = userEvent.setup();
			await renderScreen(CLIPS);
			expect(screen.getAllByTestId("library-row-select")).toHaveLength(2);
			await user.click(screen.getByRole("checkbox", { name: "Select Clip c1" }));
			const bar = screen.getByTestId("library-selection-bar");
			expect(bar).toHaveTextContent("1 clip selected");
			await user.click(within(bar).getByRole("button", { name: "Select all 2 shown" }));
			expect(bar).toHaveTextContent("2 clips selected");
			await user.click(screen.getByTestId("library-delete-selected"));
			expect(confirmMock.confirm).toHaveBeenCalledTimes(1);
			expect(confirmMock.confirm.mock.calls[0][0]).toMatchObject({ title: "Delete 2 clip files?", danger: true });
			expect(confirmMock.confirm.mock.calls[0][0].message).toContain("40 MB");
			expect(remove).toHaveBeenCalledTimes(2);
			expect(remove).toHaveBeenCalledWith({ projectId: "p1", taskId: "t1", mediaIds: ["c1"], skipRefused: true });
			expect(remove).toHaveBeenCalledWith({ projectId: "p1", taskId: "t2", mediaIds: ["c2"], skipRefused: true });
			expect(screen.queryByTestId("library-selection-bar")).toBeNull();
			expect(screen.getAllByText("Removed to free space")).toHaveLength(2);
			expect(screen.queryAllByTestId("library-row-select")).toHaveLength(0);
		});

		it("deletes nothing when the confirmation is declined", async () => {
			confirmMock.confirm.mockResolvedValue(false);
			const user = userEvent.setup();
			await renderScreen(CLIPS);
			await user.click(screen.getByRole("checkbox", { name: "Select Clip c1" }));
			await user.click(screen.getByTestId("library-delete-selected"));
			expect(remove).not.toHaveBeenCalled();
			expect(screen.getByTestId("library-selection-bar")).toHaveTextContent("1 clip selected");
		});

		it("deletes one clip from its row menu and reveals or copies a file path", async () => {
			const user = userEvent.setup();
			const writeText = vi.fn(async () => {});
			Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
			await renderScreen(CLIPS);
			await user.click(screen.getByRole("button", { name: "More actions for Screenshot" }));
			expect(screen.queryByRole("menuitem", { name: "Delete file…" })).toBeNull();
			await user.click(screen.getByRole("menuitem", { name: "Copy file path" }));
			expect(writeText).toHaveBeenCalledWith("/pool/s.png");
			await user.click(screen.getByRole("button", { name: "More actions for Clip c2" }));
			await user.click(screen.getByRole("menuitem", { name: /^(Reveal in Finder|Show in folder)$/ }));
			expect(api.request.openTerminalPath).toHaveBeenCalledWith({ path: "/pool/c2.mp4", mode: "reveal" });
			await user.click(screen.getByRole("button", { name: "More actions for Clip c2" }));
			await user.click(screen.getByRole("menuitem", { name: "Delete file…" }));
			expect(confirmMock.confirm.mock.calls[0][0].title).toBe("Delete the stored file of c2.mp4?");
			expect(remove).toHaveBeenCalledWith({ projectId: "p1", taskId: "t2", mediaIds: ["c2"], skipRefused: false });
		});

		it("never deletes a selected clip that the current filter hides", async () => {
			const user = userEvent.setup();
			await renderScreen(CLIPS);
			await user.click(screen.getByRole("checkbox", { name: "Select Clip c1" }));
			await user.type(screen.getByTestId("library-search"), "Clip c2");
			expect(screen.queryByTestId("library-selection-bar")).toBeNull();
			await user.click(screen.getByRole("checkbox", { name: "Select Clip c2" }));
			expect(screen.getByTestId("library-selection-bar")).toHaveTextContent("1 clip selected");
			await user.click(screen.getByTestId("library-delete-selected"));
			expect(remove).toHaveBeenCalledTimes(1);
			expect(remove).toHaveBeenCalledWith({ projectId: "p1", taskId: "t2", mediaIds: ["c2"], skipRefused: true });
			await user.clear(screen.getByTestId("library-search"));
			expect(screen.getByRole("checkbox", { name: "Select Clip c1" })).not.toBeChecked();
		});

		it("selects all only up to the rendered page", async () => {
			const user = userEvent.setup();
			const many = Array.from({ length: 160 }, (_, i) => clip(`n${i}`, "t1", { createdAt: NOW - i }));
			await renderScreen(many);
			await user.click(screen.getByRole("checkbox", { name: "Select Clip n0" }));
			await user.click(screen.getByRole("button", { name: "Select all 150 shown" }));
			expect(screen.getByTestId("library-selection-bar")).toHaveTextContent("150 clips selected");
			await user.click(screen.getByTestId("library-delete-selected"));
			expect(remove.mock.calls[0][0].mediaIds).toHaveLength(150);
			expect(remove.mock.calls[0][0].mediaIds).not.toContain("n155");
		});

		it("skips a clip the server refuses and still deletes the rest of its task", async () => {
			preview.mockImplementation(async ({ mediaIds }: { mediaIds: string[] }) => {
				const kept = mediaIds.filter((id) => id !== "c1");
				const skipped = mediaIds.includes("c1") ? [{ id: "c1", reason: "Stored file is shared with another record" }] : [];
				return { count: kept.length, bytes: kept.length * 20 * 1024 * 1024, freeableBytes: kept.length * 20 * 1024 * 1024, failed: [], skipped };
			});
			const user = userEvent.setup();
			await renderScreen([clip("c1", "t1"), clip("c3", "t1")]);
			await user.click(screen.getByRole("checkbox", { name: "Select Clip c1" }));
			await user.click(screen.getByRole("checkbox", { name: "Select Clip c3" }));
			await user.click(screen.getByTestId("library-delete-selected"));
			const dialog = confirmMock.confirm.mock.calls[0][0];
			expect(dialog.title).toBe("Delete 1 clip file?");
			expect(dialog.message).toContain("1 clip can't be deleted and is skipped: c1.mp4.");
			expect(remove).toHaveBeenCalledWith({ projectId: "p1", taskId: "t1", mediaIds: ["c3"], skipRefused: true });
		});

		it("names the clips that failed and keeps them selected for a retry", async () => {
			const error = vi.spyOn(toast, "error");
			remove.mockImplementation(async ({ taskId, mediaIds }: { taskId: string; mediaIds: string[] }) => {
				if (taskId === "t2") throw new Error("Not a deletable clip: 02643e60-cf4b");
				return { task: taskWith(taskId, mediaIds[0]), summary: { count: 1, bytes: 0, freeableBytes: 1, failed: [], skipped: [] } };
			});
			const user = userEvent.setup();
			await renderScreen(CLIPS);
			await user.click(screen.getByRole("checkbox", { name: "Select Clip c1" }));
			await user.click(screen.getByRole("checkbox", { name: "Select Clip c2" }));
			await user.click(screen.getByTestId("library-delete-selected"));
			expect(error).toHaveBeenCalledWith("Couldn't delete 1 clip: c2.mp4", undefined);
			expect(screen.getByTestId("library-selection-bar")).toHaveTextContent("1 clip selected");
			expect(screen.getByRole("checkbox", { name: "Select Clip c2" })).toBeChecked();
			error.mockRestore();
		});

		it("names a single refused clip by its file name, never its id", async () => {
			const error = vi.spyOn(toast, "error");
			preview.mockRejectedValue(new Error("Stored file is shared with another record: c2"));
			const user = userEvent.setup();
			await renderScreen(CLIPS);
			await user.click(screen.getAllByTestId("library-row-menu")[1]);
			await user.click(screen.getByRole("menuitem", { name: "Delete file…" }));
			expect(remove).not.toHaveBeenCalled();
			expect(error.mock.calls[0][0]).toContain("Stored file is shared with another record: c2.mp4");
			error.mockRestore();
		});

		it("drops a selected clip that a push tombstones", async () => {
			const user = userEvent.setup();
			await renderScreen(CLIPS);
			await user.click(screen.getByRole("checkbox", { name: "Select Clip c2" }));
			await act(async () => {
				window.dispatchEvent(new CustomEvent("rpc:taskUpdated", { detail: { projectId: "p1", task: taskWith("t2", "c2") } }));
			});
			expect(screen.queryByTestId("library-selection-bar")).toBeNull();
		});

		it("lists a tombstoned clip as removed, out of the size and with no file actions", async () => {
			await renderScreen([clip("c1", "t1", { removedAt: NOW, bytes: 0 })]);
			expect(screen.getByText("Removed to free space")).toBeInTheDocument();
			expect(screen.getByTestId("library-total-bytes")).toHaveTextContent("0 B");
			expect(screen.queryByTestId("library-row-select")).toBeNull();
			expect(screen.queryByTestId("library-row-menu")).toBeNull();
		});
	});
});
