import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SharedArtifact, SharedImage, Task } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import SharedOutputsList from "../SharedOutputsList";

vi.mock("../../rpc", () => ({ api: { request: { deleteSharedMedia: vi.fn(), previewSharedMediaDelete: vi.fn(), readImageBase64: vi.fn(async () => null), getSharedMediaUrl: vi.fn(async () => null) } } }));
const confirmMock = vi.hoisted(() => ({ confirm: vi.fn(async (_options: { title: string; message: string; danger?: boolean }) => true) }));
vi.mock("../../confirm", () => confirmMock);
import { api } from "../../rpc";

const MB = 1024 * 1024;
function video(id: string, bytes: number, createdAt: number, removedAt?: number): SharedImage {
	return { ...image(id), storedPath: `/wt/shared-images/${id}.mp4`, name: `${id}.mp4`, mime: "video/mp4", bytes, createdAt, ...(removedAt ? { removedAt } : {}) };
}

function image(id: string, caption?: string): SharedImage {
	return {
		id,
		storedPath: `/wt/shared-images/${id}.png`,
		originalPath: `/tmp/${id}.png`,
		name: `${id}.png`,
		mime: "image/png",
		bytes: 10,
		caption,
		createdAt: 1_780_000_000_000,
	};
}

function artifact(id: string): SharedArtifact {
	return {
		id,
		kind: "html",
		title: `Report ${id}`,
		name: `${id}.html`,
		storedPath: `/wt/shared-artifacts/${id}/${id}.html`,
		originalPath: `/tmp/${id}.html`,
		bytes: 10,
		createdAt: 1_780_000_000_000,
		assets: [],
	};
}

function renderList(task: Partial<Task>) {
	return render(
		<I18nProvider>
			<SharedOutputsList task={{ id: "task-1", ...task } as Task} projectId="project-1" />
		</I18nProvider>,
	);
}

describe("SharedOutputsList", () => {
	it("renders nothing when the task shared neither images nor artifacts", () => {
		const { container } = renderList({});
		expect(container).toBeEmptyDOMElement();
	});

	it("enumerates every image with its caption and every artifact with its title", () => {
		renderList({
			sharedImages: [image("before", "current bug"), image("after")],
			sharedArtifacts: [artifact("a")],
		});
		const imageRows = screen.getAllByTestId("shared-image-link");
		expect(imageRows).toHaveLength(2);
		expect(imageRows[0]).toHaveTextContent("before.png");
		expect(imageRows[0]).toHaveTextContent("current bug");
		expect(screen.getAllByTestId("shared-artifact-link")).toHaveLength(1);
		expect(screen.getByTestId("shared-artifact-link")).toHaveTextContent("Report a");
	});

	it("lists an artifact record written before assets existed instead of crashing", () => {
		const legacy = { ...artifact("old"), assets: undefined, images: [] } as unknown as SharedArtifact;
		renderList({ sharedArtifacts: [legacy] });
		expect(screen.getByTestId("shared-artifact-link")).toHaveTextContent("Report old");
	});

	it("opens the image viewer at the clicked row, not at the newest image", async () => {
		const spy = vi.fn();
		window.addEventListener("dev3:openImageViewer", spy);
		renderList({ sharedImages: [image("first"), image("second"), image("third")] });
		await userEvent.click(screen.getAllByTestId("shared-image-link")[0]);
		window.removeEventListener("dev3:openImageViewer", spy);
		const detail = (spy.mock.calls[0][0] as CustomEvent).detail;
		expect(detail).toMatchObject({ taskId: "task-1", projectId: "project-1", index: 0 });
		expect(detail.images).toHaveLength(3);
	});

	it("shows a clip as a play tile under the Media heading and opens it in the same viewer", async () => {
		const clip = { ...image("clip"), storedPath: "/wt/shared-images/clip.mp4", name: "clip.mp4", mime: "video/mp4", createdAt: 1_780_000_000_001 };
		const spy = vi.fn();
		window.addEventListener("dev3:openImageViewer", spy);
		renderList({ sharedImages: [image("shot")], sharedVideos: [clip] });
		expect(screen.getByRole("heading", { name: /Media/ })).toBeInTheDocument();
		expect(screen.getByTestId("shared-video-card")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Open video clip.mp4" }));
		window.removeEventListener("dev3:openImageViewer", spy);
		expect((spy.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ index: 1 });
	});

	it("shows an audio track as its own tile under the Media heading, in shared order", async () => {
		const track = { ...image("track"), storedPath: "/wt/shared-images/track.mp3", name: "voice.mp3", mime: "audio/mpeg", createdAt: 1_780_000_000_001 };
		const spy = vi.fn();
		window.addEventListener("dev3:openImageViewer", spy);
		renderList({ sharedImages: [image("shot")], sharedAudio: [track] });
		expect(screen.getByRole("heading", { name: /Media/ })).toBeInTheDocument();
		expect(screen.getByTestId("shared-audio-card")).toHaveAttribute("title", "Audio");
		expect(screen.queryByTestId("shared-video-card")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Open audio voice.mp3" }));
		window.removeEventListener("dev3:openImageViewer", spy);
		expect((spy.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ index: 1 });
	});

	it("opens the artifact popup at the clicked row", async () => {
		const spy = vi.fn();
		window.addEventListener("dev3:openArtifactViewer", spy);
		renderList({ sharedArtifacts: [artifact("a"), artifact("b")] });
		await userEvent.click(screen.getAllByTestId("shared-artifact-link")[1]);
		window.removeEventListener("dev3:openArtifactViewer", spy);
		expect((spy.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ taskId: "task-1", projectId: "project-1", index: 1 });
	});

	it("leads with artifacts — the deliverable outranks the screenshots", () => {
		renderList({ sharedImages: [image("shot")], sharedArtifacts: [artifact("a")] });
		const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
		expect(headings).toEqual([expect.stringContaining("Artifacts"), expect.stringContaining("Images")]);
	});

	it("names each section so the block is reachable by heading, not only by eye", () => {
		renderList({ sharedImages: [image("shot")], sharedArtifacts: [artifact("a")] });
		expect(screen.getByRole("region", { name: /Artifacts/ })).toBeTruthy();
		expect(screen.getByRole("region", { name: /Images/ })).toBeTruthy();
	});

	it("describes an artifact by size and assets, never by its always-identical filename", () => {
		renderList({ sharedArtifacts: [{ ...artifact("a"), bytes: 2048, assets: [{ name: "app.css", storedPath: "/s", originalPath: "/o", mime: "text/css", bytes: 1 }] }] });
		const row = screen.getByTestId("shared-artifact-link");
		expect(row).toHaveTextContent("2 KB · 1 asset");
		expect(row).not.toHaveTextContent("a.html");
	});

	describe("delete older large clips", () => {
		it("is hidden while there is at most one large clip", () => {
			renderList({ sharedVideos: [video("big", 300 * MB, 2), video("small", 2 * MB, 1)] });
			expect(screen.queryByTestId("shared-media-delete-older")).toBeNull();
		});

		it("labels the sweep with the disk it really frees and deletes after a confirmation", async () => {
			const preview = vi.mocked(api.request.previewSharedMediaDelete);
			const request = vi.mocked(api.request.deleteSharedMedia);
			preview.mockReset();
			request.mockReset();
			confirmMock.confirm.mockClear();
			// 400 MB stored, but one of the two is a clone of a live original.
			preview.mockResolvedValue({ count: 2, bytes: 400 * MB, freeableBytes: 200 * MB, failed: [] });
			request.mockResolvedValue({ task: { id: "task-1" } as Task, summary: { count: 2, bytes: 400 * MB, freeableBytes: 200 * MB, failed: [] } });
			renderList({ sharedVideos: [video("v1", 200 * MB, 1), video("v2", 200 * MB, 2), video("v3", 300 * MB, 3), video("tiny", 1 * MB, 4), video("gone", 300 * MB, 0, 5)] });
			const button = screen.getByTestId("shared-media-delete-older");
			expect(button).toHaveTextContent("Delete older clips");
			await vi.waitFor(() => expect(button).toHaveTextContent("Free 200 MB · delete older clips"));
			expect(preview).toHaveBeenCalledWith({ projectId: "project-1", taskId: "task-1", mediaIds: ["v1", "v2"] });
			await userEvent.click(button);
			await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
			expect(request).toHaveBeenLastCalledWith({ projectId: "project-1", taskId: "task-1", mediaIds: ["v1", "v2"] });
			expect(confirmMock.confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true, title: "Delete 2 older clips?" }));
		});

		it("does not promise space when everything is shared with live originals", async () => {
			const preview = vi.mocked(api.request.previewSharedMediaDelete);
			preview.mockReset();
			confirmMock.confirm.mockClear();
			confirmMock.confirm.mockResolvedValueOnce(false);
			preview.mockResolvedValue({ count: 1, bytes: 200 * MB, freeableBytes: 0, failed: [] });
			renderList({ sharedVideos: [video("v1", 200 * MB, 1), video("v2", 200 * MB, 2)] });
			const button = screen.getByTestId("shared-media-delete-older");
			await vi.waitFor(() => expect(preview).toHaveBeenCalled());
			expect(button).toHaveTextContent(/^Delete older clips$/);
			await userEvent.click(button);
			await vi.waitFor(() => expect(confirmMock.confirm).toHaveBeenCalled());
			expect(confirmMock.confirm.mock.calls[0][0].message).toContain("frees almost no space");
		});

		it("opens one confirmation however fast the button is clicked", async () => {
			const preview = vi.mocked(api.request.previewSharedMediaDelete);
			preview.mockReset();
			preview.mockResolvedValue({ count: 1, bytes: 200 * MB, freeableBytes: 200 * MB, failed: [] });
			confirmMock.confirm.mockClear();
			let answer: (ok: boolean) => void = () => {};
			confirmMock.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
			renderList({ sharedVideos: [video("v1", 200 * MB, 1), video("v2", 200 * MB, 2)] });
			const button = screen.getByTestId("shared-media-delete-older");
			await userEvent.click(button);
			await userEvent.click(button);
			await vi.waitFor(() => expect(confirmMock.confirm).toHaveBeenCalledTimes(1));
			answer(false);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(confirmMock.confirm).toHaveBeenCalledTimes(1);
		});

		it("does not count removed clips in the Media heading", () => {
			renderList({ sharedVideos: [video("v1", 200 * MB, 1), video("gone", 300 * MB, 0, 5)] });
			expect(screen.getByTestId("shared-outputs-list")).toHaveTextContent(/Media\s*1/);
		});

		it("marks a removed clip's card instead of loading it", () => {
			renderList({ sharedVideos: [video("gone", 300 * MB, 1, 5)] });
			expect(screen.getByTestId("shared-media-removed-card")).toHaveTextContent("Removed");
		});
	});
});
