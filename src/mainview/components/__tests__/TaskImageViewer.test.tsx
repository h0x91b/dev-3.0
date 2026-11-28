import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskImageViewer from "../TaskImageViewer";
import { I18nProvider } from "../../i18n";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import type { SharedImage } from "../../../shared/types";
import type { ReviewComment } from "../../../shared/review";
import { FIRST_FRAME_TIME } from "../../utils/video-first-frame";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			readImageBase64: vi.fn(),
			getSharedMediaUrl: vi.fn(),
			openImageFile: vi.fn().mockResolvedValue(undefined),
			deleteSharedMedia: vi.fn(),
			previewSharedMediaDelete: vi.fn(),
			setSharedMediaPinned: vi.fn(),
			uploadImageBase64: vi.fn(),
		},
	},
}));

const frameStill = vi.hoisted(() => ({ captureFrameStill: vi.fn(async (_url: string, _time: number, _points: unknown[]) => "UE5H" as string | null) }));
vi.mock("../../utils/frame-still", () => frameStill);

const confirmMock = vi.hoisted(() => ({ confirm: vi.fn(async (_options: { title: string; message: string; danger?: boolean }) => true) }));
vi.mock("../../confirm", () => confirmMock);

const platform = vi.hoisted(() => ({ remote: false }));
vi.mock("../../utils/platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../utils/platform")>()),
	isRemote: () => platform.remote,
}));
const fileOpen = vi.hoisted(() => ({ openFileInBrowser: vi.fn(async (_path: string) => {}) }));
vi.mock("../../file-open-browser", () => fileOpen);

import { api } from "../../rpc";
const mockedApi = vi.mocked(api, true);

function img(id: string, name: string): SharedImage {
	return {
		id,
		storedPath: `/wt/shared-images/${id}.png`,
		originalPath: `/tmp/${name}`,
		name,
		mime: "image/png",
		bytes: 100,
		createdAt: 1,
	};
}

const IMAGES = [img("a", "one.png"), img("b", "two.png"), img("c", "three.png")];

function renderViewer(onClose = vi.fn(), initialIndex = IMAGES.length - 1) {
	render(
		<I18nProvider>
			<TaskImageViewer images={IMAGES} initialIndex={initialIndex} onClose={onClose} />
		</I18nProvider>,
	);
	return onClose;
}

afterEach(() => {
	platform.remote = false;
});

beforeEach(() => {
	(mockedApi.request.readImageBase64 as ReturnType<typeof vi.fn>).mockResolvedValue({
		dataUrl: "data:image/png;base64,AAAA",
	});
});

describe("TaskImageViewer", () => {
	it("opens the file on the host from the desktop, and in this browser from remote mode", async () => {
		platform.remote = false;
		renderViewer();
		await userEvent.click(await screen.findByRole("button", { name: "Open in default app" }));
		expect(mockedApi.request.openImageFile).toHaveBeenCalledWith({ path: "/wt/shared-images/c.png" });
		expect(fileOpen.openFileInBrowser).not.toHaveBeenCalled();
	});

	it("labels the remote open action for what it does and hands the file to the browser", async () => {
		platform.remote = true;
		vi.mocked(mockedApi.request.openImageFile).mockClear();
		renderViewer();
		await userEvent.click(await screen.findByRole("button", { name: "Open in new tab" }));
		expect(fileOpen.openFileInBrowser).toHaveBeenCalledWith("/wt/shared-images/c.png");
		expect(mockedApi.request.openImageFile).not.toHaveBeenCalled();
	});

	it("opens on the newest image (initialIndex) and shows the counter", async () => {
		renderViewer();
		expect(screen.getByText("3 / 3")).toBeInTheDocument();
		await waitFor(() => {
			expect(screen.getByTestId("viewer-main-image")).toHaveAttribute("alt", "three.png");
		});
	});

	it("navigates to the previous image with the prev button", async () => {
		renderViewer();
		await waitFor(() => expect(screen.getByTestId("viewer-main-image")).toHaveAttribute("alt", "three.png"));
		await userEvent.click(screen.getByRole("button", { name: /previous image/i }));
		expect(screen.getByText("2 / 3")).toBeInTheDocument();
		await waitFor(() => {
			expect(screen.getByTestId("viewer-main-image")).toHaveAttribute("alt", "two.png");
		});
	});

	it("jumps to an image when its thumbnail is clicked", async () => {
		renderViewer();
		// Thumbnail buttons carry the image name as their aria-label.
		await userEvent.click(screen.getByRole("button", { name: "one.png" }));
		expect(screen.getByText("1 / 3")).toBeInTheDocument();
	});

	it("eagerly loads every image, not just the active neighbour window", async () => {
		// Open on the last image → the first image ("a") sits outside [i-1, i, i+1].
		// It must still be fetched so its thumbnail renders a picture, not a placeholder.
		(mockedApi.request.readImageBase64 as ReturnType<typeof vi.fn>).mockClear();
		renderViewer(vi.fn(), 2);
		await waitFor(() => {
			expect(mockedApi.request.readImageBase64).toHaveBeenCalledWith({ path: "/wt/shared-images/a.png" });
			expect(mockedApi.request.readImageBase64).toHaveBeenCalledWith({ path: "/wt/shared-images/b.png" });
			expect(mockedApi.request.readImageBase64).toHaveBeenCalledWith({ path: "/wt/shared-images/c.png" });
		});
		// Each image is read at most once (priority + background loaders dedupe).
		const calls = (mockedApi.request.readImageBase64 as ReturnType<typeof vi.fn>).mock.calls.map(
			(c) => (c[0] as { path: string }).path,
		);
		expect(new Set(calls).size).toBe(calls.length);
	});

	it("renders a picture in every thumbnail once loaded", async () => {
		renderViewer(vi.fn(), 2);
		await waitFor(() => {
			for (const name of ["one.png", "two.png", "three.png"]) {
				expect(screen.getByRole("button", { name }).querySelector("img")).not.toBeNull();
			}
		});
	});

	it("closes on Escape", async () => {
		const onClose = renderViewer();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("closes when the close button is clicked", async () => {
		const onClose = renderViewer();
		await userEvent.click(screen.getByTestId("image-viewer-close"));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("shows an error placeholder when the image can't be read", async () => {
		(mockedApi.request.readImageBase64 as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		renderViewer();
		await waitFor(() => {
			expect(screen.getByText(/image unavailable/i)).toBeInTheDocument();
		});
	});

	it("toggles fullscreen and flips the button label", async () => {
		renderViewer();
		const btn = screen.getByTestId("image-viewer-fullscreen");
		expect(btn).toHaveAttribute("aria-label", "Fullscreen");
		await userEvent.click(btn);
		expect(screen.getByTestId("image-viewer-fullscreen")).toHaveAttribute("aria-label", "Exit fullscreen");
	});

	it("renders the agent's caption for the active image", async () => {
		const withCaption: SharedImage[] = [
			img("a", "one.png"),
			{ ...img("b", "two.png"), caption: "look at the header" },
		];
		render(
			<I18nProvider>
				<TaskImageViewer images={withCaption} initialIndex={1} onClose={vi.fn()} />
			</I18nProvider>,
		);
		expect(screen.getByTestId("viewer-caption")).toHaveTextContent("look at the header");
	});

	it("zooms the image in on ctrl-wheel (trackpad pinch) in fit mode", async () => {
		renderViewer();
		const image = await screen.findByTestId("viewer-main-image");
		expect(image.style.transform).toContain("scale(1)");
		const stage = image.parentElement as HTMLElement;
		stage.getBoundingClientRect = () =>
			({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
		const wheel = new Event("wheel", { bubbles: true, cancelable: true });
		Object.assign(wheel, { deltaY: -200, ctrlKey: true, clientX: 100, clientY: 50 });
		fireEvent(stage, wheel);
		await waitFor(() => {
			const scale = Number(image.style.transform.match(/scale\(([\d.]+)\)/)?.[1] ?? "1");
			expect(scale).toBeGreaterThan(1);
		});
	});

	it("marks <html> while open so the terminal is hidden behind it", async () => {
		const { unmount } = render(
			<I18nProvider>
				<TaskImageViewer images={IMAGES} initialIndex={0} onClose={vi.fn()} />
			</I18nProvider>,
		);
		expect(document.documentElement.getAttribute("data-image-viewer")).toBe("open");
		unmount();
		expect(document.documentElement.getAttribute("data-image-viewer")).toBeNull();
	});
	describe("download", () => {
		function spyDownload() {
			const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:img");
			const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
			const names: string[] = [];
			const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
				names.push(this.download);
			});
			return { names, click, restore: () => { createObjectURL.mockRestore(); revokeObjectURL.mockRestore(); click.mockRestore(); } };
		}

		it("saves the active image under its own name from the header button", async () => {
			const spy = spyDownload();
			renderViewer();
			await screen.findByTestId("viewer-main-image");
			await userEvent.click(screen.getByTestId("image-viewer-download"));
			expect(spy.names).toEqual(["three.png"]);
			spy.restore();
		});

		// The native WKWebView "Save Image As…" is dead here, so right-click must open
		// our own menu — otherwise there is no way to save from a pointer.
		it("offers Save/Copy from a right-click menu over the image", async () => {
			const spy = spyDownload();
			renderViewer();
			const image = await screen.findByTestId("viewer-main-image");
			expect(screen.queryByTestId("image-save-menu")).toBeNull();
			fireEvent.contextMenu(image);
			expect(screen.getByTestId("image-save-menu")).toBeInTheDocument();
			await userEvent.click(screen.getByTestId("image-save-menu-download"));
			expect(spy.names).toEqual(["three.png"]);
			expect(screen.queryByTestId("image-save-menu")).toBeNull();
			spy.restore();
		});

		it("closes the right-click menu on Escape without closing the viewer", async () => {
			const onClose = renderViewer();
			const image = await screen.findByTestId("viewer-main-image");
			fireEvent.contextMenu(image);
			fireEvent.keyDown(window, { key: "Escape" });
			expect(screen.queryByTestId("image-save-menu")).toBeNull();
			expect(onClose).not.toHaveBeenCalled();
		});

		it("disables the header download while the bytes are unavailable", async () => {
			(mockedApi.request.readImageBase64 as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("nope"));
			renderViewer();
			await waitFor(() => expect(screen.getByTestId("image-viewer-download")).toBeDisabled());
		});
	});

	// A batch of new images must be countable at a glance: the strip rings each
	// one and the header states how many there are. Opening the viewer already
	// marked them read server-side, so the ids are frozen by the caller.
	describe("new-image highlight", () => {
		function renderWithNew(newIds: string[], initialIndex = 0) {
			render(
				<I18nProvider>
					<TaskImageViewer images={IMAGES} initialIndex={initialIndex} onClose={vi.fn()} newIds={newIds} />
				</I18nProvider>,
			);
		}

		it("rings every new thumbnail and leaves the older ones alone", () => {
			renderWithNew(["b", "c"]);
			expect(screen.getByRole("button", { name: "one.png" })).not.toHaveAttribute("data-thumb-new");
			expect(screen.getByRole("button", { name: /two\.png/ })).toHaveAttribute("data-thumb-new", "true");
			expect(screen.getByRole("button", { name: /three\.png/ })).toHaveAttribute("data-thumb-new", "true");
		});

		it("keeps the ring on the active image too, so the count stays readable", () => {
			renderWithNew(["b", "c"], 2);
			const active = screen.getByRole("button", { name: /three\.png/ });
			expect(active).toHaveAttribute("aria-current", "true");
			expect(active).toHaveAttribute("data-thumb-new", "true");
			expect(active.className).toContain("ring-success");
		});

		it("states how many images are new, and says nothing when none are", () => {
			renderWithNew(["b", "c"]);
			expect(screen.getByTestId("image-viewer-new-count")).toHaveTextContent("2 new");
		});

		it("hides the new-count badge when nothing is new", () => {
			renderWithNew([]);
			expect(screen.queryByTestId("image-viewer-new-count")).toBeNull();
			expect(screen.getByRole("button", { name: "one.png" })).not.toHaveAttribute("data-thumb-new");
		});
	});

	it("wins Escape against the modal that opened it", async () => {
		const onCloseModal = vi.fn();
		const onCloseViewer = vi.fn();
		function ModalWithViewer() {
			// Registers its capture-phase Escape FIRST, exactly like the archived
			// task modal that hosts the shared-images list.
			useEscapeKey(onCloseModal);
			return <TaskImageViewer images={IMAGES} initialIndex={0} onClose={onCloseViewer} />;
		}
		render(<I18nProvider><ModalWithViewer /></I18nProvider>);
		fireEvent.keyDown(window, { key: "Escape" });
		expect(onCloseViewer).toHaveBeenCalled();
		expect(onCloseModal).not.toHaveBeenCalled();
	});
});

describe("TaskImageViewer comment mode", () => {
	const reviewApi = () => mockedApi.request as unknown as Record<string, ReturnType<typeof vi.fn>>;

	beforeEach(() => {
		for (const name of ["addReviewComment", "setReviewCommentStill", "updateReviewComment", "deleteReviewComment", "markReviewCommentsSent", "reopenReviewComment", "sendAgentMessageNow"]) {
			reviewApi()[name] = vi.fn().mockResolvedValue({ spilledPath: null });
		}
	});

	function renderCommentable(task?: { id: string; review?: unknown[] }) {
		render(
			<I18nProvider>
				<TaskImageViewer images={IMAGES} initialIndex={0} onClose={vi.fn()} taskId="t1" projectId="p1" task={task as never} />
			</I18nProvider>,
		);
	}

	/** happy-dom lays nothing out, so the picture box is stubbed to a 400×300 square at the origin. */
	function stubLayout() {
		const img = screen.getByTestId("viewer-main-image") as HTMLImageElement;
		Object.defineProperty(img, "naturalWidth", { value: 400, configurable: true });
		Object.defineProperty(img, "naturalHeight", { value: 300, configurable: true });
		img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
		const stage = img.parentElement as HTMLElement;
		stage.getBoundingClientRect = img.getBoundingClientRect;
		fireEvent.load(img);
	}

	it("hides the toggle without a project", async () => {
		renderViewer();
		await screen.findByTestId("viewer-main-image");
		expect(screen.queryByTestId("image-viewer-comment")).not.toBeInTheDocument();
	});

	it("drags a region, stores the comment with a normalised image anchor, and draws it", async () => {
		const user = userEvent.setup();
		renderCommentable({ id: "t1" });
		await screen.findByTestId("viewer-main-image");
		stubLayout();
		await user.click(screen.getByTestId("image-viewer-comment"));
		expect(screen.getByTestId("image-review")).toBeInTheDocument();

		const overlay = await screen.findByTestId("image-review-overlay");
		overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
		overlay.setPointerCapture = () => {};
		fireEvent.pointerDown(overlay, { button: 0, clientX: 100, clientY: 60, pointerId: 1 });
		fireEvent.pointerMove(overlay, { clientX: 300, clientY: 150, pointerId: 1 });
		fireEvent.pointerUp(overlay, { clientX: 300, clientY: 150, pointerId: 1 });

		const composer = await screen.findByTestId("image-review-composer");
		expect(composer).toHaveTextContent("one.png · x 25%–75%, y 20%–50%");
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "Toolbar overlaps here");
		await user.click(screen.getByRole("button", { name: "Add comment" }));

		expect(reviewApi().addReviewComment).toHaveBeenCalledWith(expect.objectContaining({
			taskId: "t1",
			projectId: "p1",
			comment: expect.objectContaining({
				body: "Toolbar overlaps here",
				anchor: { kind: "image-region", imageId: "a", name: "one.png", path: "/wt/shared-images/a.png", caption: null, x: 0.25, y: 0.2, w: 0.5, h: 0.3 },
			}),
		}));
		expect(screen.getByTestId("image-review-region")).toHaveStyle({ left: "25%", top: "20%", width: "50%", height: "30%" });
		expect(screen.getByTestId("image-review-thread")).toHaveTextContent("Toolbar overlaps here");
	});

	it("sends a region comment to the agent on the send shortcut", async () => {
		const user = userEvent.setup();
		renderCommentable({ id: "t1" });
		await screen.findByTestId("viewer-main-image");
		stubLayout();
		await user.click(screen.getByTestId("image-viewer-comment"));

		const overlay = await screen.findByTestId("image-review-overlay");
		overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
		overlay.setPointerCapture = () => {};
		fireEvent.pointerDown(overlay, { button: 0, clientX: 100, clientY: 60, pointerId: 1 });
		fireEvent.pointerMove(overlay, { clientX: 300, clientY: 150, pointerId: 1 });
		fireEvent.pointerUp(overlay, { clientX: 300, clientY: 150, pointerId: 1 });

		await screen.findByTestId("image-review-composer");
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "Toolbar overlaps here");
		// isMac() is false in the test environment, so the combo is Ctrl+Enter.
		await user.keyboard("{Control>}{Enter}{/Control}");

		await waitFor(() => expect(reviewApi().sendAgentMessageNow).toHaveBeenCalledTimes(1));
		const { text } = reviewApi().sendAgentMessageNow.mock.calls[0][0] as { text: string };
		expect(text).toContain("<comment>Toolbar overlaps here</comment>");
		await waitFor(() => expect(reviewApi().markReviewCommentsSent).toHaveBeenCalledTimes(1));
	});

	it("draws regions from the task record even with comment mode off, and a click without a drag becomes a small box", async () => {
		const user = userEvent.setup();
		renderCommentable({
			id: "t1",
			review: [{ id: "r1", body: "old", createdAt: "2026-09-16T00:00:00.000Z", resolvedAt: "2026-09-16T01:00:00.000Z", anchor: { kind: "image-region", imageId: "a", name: "one.png", path: "/wt/shared-images/a.png", caption: null, x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }],
		});
		await screen.findByTestId("viewer-main-image");
		stubLayout();
		await waitFor(() => expect(screen.getByTestId("image-review-region")).toHaveAttribute("data-resolved", "true"));

		await user.click(screen.getByTestId("image-viewer-comment"));
		const overlay = screen.getByTestId("image-review-overlay");
		overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
		overlay.setPointerCapture = () => {};
		fireEvent.pointerDown(overlay, { button: 0, clientX: 200, clientY: 150, pointerId: 1 });
		fireEvent.pointerUp(overlay, { clientX: 200, clientY: 150, pointerId: 1 });
		expect(await screen.findByTestId("image-review-composer")).toHaveTextContent("x 47%–53%, y 47%–53%");
	});
});

describe("TaskImageViewer with a shared video", () => {
	function vid(id: string, name: string): SharedImage {
		return { ...img(id, name), storedPath: `/wt/shared-images/${id}.mp4`, mime: "video/mp4" };
	}
	const MIXED = [img("a", "one.png"), vid("v", "demo.mp4"), img("c", "three.png")];
	let createObjectURL: ReturnType<typeof vi.spyOn>;
	let revokeObjectURL: ReturnType<typeof vi.spyOn>;

	const STREAM_URL = "http://127.0.0.1:4242/shared-media/tok";

	beforeEach(() => {
		(mockedApi.request.getSharedMediaUrl as ReturnType<typeof vi.fn>).mockReset();
		(mockedApi.request.getSharedMediaUrl as ReturnType<typeof vi.fn>).mockResolvedValue({ url: STREAM_URL, path: "/shared-media/tok" });
		(mockedApi.request.readImageBase64 as ReturnType<typeof vi.fn>).mockClear();
		(mockedApi.request.readImageBase64 as ReturnType<typeof vi.fn>).mockImplementation(async ({ path }: { path: string }) => ({
			dataUrl: path.endsWith(".mp4") ? "data:video/mp4;base64,AAAA" : "data:image/png;base64,AAAA",
		}));
		createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:clip");
		revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	});
	afterEach(() => {
		createObjectURL.mockRestore();
		revokeObjectURL.mockRestore();
	});

	function renderMixed(initialIndex: number, extra: Record<string, unknown> = {}) {
		return render(
			<I18nProvider>
				<TaskImageViewer images={MIXED} initialIndex={initialIndex} onClose={vi.fn()} {...extra} />
			</I18nProvider>,
		);
	}

	it("plays the clip in the same stage with its own transport and no autoplay", async () => {
		renderMixed(1, { taskId: "t1", projectId: "p1" });
		const video = (await screen.findByTestId("viewer-main-video")) as HTMLVideoElement;
		// Streamed by URL: no base64 read and no blob copy of the clip.
		expect(video).toHaveAttribute("src", STREAM_URL);
		expect(mockedApi.request.getSharedMediaUrl).toHaveBeenCalledWith({ path: "/wt/shared-images/v.mp4" });
		expect(mockedApi.request.readImageBase64).not.toHaveBeenCalledWith({ path: "/wt/shared-images/v.mp4" });
		expect(createObjectURL).not.toHaveBeenCalled();
		// The viewer's own transport replaces the native controls: only it can draw comment markers.
		expect(video.controls).toBe(false);
		expect(screen.getByTestId("video-review-bar")).toBeInTheDocument();
		expect(video.autoplay).toBe(false);
		expect(video).toHaveAttribute("preload", "metadata");
		expect(screen.queryByTestId("viewer-main-image")).toBeNull();
		// A video takes comments pinned to a moment instead of a region.
		expect(screen.getByTestId("image-viewer-comment")).toHaveAccessibleName("Comments on this video");
		expect(screen.getByRole("dialog", { name: "Shared media" })).toBeInTheDocument();
		expect(screen.getByText("2 / 3")).toBeInTheDocument();
	});

	it("deletes the clip's stored file from its right-click menu after a confirmation, then shows the tombstone", async () => {
		const deleteMock = mockedApi.request.deleteSharedMedia as ReturnType<typeof vi.fn>;
		const previewMock = mockedApi.request.previewSharedMediaDelete as ReturnType<typeof vi.fn>;
		deleteMock.mockReset();
		previewMock.mockReset();
		previewMock.mockResolvedValue({ count: 1, bytes: 300 * 1024 * 1024, freeableBytes: 0, failed: [], skipped: [] });
		deleteMock.mockResolvedValue({
			task: { id: "t1", sharedVideos: [{ ...MIXED[1], removedAt: 1_780_000_000_000, removedBytes: 0 }] },
			summary: { count: 1, bytes: 300 * 1024 * 1024, freeableBytes: 0, failed: [], skipped: [] },
		});
		confirmMock.confirm.mockClear();
		renderMixed(1, { taskId: "t1", projectId: "p1" });
		fireEvent.contextMenu(await screen.findByTestId("viewer-main-video"));
		await userEvent.click(screen.getByTestId("image-save-menu-delete"));

		await screen.findByTestId("viewer-media-removed");
		expect(screen.getByText("Removed to free space")).toBeInTheDocument();
		expect(confirmMock.confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true, title: "Delete the stored file of demo.mp4?" }));
		// The dialog states the honest gain: a clone of a live original frees ~0.
		expect(confirmMock.confirm.mock.calls[0][0].message).toContain("frees almost no space");
		expect(previewMock).toHaveBeenCalledWith({ projectId: "p1", taskId: "t1", mediaIds: ["v"], skipRefused: false });
		expect(deleteMock).toHaveBeenCalledTimes(1);
		expect(deleteMock).toHaveBeenCalledWith({ projectId: "p1", taskId: "t1", mediaIds: ["v"], skipRefused: false });
		expect(screen.queryByTestId("viewer-main-video")).toBeNull();
	});

	it("opens one confirmation for a per-clip delete clicked twice", async () => {
		(mockedApi.request.previewSharedMediaDelete as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1, bytes: 10, freeableBytes: 10, failed: [], skipped: [] });
		confirmMock.confirm.mockClear();
		let answer: (ok: boolean) => void = () => {};
		confirmMock.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
		renderMixed(1, { taskId: "t1", projectId: "p1" });
		for (let i = 0; i < 2; i++) {
			fireEvent.contextMenu(await screen.findByTestId("viewer-main-video"));
			await userEvent.click(screen.getByTestId("image-save-menu-delete"));
		}
		await waitFor(() => expect(confirmMock.confirm).toHaveBeenCalledTimes(1));
		answer(false);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(confirmMock.confirm).toHaveBeenCalledTimes(1);
	});

	it("deletes nothing when the confirmation is declined", async () => {
		const deleteMock = mockedApi.request.deleteSharedMedia as ReturnType<typeof vi.fn>;
		deleteMock.mockReset();
		(mockedApi.request.previewSharedMediaDelete as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1, bytes: 10, freeableBytes: 10, failed: [], skipped: [] });
		confirmMock.confirm.mockResolvedValueOnce(false);
		renderMixed(1, { taskId: "t1", projectId: "p1" });
		fireEvent.contextMenu(await screen.findByTestId("viewer-main-video"));
		await userEvent.click(screen.getByTestId("image-save-menu-delete"));
		await waitFor(() => expect(confirmMock.confirm).toHaveBeenCalled());
		expect(deleteMock).not.toHaveBeenCalled();
		expect(screen.getByTestId("viewer-main-video")).toBeInTheDocument();
	});

	it("shows a removed clip as a tombstone with no delete or download", async () => {
		const removed = [MIXED[0], { ...MIXED[1], removedAt: 1_780_000_000_000 }, MIXED[2]];
		render(
			<I18nProvider>
				<TaskImageViewer images={removed} initialIndex={1} onClose={vi.fn()} taskId="t1" projectId="p1" />
			</I18nProvider>,
		);
		expect(await screen.findByTestId("viewer-media-removed")).toHaveTextContent("Removed to free space");
		expect(screen.getByTestId("image-viewer-download")).toBeDisabled();
		expect(screen.getByTestId("image-viewer-copy-path")).toBeDisabled();
		expect(screen.getByTestId("image-viewer-open")).toBeDisabled();
		expect(screen.getAllByTestId("viewer-thumb-removed")).toHaveLength(1);
		fireEvent.contextMenu(screen.getByTestId("viewer-media-removed"));
		expect(screen.queryByTestId("image-save-menu-delete")).toBeNull();
	});

	it("offers the older-clips sweep in the menu of an open task's viewer and tombstones what it deleted", async () => {
		const MB = 1024 * 1024;
		const big = [vid("old", "old.mp4"), vid("mid", "mid.mp4"), vid("new", "new.mp4")].map((item, i) => ({ ...item, bytes: 20 * MB, createdAt: i + 1 }));
		const previewMock = mockedApi.request.previewSharedMediaDelete as ReturnType<typeof vi.fn>;
		const deleteMock = mockedApi.request.deleteSharedMedia as ReturnType<typeof vi.fn>;
		previewMock.mockReset();
		deleteMock.mockReset();
		confirmMock.confirm.mockClear();
		previewMock.mockResolvedValue({ count: 2, bytes: 40 * MB, freeableBytes: 20 * MB, failed: [], skipped: [] });
		deleteMock.mockResolvedValue({
			task: { id: "t1", sharedVideos: big.map((item) => (item.id === "new" ? item : { ...item, removedAt: 9 })) },
			summary: { count: 2, bytes: 40 * MB, freeableBytes: 20 * MB, failed: [], skipped: [] },
		});
		render(
			<I18nProvider>
				<TaskImageViewer images={big} initialIndex={2} onClose={vi.fn()} taskId="t1" projectId="p1" />
			</I18nProvider>,
		);
		await waitFor(() => expect(previewMock).toHaveBeenCalledWith({ projectId: "p1", taskId: "t1", mediaIds: ["old", "mid"], skipRefused: true }));
		fireEvent.contextMenu(await screen.findByTestId("viewer-main-video"));
		const sweep = await screen.findByTestId("image-save-menu-delete-older");
		expect(sweep).toHaveTextContent("Free 20 MB · delete older clips");
		await userEvent.click(sweep);
		await waitFor(() => expect(screen.getAllByTestId("viewer-thumb-removed")).toHaveLength(2));
		expect(deleteMock).toHaveBeenCalledWith({ projectId: "p1", taskId: "t1", mediaIds: ["old", "mid"], skipRefused: true });
		fireEvent.contextMenu(screen.getByTestId("viewer-main-video"));
		expect(screen.queryByTestId("image-save-menu-delete-older")).toBeNull();
	});

	it("shows the older-clips sweep as a rail button that confirms, deletes and then disappears", async () => {
		const MB = 1024 * 1024;
		const big = [vid("old", "old.mp4"), vid("mid", "mid.mp4"), vid("new", "new.mp4")].map((item, i) => ({ ...item, bytes: 20 * MB, createdAt: i + 1 }));
		const previewMock = mockedApi.request.previewSharedMediaDelete as ReturnType<typeof vi.fn>;
		const deleteMock = mockedApi.request.deleteSharedMedia as ReturnType<typeof vi.fn>;
		previewMock.mockReset();
		deleteMock.mockReset();
		confirmMock.confirm.mockClear();
		previewMock.mockResolvedValue({ count: 2, bytes: 40 * MB, freeableBytes: 20 * MB, failed: [], skipped: [] });
		deleteMock.mockResolvedValue({
			task: { id: "t1", sharedVideos: big.map((item) => (item.id === "new" ? item : { ...item, removedAt: 9 })) },
			summary: { count: 2, bytes: 40 * MB, freeableBytes: 20 * MB, failed: [], skipped: [] },
		});
		render(
			<I18nProvider>
				<TaskImageViewer images={big} initialIndex={2} onClose={vi.fn()} taskId="t1" projectId="p1" />
			</I18nProvider>,
		);
		const button = await screen.findByTestId("image-viewer-delete-older");
		await waitFor(() => expect(button).toHaveTextContent("Free 20 MB · delete older clips"));
		await userEvent.click(button);
		expect(confirmMock.confirm).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(screen.getAllByTestId("viewer-thumb-removed")).toHaveLength(2));
		expect(deleteMock).toHaveBeenCalledWith({ projectId: "p1", taskId: "t1", mediaIds: ["old", "mid"], skipRefused: true });
		expect(screen.queryByTestId("image-viewer-delete-older")).toBeNull();
	});

	it("shows no rail sweep when there are no older large clips", async () => {
		renderMixed(1, { taskId: "t1", projectId: "p1" });
		await screen.findByTestId("viewer-main-video");
		expect(screen.queryByTestId("image-viewer-delete-older")).toBeNull();
	});

	it("pins the clip from its right-click menu and shows it as kept, then unpins it", async () => {
		const pinMock = mockedApi.request.setSharedMediaPinned as ReturnType<typeof vi.fn>;
		pinMock.mockReset();
		pinMock.mockImplementation(async ({ pinned }: { pinned: boolean }) => ({
			id: "t1",
			sharedVideos: [{ ...MIXED[1], ...(pinned ? { pinnedAt: 1_780_000_000_000 } : {}) }],
		}));
		renderMixed(1, { taskId: "t1", projectId: "p1" });
		expect(screen.queryByTestId("image-viewer-kept")).toBeNull();
		fireEvent.contextMenu(await screen.findByTestId("viewer-main-video"));
		const pin = screen.getByTestId("image-save-menu-pin");
		expect(pin).toHaveAttribute("aria-checked", "false");
		expect(screen.queryByTestId("image-save-menu-pin-check")).toBeNull();
		await userEvent.click(pin);
		expect(pinMock).toHaveBeenCalledWith({ projectId: "p1", taskId: "t1", mediaId: "v", pinned: true });
		expect(await screen.findByTestId("image-viewer-kept")).toBeInTheDocument();

		fireEvent.contextMenu(screen.getByTestId("viewer-main-video"));
		expect(screen.getByTestId("image-save-menu-pin")).toHaveAttribute("aria-checked", "true");
		expect(screen.getByTestId("image-save-menu-pin-check")).toBeInTheDocument();
		await userEvent.click(screen.getByTestId("image-save-menu-pin"));
		expect(pinMock).toHaveBeenLastCalledWith({ projectId: "p1", taskId: "t1", mediaId: "v", pinned: false });
		await waitFor(() => expect(screen.queryByTestId("image-viewer-kept")).toBeNull());
	});

	it("offers no pin on a removed clip", async () => {
		const removed = [MIXED[0], { ...MIXED[1], removedAt: 1, pinnedAt: 1 }, MIXED[2]];
		render(
			<I18nProvider>
				<TaskImageViewer images={removed} initialIndex={1} onClose={vi.fn()} taskId="t1" projectId="p1" />
			</I18nProvider>,
		);
		fireEvent.contextMenu(await screen.findByTestId("viewer-media-removed"));
		expect(screen.queryByTestId("image-save-menu-pin")).toBeNull();
		expect(screen.queryByTestId("image-viewer-kept")).toBeNull();
	});

	it("offers no delete item without a task to delete it from", async () => {
		renderMixed(1);
		fireEvent.contextMenu(await screen.findByTestId("viewer-main-video"));
		expect(screen.getByTestId("image-save-menu")).toBeInTheDocument();
		expect(screen.queryByTestId("image-save-menu-delete")).toBeNull();
	});

	it("asks for a clip's stream URL only when it is on stage, never reading its bytes", async () => {
		renderMixed(2);
		await waitFor(() => {
			expect(mockedApi.request.readImageBase64).toHaveBeenCalledWith({ path: "/wt/shared-images/a.png" });
			expect(mockedApi.request.readImageBase64).toHaveBeenCalledWith({ path: "/wt/shared-images/c.png" });
		});
		expect(mockedApi.request.getSharedMediaUrl).not.toHaveBeenCalled();
		expect(screen.getByTestId("viewer-thumb-video")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "demo.mp4" }));
		await screen.findByTestId("viewer-main-video");
		expect(mockedApi.request.getSharedMediaUrl).toHaveBeenCalledWith({ path: "/wt/shared-images/v.mp4" });
		expect(mockedApi.request.readImageBase64).not.toHaveBeenCalledWith({ path: "/wt/shared-images/v.mp4" });
	});

	it("seeks a paused clip off zero on metadata so WebKit paints its first frame instead of black", async () => {
		renderMixed(1);
		const video = (await screen.findByTestId("viewer-main-video")) as HTMLVideoElement;
		let time = 0;
		Object.defineProperty(video, "videoWidth", { configurable: true, get: () => 1280 });
		Object.defineProperty(video, "currentTime", { configurable: true, get: () => time, set: (v: number) => { time = v; } });
		fireEvent.loadedMetadata(video);
		expect(video.currentTime).toBe(FIRST_FRAME_TIME);
	});

	it("switches back to a picture when stepping off the clip", async () => {
		renderMixed(1);
		await screen.findByTestId("viewer-main-video");
		await userEvent.click(screen.getByRole("button", { name: "Next image" }));
		await waitFor(() => expect(screen.getByTestId("viewer-main-image")).toHaveAttribute("alt", "three.png"));
		expect(screen.queryByTestId("viewer-main-video")).toBeNull();
	});

	it("leaves arrow keys to a focused player instead of changing the item", async () => {
		renderMixed(1);
		const video = await screen.findByTestId("viewer-main-video");
		fireEvent.keyDown(video, { key: "ArrowRight" });
		expect(screen.getByText("2 / 3")).toBeInTheDocument();
	});

	it("toggles play and pause with Space", async () => {
		renderMixed(1);
		const video = (await screen.findByTestId("viewer-main-video")) as HTMLVideoElement;
		const play = vi.spyOn(video, "play").mockResolvedValue(undefined);
		fireEvent.keyDown(window, { key: " " });
		expect(play).toHaveBeenCalledTimes(1);
	});

	it("shows the load error when the host refuses to stream the clip", async () => {
		(mockedApi.request.getSharedMediaUrl as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		renderMixed(1);
		expect(await screen.findByTestId("viewer-media-error")).toBeInTheDocument();
		expect(screen.queryByTestId("viewer-main-video")).toBeNull();
	});

	it("explains an undecodable clip instead of showing a blank player", async () => {
		renderMixed(1);
		const video = await screen.findByTestId("viewer-main-video");
		fireEvent.error(video);
		expect(await screen.findByTestId("viewer-media-error")).toHaveTextContent(/doesn't support its format or codec/);
	});

	it("fetches the clip only on Download, saves it under its own name and frees the blob", async () => {
		const names: string[] = [];
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
			names.push(this.download);
		});
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Blob([new Uint8Array(4)])));
		renderMixed(1);
		await screen.findByTestId("viewer-main-video");
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(screen.getByTestId("image-viewer-download")).toHaveAccessibleName("Download video");
		await userEvent.click(screen.getByTestId("image-viewer-download"));
		await waitFor(() => expect(names).toEqual(["demo.mp4"]));
		expect(fetchSpy).toHaveBeenCalledWith(STREAM_URL, { credentials: "same-origin" });
		await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:clip"));
		fetchSpy.mockRestore();
		click.mockRestore();
	});
});

describe("TaskImageViewer video review", () => {
	const reviewApi = () => mockedApi.request as unknown as Record<string, ReturnType<typeof vi.fn>>;
	const clip: SharedImage = { ...img("v", "demo.mp4"), storedPath: "/wt/shared-media/v.mp4", mime: "video/mp4" };
	const moment = (id: string, time: number, body: string, extra: Record<string, unknown> = {}) => ({
		id, body, createdAt: "2026-11-24T00:00:00.000Z",
		anchor: { kind: "video-time", imageId: "v", name: "demo.mp4", path: "/wt/shared-media/v.mp4", caption: null, time, frame: null, fps: null, excerpt: `demo.mp4 @ ${time}` },
		...extra,
	});

	beforeEach(() => {
		(mockedApi.request.getSharedMediaUrl as ReturnType<typeof vi.fn>).mockResolvedValue({ url: "http://127.0.0.1:4242/shared-media/tok", path: "/shared-media/tok" });
		for (const name of ["addReviewComment", "setReviewCommentStill", "updateReviewComment", "deleteReviewComment", "markReviewCommentsSent", "reopenReviewComment", "sendAgentMessageNow"]) {
			reviewApi()[name] = vi.fn().mockResolvedValue({ spilledPath: null });
		}
	});

	async function renderClip(review: unknown[] = [], media: SharedImage = clip) {
		render(
			<I18nProvider>
				<TaskImageViewer images={[media]} initialIndex={0} onClose={vi.fn()} taskId="t1" projectId="p1" task={{ id: "t1", review } as never} />
			</I18nProvider>,
		);
		const video = (await screen.findByTestId("viewer-main-video")) as HTMLVideoElement;
		// Let the frame-step hold, created in an effect for this element, reach the key handler.
		await act(async () => {});
		let time = 0;
		Object.defineProperty(video, "currentTime", { configurable: true, get: () => time, set: (v: number) => { time = v; } });
		Object.defineProperty(video, "duration", { configurable: true, get: () => 120 });
		const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
		return { video, pause, at: (v: number) => { time = v; } };
	}

	it("changes speed from the menu and the shortcuts", async () => {
		const { video } = await renderClip();
		await userEvent.selectOptions(screen.getByTestId("video-speed"), "0.5");
		expect(video.playbackRate).toBe(0.5);
		fireEvent.keyDown(window, { key: ">", code: "Period", shiftKey: true });
		expect(video.playbackRate).toBe(0.75);
		fireEvent.keyDown(window, { key: "<", code: "Comma", shiftKey: true });
		fireEvent.keyDown(window, { key: "<", code: "Comma", shiftKey: true });
		expect(video.playbackRate).toBe(0.25);
		fireEvent.keyDown(window, { key: "<", code: "Comma", shiftKey: true });
		expect(video.playbackRate).toBe(0.25);
	});

	it("steps one frame at a time, paused, with the buttons and , .", async () => {
		const { video, pause, at } = await renderClip();
		at(1);
		fireEvent.keyDown(window, { key: ".", code: "Period" });
		expect(pause).toHaveBeenCalled();
		// No measured frame rate in happy-dom, so the 30 fps fallback: frame 31's middle.
		expect(video.currentTime).toBeCloseTo(31.5 / 30);
		fireEvent.keyDown(window, { key: ",", code: "Comma" });
		fireEvent.keyDown(window, { key: ",", code: "Comma" });
		expect(video.currentTime).toBeCloseTo(29.5 / 30);
		await userEvent.click(screen.getByTestId("video-frame-forward"));
		expect(video.currentTime).toBeCloseTo(30.5 / 30);
		// Still the same item: , and . never fall through to the rail.
		expect(screen.getByText("1 / 1")).toBeInTheDocument();
	});

	it("pins a comment to the paused moment and stores it on the task review", async () => {
		const user = userEvent.setup();
		const { pause, at } = await renderClip();
		at(70.25);
		fireEvent.keyDown(window, { key: "c", code: "KeyC" });
		expect(pause).toHaveBeenCalled();
		const composer = await screen.findByTestId("video-review-composer");
		expect(composer).toHaveTextContent("demo.mp4 · 1:10.250");
		await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "Button flickers");
		await user.click(screen.getByRole("button", { name: "Add comment" }));
		expect(reviewApi().addReviewComment).toHaveBeenCalledWith(expect.objectContaining({
			taskId: "t1",
			projectId: "p1",
			comment: expect.objectContaining({
				body: "Button flickers",
				anchor: { kind: "video-time", imageId: "v", name: "demo.mp4", path: "/wt/shared-media/v.mp4", caption: null, time: 70.25, frame: null, fps: null, excerpt: "demo.mp4 @ 1:10.250" },
			}),
		}));
		expect(await screen.findByTestId("video-marker")).toHaveAccessibleName("Comment 1 at 1:10.250: Button flickers");
	});

	it("draws stored comments as markers in time order and seeks to one on click", async () => {
		const { video } = await renderClip([moment("m2", 90, "Late"), moment("m1", 12.5, "Early", { sentAt: "2026-11-24T01:00:00.000Z" })]);
		const markers = await screen.findAllByTestId("video-marker");
		expect(markers.map((m) => m.getAttribute("aria-label"))).toEqual(["Comment 1 at 0:12.500: Early", "Comment 2 at 1:30.000: Late"]);
		await userEvent.click(markers[1]);
		expect(video.currentTime).toBe(90);
		expect(markers[1]).toHaveAttribute("data-active", "true");
		expect(screen.getByTestId("video-review")).toBeInTheDocument();
	});

	it("sends every unsent moment to the agent as one message with timestamps", async () => {
		await renderClip([moment("m1", 12.5, "Early"), moment("m2", 90, "Late"), moment("m0", 1, "Done", { sentAt: "2026-11-24T01:00:00.000Z" })]);
		await userEvent.click(screen.getByTestId("image-viewer-comment"));
		await userEvent.click(screen.getByTestId("video-review-send-all"));
		await waitFor(() => expect(reviewApi().sendAgentMessageNow).toHaveBeenCalledTimes(1));
		const { taskId, text } = reviewApi().sendAgentMessageNow.mock.calls[0][0] as { taskId: string; text: string };
		expect(taskId).toBe("t1");
		expect(text).toContain('<video src="/wt/shared-media/v.mp4" time="0:12.500" seconds="12.5"/>');
		expect(text).toContain('<video src="/wt/shared-media/v.mp4" time="1:30.000" seconds="90"/>');
		expect(text).not.toContain("Done");
		await waitFor(() => expect(reviewApi().markReviewCommentsSent).toHaveBeenCalledWith(expect.objectContaining({ commentIds: ["m1", "m2"] })));
	});

	it("seeks with the arrows instead of leaving the clip and losing the position", async () => {
		const { video, at } = await renderClip();
		at(100);
		fireEvent.keyDown(window, { key: "ArrowRight" });
		expect(video.currentTime).toBe(105);
		fireEvent.keyDown(window, { key: "ArrowLeft" });
		fireEvent.keyDown(window, { key: "ArrowLeft" });
		expect(video.currentTime).toBe(95);
		expect(screen.getByTestId("viewer-main-video")).toBe(video);
	});

	it("keeps markers out of the slider so screen readers can reach them", async () => {
		await renderClip([moment("m1", 12.5, "Early")]);
		const marker = await screen.findByTestId("video-marker");
		expect(screen.getByTestId("video-scrubber").contains(marker)).toBe(false);
		expect(screen.getByRole("button", { name: "Comment 1 at 0:12.500: Early" })).toBe(marker);
	});

	function scrubberOf() {
		const scrubber = screen.getByTestId("video-scrubber");
		scrubber.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 28, right: 400, bottom: 28, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
		scrubber.setPointerCapture = () => {};
		return scrubber;
	}

	it("moves a paused picture with every drag step by precise seeks, never fastSeek's keyframe snap", async () => {
		const { video } = await renderClip();
		const fastSeek = vi.fn();
		Object.defineProperty(video, "fastSeek", { configurable: true, value: fastSeek });
		const scrubber = scrubberOf();
		expect(video.paused).toBe(true);
		fireEvent.pointerDown(scrubber, { clientX: 100, pointerId: 1 });
		expect(video.currentTime).toBe(30);
		fireEvent.pointerMove(scrubber, { clientX: 200, pointerId: 1 });
		expect(video.currentTime).toBe(60);
		fireEvent.pointerMove(scrubber, { clientX: 220, pointerId: 1 });
		expect(video.currentTime).toBe(66);
		fireEvent.pointerUp(scrubber, { clientX: 300, pointerId: 1 });
		expect(video.currentTime).toBe(90);
		expect(fastSeek).not.toHaveBeenCalled();
		fireEvent.keyDown(scrubber, { key: "PageDown" });
		expect(video.currentTime).toBe(30);
	});

	it("keeps one seek in flight while dragging and lands on the newest target", async () => {
		const { video } = await renderClip();
		let seeking = false;
		Object.defineProperty(video, "seeking", { configurable: true, get: () => seeking });
		const writes: number[] = [];
		let time = 0;
		Object.defineProperty(video, "currentTime", { configurable: true, get: () => time, set: (v: number) => { time = v; writes.push(v); seeking = true; } });
		const scrubber = scrubberOf();
		fireEvent.pointerDown(scrubber, { clientX: 40, pointerId: 1 });
		for (const x of [80, 120, 160, 200]) fireEvent.pointerMove(scrubber, { clientX: x, pointerId: 1 });
		expect(writes).toEqual([12]);
		seeking = false;
		fireEvent(video, new Event("seeked"));
		expect(writes).toEqual([12, 60]);
		fireEvent.pointerUp(scrubber, { clientX: 300, pointerId: 1 });
		seeking = false;
		fireEvent(video, new Event("seeked"));
		expect(writes).toEqual([12, 60, 90]);
		fireEvent(video, new Event("seeked"));
		expect(writes).toEqual([12, 60, 90]);
	});

	function seekingClip(video: HTMLVideoElement) {
		let seeking = false;
		let time = 0;
		const writes: number[] = [];
		Object.defineProperty(video, "seeking", { configurable: true, get: () => seeking });
		Object.defineProperty(video, "currentTime", { configurable: true, get: () => time, set: (v: number) => { time = v; writes.push(v); seeking = true; } });
		const land = () => { seeking = false; fireEvent(video, new Event("seeked")); };
		return { writes, land, started: () => fireEvent(video, new Event("seeking")) };
	}

	it("lets a jump right after release win over a drag target still waiting for its seek", async () => {
		const { video } = await renderClip();
		const clip = seekingClip(video);
		const scrubber = scrubberOf();
		fireEvent.pointerDown(scrubber, { clientX: 200, pointerId: 1 });
		clip.started();
		fireEvent.pointerUp(scrubber, { clientX: 40, pointerId: 1 });
		expect(clip.writes).toEqual([60]);
		// From where the drag let go (12 s), not from the seek still in flight (60 s).
		fireEvent.keyDown(window, { key: "l", code: "KeyL" });
		clip.started();
		expect(clip.writes).toEqual([60, 27]);
		clip.land();
		expect(clip.writes).toEqual([60, 27]);
		expect(video.currentTime).toBe(27);
	});

	it("keeps the thumb on the pointer while a seek is in flight, and on the release target until it is written", async () => {
		const { video } = await renderClip();
		const clip = seekingClip(video);
		const scrubber = scrubberOf();
		fireEvent.pointerDown(scrubber, { clientX: 40, pointerId: 1 });
		clip.started();
		fireEvent.pointerMove(scrubber, { clientX: 200, pointerId: 1 });
		expect(clip.writes).toEqual([12]);
		expect(scrubber).toHaveAttribute("aria-valuenow", "60");
		fireEvent.pointerUp(scrubber, { clientX: 300, pointerId: 1 });
		expect(scrubber).toHaveAttribute("aria-valuenow", "90");
		clip.land();
		clip.started();
		expect(clip.writes).toEqual([12, 90]);
		expect(scrubber).toHaveAttribute("aria-valuenow", "90");
	});

	it("clicks a marker right after release and stays on it", async () => {
		const { video } = await renderClip([moment("m1", 90, "Late")]);
		const clip = seekingClip(video);
		const scrubber = scrubberOf();
		fireEvent.pointerDown(scrubber, { clientX: 200, pointerId: 1 });
		clip.started();
		fireEvent.pointerUp(scrubber, { clientX: 40, pointerId: 1 });
		fireEvent.click(await screen.findByTestId("video-marker"));
		clip.started();
		clip.land();
		expect(clip.writes).toEqual([60, 90]);
	});

	it("types J and L into the comment composer instead of seeking", async () => {
		const user = userEvent.setup();
		const { video, at } = await renderClip();
		at(50);
		fireEvent.keyDown(window, { key: "c", code: "KeyC" });
		const box = await screen.findByPlaceholderText("Leave a comment on this line...");
		await user.type(box, "jjll");
		expect(box).toHaveValue("jjll");
		expect(video.currentTime).toBe(50);
	});

	it("jumps 15 seconds with the buttons and J / L, clamped to the clip, paused or playing", async () => {
		const { video, at } = await renderClip();
		at(50);
		await userEvent.click(screen.getByTestId("video-jump-forward"));
		expect(video.currentTime).toBe(65);
		await userEvent.click(screen.getByTestId("video-jump-back"));
		await userEvent.click(screen.getByTestId("video-jump-back"));
		expect(video.currentTime).toBe(35);
		at(7);
		fireEvent.keyDown(window, { key: "j", code: "KeyJ" });
		expect(video.currentTime).toBe(0);
		Object.defineProperty(video, "paused", { configurable: true, get: () => false });
		at(110);
		fireEvent.keyDown(window, { key: "l", code: "KeyL" });
		expect(video.currentTime).toBe(120);
		expect(video.paused).toBe(false);
		expect(screen.getByTestId("video-jump-back")).toHaveAccessibleName("Back 15 seconds");
		expect(screen.getByTestId("video-jump-forward")).toHaveAttribute("title", expect.stringContaining("Forward 15 seconds"));
	});

	describe("hold-to-repeat frame step", () => {
		afterEach(() => { vi.useRealTimers(); });

		it("steps once on press, repeats at half the frame rate after half a second, and stops on release", async () => {
			const { video, at } = await renderClip();
			at(1);
			vi.useFakeTimers();
			const button = screen.getByTestId("video-frame-forward");
			fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
			expect(video.currentTime).toBeCloseTo(31.5 / 30);
			vi.advanceTimersByTime(499);
			expect(video.currentTime).toBeCloseTo(31.5 / 30);
			vi.advanceTimersByTime(1);
			expect(video.currentTime).toBeCloseTo(32.5 / 30);
			// 30 fps fallback → 15 steps a second: 7 more by the one-second mark.
			vi.advanceTimersByTime(500);
			expect(video.currentTime).toBeCloseTo(39.5 / 30);
			fireEvent.pointerUp(button, { pointerId: 1 });
			vi.advanceTimersByTime(2000);
			expect(video.currentTime).toBeCloseTo(39.5 / 30);
		});

		it("lets go on pointer leave, pointer cancel and window blur, and a quick click is one step", async () => {
			const { video, at } = await renderClip();
			at(10);
			vi.useFakeTimers();
			const back = screen.getByTestId("video-frame-back");
			for (const letGo of [() => fireEvent.pointerLeave(back), () => fireEvent.pointerCancel(back), () => fireEvent.blur(window)]) {
				const before = video.currentTime;
				fireEvent.pointerDown(back, { button: 0, pointerId: 1 });
				vi.advanceTimersByTime(600);
				const held = video.currentTime;
				expect(held).toBeLessThan(before);
				letGo();
				vi.advanceTimersByTime(1000);
				expect(video.currentTime).toBe(held);
			}
			at(1);
			fireEvent.pointerDown(back, { button: 0, pointerId: 1 });
			fireEvent.pointerUp(back, { pointerId: 1 });
			fireEvent.click(back, { detail: 1 });
			vi.advanceTimersByTime(1000);
			expect(video.currentTime).toBeCloseTo(29.5 / 30);
			// Enter on the focused button: no pointer, one step.
			fireEvent.click(back, { detail: 0 });
			expect(video.currentTime).toBeCloseTo(28.5 / 30);
		});

		it("repeats a held , or . at its own rate, ignoring OS key repeat, until key up", async () => {
			const { video, at } = await renderClip();
			at(1);
			vi.useFakeTimers();
			fireEvent.keyDown(window, { key: ".", code: "Period" });
			for (let i = 0; i < 10; i++) fireEvent.keyDown(window, { key: ".", code: "Period", repeat: true });
			expect(video.currentTime).toBeCloseTo(31.5 / 30);
			vi.advanceTimersByTime(500);
			expect(video.currentTime).toBeCloseTo(32.5 / 30);
			fireEvent.keyUp(window, { key: "c", code: "KeyC" });
			vi.advanceTimersByTime(200);
			expect(video.currentTime).toBeCloseTo(35.5 / 30);
			fireEvent.keyUp(window, { key: ".", code: "Period" });
			vi.advanceTimersByTime(1000);
			expect(video.currentTime).toBeCloseTo(35.5 / 30);
		});

		it("clamps at the first and the last frame and stops repeating there", async () => {
			const { video, at } = await renderClip();
			const writes: number[] = [];
			let time = 0.01;
			Object.defineProperty(video, "currentTime", { configurable: true, get: () => time, set: (v: number) => { time = v; writes.push(v); } });
			vi.useFakeTimers();
			fireEvent.pointerDown(screen.getByTestId("video-frame-back"), { button: 0, pointerId: 1 });
			vi.advanceTimersByTime(2000);
			expect(writes).toEqual([]);
			fireEvent.pointerUp(screen.getByTestId("video-frame-back"), { pointerId: 1 });
			time = 119.9;
			fireEvent.pointerDown(screen.getByTestId("video-frame-forward"), { button: 0, pointerId: 1 });
			vi.advanceTimersByTime(5000);
			// 120 s at 30 fps: frame 3597 → 3598 → 3599, the last one, and no further.
			expect(writes).toHaveLength(2);
			expect(writes[1]).toBeCloseTo(3599.5 / 30);
			void at;
		});

		it("skips ahead instead of queueing when a seek is slower than the step", async () => {
			const { video } = await renderClip();
			let seeking = false;
			let time = 1;
			const writes: number[] = [];
			Object.defineProperty(video, "seeking", { configurable: true, get: () => seeking });
			Object.defineProperty(video, "currentTime", { configurable: true, get: () => time, set: (v: number) => { time = v; writes.push(v); seeking = true; } });
			vi.useFakeTimers();
			const button = screen.getByTestId("video-frame-forward");
			fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
			vi.advanceTimersByTime(500 + 3 * (1000 / 15));
			expect(writes).toHaveLength(1);
			seeking = false;
			fireEvent(video, new Event("seeked"));
			// The newest target, four frames on — never the three in between.
			expect(writes).toHaveLength(2);
			expect(writes[1]).toBeCloseTo(35.5 / 30);
			fireEvent.pointerUp(button, { pointerId: 1 });
		});

		it("follows the measured frame rate: a 60 fps clip repeats 30 times a second", async () => {
			const { rememberFrameRate } = await import("../../utils/video-playback");
			// Its own clip id: a remembered rate lives for the session.
			rememberFrameRate("v60", 60);
			const { video, at } = await renderClip([], { ...clip, id: "v60" });
			at(1);
			vi.useFakeTimers();
			fireEvent.pointerDown(screen.getByTestId("video-frame-forward"), { button: 0, pointerId: 1 });
			expect(video.currentTime).toBeCloseTo(61.5 / 60);
			vi.advanceTimersByTime(1000);
			// One at 500 ms, then one every 33.3 ms: 16 by the one-second mark.
			expect(video.currentTime).toBeCloseTo((61 + 16 + 0.5) / 60);
			fireEvent.pointerUp(screen.getByTestId("video-frame-forward"), { pointerId: 1 });
		});
	});

	it("lays the transport out around Play and goes to the start and the end", async () => {
		const { video, at } = await renderClip();
		const transport = screen.getByTestId("video-transport");
		expect(Array.from(transport.querySelectorAll("button")).map((b) => b.dataset.testid)).toEqual([
			"video-to-start", "video-jump-back", "video-frames-back", "video-frame-back", "video-play",
			"video-frame-forward", "video-frames-forward", "video-jump-forward", "video-to-end",
		]);
		at(60);
		await userEvent.click(screen.getByTestId("video-frames-forward"));
		expect(video.currentTime).toBeCloseTo(1805.5 / 30);
		await userEvent.click(screen.getByTestId("video-frames-back"));
		await userEvent.click(screen.getByTestId("video-frames-back"));
		expect(video.currentTime).toBeCloseTo(1795.5 / 30);
		await userEvent.click(screen.getByTestId("video-to-end"));
		expect(video.currentTime).toBe(120);
		fireEvent.keyDown(window, { key: "Home", code: "Home" });
		expect(video.currentTime).toBe(0);
		fireEvent.keyDown(window, { key: "End", code: "End" });
		expect(video.currentTime).toBe(120);
		expect(screen.getByText("1 / 1")).toBeInTheDocument();
	});

	describe("numbered spots on a paused frame", () => {
		function stageVideo(video: HTMLVideoElement) {
			Object.defineProperty(video, "videoWidth", { configurable: true, get: () => 1920 });
			Object.defineProperty(video, "videoHeight", { configurable: true, get: () => 1080 });
			video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 450, right: 800, bottom: 450, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
			fireEvent(video, new Event("loadedmetadata"));
			fireEvent(video, new Event("seeked"));
		}
		function spotsLayer() {
			const layer = screen.getByTestId("video-spots");
			layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 450, right: 800, bottom: 450, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
			return layer;
		}
		const spotNumbers = () => screen.queryAllByTestId("video-spot").map((el) => Number(el.dataset.spot));

		beforeEach(() => {
			(mockedApi.request.uploadImageBase64 as ReturnType<typeof vi.fn>).mockResolvedValue({ path: "/up/demo-70250ms-spots.png" });
			frameStill.captureFrameStill.mockClear();
		});

		it("marks spots 1-3 with M, keeps numbers when one is removed, and refills the lowest free number", async () => {
			const { at } = await renderClip();
			at(70.25);
			stageVideo(screen.getByTestId("viewer-main-video") as HTMLVideoElement);
			fireEvent.keyDown(window, { key: "m", code: "KeyM" });
			expect(screen.getByTestId("video-mark-spots")).toHaveAttribute("aria-pressed", "true");
			expect(await screen.findByTestId("video-review-composer")).toBeInTheDocument();
			const layer = spotsLayer();
			fireEvent.pointerDown(layer, { button: 0, clientX: 200, clientY: 90 });
			fireEvent.pointerDown(layer, { button: 0, clientX: 400, clientY: 225 });
			fireEvent.pointerDown(layer, { button: 0, clientX: 720, clientY: 405 });
			expect(spotNumbers()).toEqual([1, 2, 3]);
			expect(screen.getByTestId("video-review-composer")).toHaveTextContent("3 spots");
			// Clicks landing in one batch still get numbers of their own.
			act(() => {
				for (const x of [10, 20]) layer.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: x, clientY: 10 }));
			});
			expect(spotNumbers()).toEqual([1, 2, 3, 4, 5]);
			fireEvent.keyDown(screen.getByRole("button", { name: "Spot 5" }), { key: "Delete" });
			fireEvent.keyDown(screen.getByRole("button", { name: "Spot 4" }), { key: "Backspace" });
			await userEvent.click(screen.getByRole("button", { name: "Spot 2" }));
			await userEvent.click(screen.getByRole("button", { name: "Remove spot 2" }));
			expect(spotNumbers()).toEqual([1, 3]);
			fireEvent.pointerDown(spotsLayer(), { button: 0, clientX: 100, clientY: 100 });
			expect(spotNumbers()).toEqual([1, 3, 2]);
			await userEvent.click(screen.getByRole("button", { name: "Spot 3" }));
			fireEvent.keyDown(screen.getByRole("button", { name: "Spot 3" }), { key: "Delete" });
			expect(spotNumbers()).toEqual([1, 2]);
		});

		it("stores the comment at once with its spots, patches the still in after, and sends both to the agent", async () => {
			let resolveStill: (value: string | null) => void = () => {};
			frameStill.captureFrameStill.mockImplementationOnce(() => new Promise((resolve) => { resolveStill = resolve; }));
			const user = userEvent.setup();
			const { at } = await renderClip();
			at(70.25);
			stageVideo(screen.getByTestId("viewer-main-video") as HTMLVideoElement);
			await user.click(screen.getByTestId("video-mark-spots"));
			const layer = spotsLayer();
			fireEvent.pointerDown(layer, { button: 0, clientX: 200, clientY: 90 });
			fireEvent.pointerDown(layer, { button: 0, clientX: 400, clientY: 225 });
			fireEvent.pointerDown(layer, { button: 0, clientX: 720, clientY: 405 });
			await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "#1 is cut off");
			await user.click(screen.getByRole("button", { name: "Add comment" }));
			const points = [{ n: 1, x: 0.25, y: 0.2 }, { n: 2, x: 0.5, y: 0.5 }, { n: 3, x: 0.9, y: 0.9 }];
			// Stored and drawn before the still exists.
			await waitFor(() => expect(reviewApi().addReviewComment).toHaveBeenCalled());
			const { comment } = reviewApi().addReviewComment.mock.calls[0][0] as { comment: ReviewComment };
			expect(comment.anchor).toEqual(expect.objectContaining({ kind: "video-time", time: 70.25, points }));
			expect(comment.anchor).not.toHaveProperty("still");
			expect(await screen.findByTestId("video-marker")).toBeInTheDocument();
			expect(reviewApi().setReviewCommentStill).not.toHaveBeenCalled();
			expect(frameStill.captureFrameStill).toHaveBeenCalledWith("http://127.0.0.1:4242/shared-media/tok", 70.25, points);
			// Until the still lands nothing can send the comment without it.
			expect(screen.getByTestId("video-stage-status")).toHaveTextContent("Saving the frame with its spots…");
			const sendAll = screen.getByTestId("video-review-send-all");
			expect(sendAll).toBeDisabled();
			expect(sendAll).toHaveTextContent("Saving the frame with its spots…");
			fireEvent.click(sendAll);
			expect(reviewApi().sendAgentMessageNow).not.toHaveBeenCalled();
			resolveStill("UE5H");
			await waitFor(() => expect(reviewApi().setReviewCommentStill).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1", commentId: comment.id, still: "/up/demo-70250ms-spots.png" }));
			expect(mockedApi.request.uploadImageBase64).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", base64: "UE5H", mimeType: "image/png" }));
			expect(screen.getByTestId("video-mark-spots")).toHaveAttribute("aria-pressed", "false");
			expect(screen.queryAllByTestId("video-spot")).toHaveLength(0);
			await waitFor(() => expect(screen.getByTestId("video-review-send-all")).toBeEnabled());
			expect(screen.queryByTestId("video-stage-status")).toBeNull();

			await user.click(screen.getByTestId("video-review-send-all"));
			await waitFor(() => expect(reviewApi().sendAgentMessageNow).toHaveBeenCalledTimes(1));
			const { text } = reviewApi().sendAgentMessageNow.mock.calls[0][0] as { text: string };
			expect(text).toContain('<video src="/wt/shared-media/v.mp4" time="1:10.250" seconds="70.25" still="/up/demo-70250ms-spots.png">');
			expect(text).toContain('<point n="1" x="25%" y="20%"/>\n<point n="2" x="50%" y="50%"/>\n<point n="3" x="90%" y="90%"/>');
			expect(text).toContain("<comment>#1 is cut off</comment>");
		});

		it("keeps the draft on its frame: the tool off that frame seeks back instead of moving the spots", async () => {
			const { video, at } = await renderClip();
			at(70.25);
			stageVideo(video);
			fireEvent.keyDown(window, { key: "m", code: "KeyM" });
			fireEvent.pointerDown(spotsLayer(), { button: 0, clientX: 200, clientY: 90 });
			expect(spotNumbers()).toEqual([1]);
			at(80);
			fireEvent(video, new Event("seeked"));
			// Off the draft's frame its spots are not drawn over the wrong picture.
			expect(spotNumbers()).toEqual([]);
			fireEvent.pointerDown(spotsLayer(), { button: 0, clientX: 400, clientY: 225 });
			expect(video.currentTime).toBe(70.25);
			// Said inside the viewer: the app's toasts render under the lightbox.
			expect(screen.getByTestId("video-stage-status")).toHaveTextContent("Spots go on the comment's frame, 1:10.250: back there now.");
			fireEvent(video, new Event("seeked"));
			expect(spotNumbers()).toEqual([1]);
			expect(screen.getByTestId("video-review-composer")).toHaveTextContent("1:10.250 · 1 spot");
			// Toggling the tool off and on away from the frame also goes back first.
			fireEvent.keyDown(window, { key: "m", code: "KeyM" });
			at(90);
			fireEvent.keyDown(window, { key: "m", code: "KeyM" });
			expect(video.currentTime).toBe(70.25);
		});

		it("waits for the still before Send now hands the comment to the agent, and says so", async () => {
			let resolveStill: (value: string | null) => void = () => {};
			frameStill.captureFrameStill.mockImplementationOnce(() => new Promise((resolve) => { resolveStill = resolve; }));
			const user = userEvent.setup();
			const { at } = await renderClip();
			at(5);
			stageVideo(screen.getByTestId("viewer-main-video") as HTMLVideoElement);
			fireEvent.keyDown(window, { key: "m", code: "KeyM" });
			fireEvent.pointerDown(spotsLayer(), { button: 0, clientX: 400, clientY: 225 });
			await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "here");
			await user.click(screen.getByRole("button", { name: "Send now" }));
			expect(await screen.findByTestId("video-stage-status")).toHaveTextContent("Saving the frame with its spots…");
			expect(reviewApi().sendAgentMessageNow).not.toHaveBeenCalled();
			resolveStill("UE5H");
			await waitFor(() => expect(reviewApi().sendAgentMessageNow).toHaveBeenCalledTimes(1));
			expect(reviewApi().setReviewCommentStill).toHaveBeenCalled();
			expect((reviewApi().sendAgentMessageNow.mock.calls[0][0] as { text: string }).text).toContain('still="/up/demo-70250ms-spots.png"');
		});

		it("still stores the comment and its spots when no still can be made", async () => {
			frameStill.captureFrameStill.mockResolvedValueOnce(null);
			const user = userEvent.setup();
			const { at } = await renderClip();
			at(5);
			stageVideo(screen.getByTestId("viewer-main-video") as HTMLVideoElement);
			fireEvent.keyDown(window, { key: "m", code: "KeyM" });
			fireEvent.pointerDown(spotsLayer(), { button: 0, clientX: 400, clientY: 225 });
			await user.type(screen.getByPlaceholderText("Leave a comment on this line..."), "here");
			await user.click(screen.getByRole("button", { name: "Add comment" }));
			await waitFor(() => expect(reviewApi().addReviewComment).toHaveBeenCalled());
			const { comment } = reviewApi().addReviewComment.mock.calls[0][0] as { comment: ReviewComment };
			expect(comment.anchor).toEqual(expect.objectContaining({ points: [{ n: 1, x: 0.5, y: 0.5 }] }));
			expect(comment.anchor).not.toHaveProperty("still");
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(reviewApi().setReviewCommentStill).not.toHaveBeenCalled();
		});

		it("shows a stored comment's spots when its moment is paused on, and hides them while playing", async () => {
			const stored = moment("m1", 12.5, "#1 flickers", { anchor: { ...moment("m1", 12.5, "").anchor, points: [{ n: 1, x: 0.5, y: 0.5 }, { n: 2, x: 0.1, y: 0.1 }] } });
			const { video, at } = await renderClip([stored]);
			at(30);
			stageVideo(video);
			expect(screen.queryByTestId("video-spots")).toBeNull();
			await userEvent.click(await screen.findByTestId("video-marker"));
			fireEvent(video, new Event("seeked"));
			expect(screen.getAllByTestId("video-spot-saved")).toHaveLength(2);
			Object.defineProperty(video, "paused", { configurable: true, get: () => false });
			fireEvent(video, new Event("play"));
			expect(screen.queryByTestId("video-spots")).toBeNull();
		});

		it("keeps M for the composer text instead of toggling the tool", async () => {
			const user = userEvent.setup();
			await renderClip();
			fireEvent.keyDown(window, { key: "c", code: "KeyC" });
			const box = await screen.findByPlaceholderText("Leave a comment on this line...");
			await user.type(box, "mm");
			expect(box).toHaveValue("mm");
			expect(screen.getByTestId("video-mark-spots")).toHaveAttribute("aria-pressed", "false");
		});
	});

	it("offers no comment action without a project to store it in", async () => {
		render(
			<I18nProvider>
				<TaskImageViewer images={[clip]} initialIndex={0} onClose={vi.fn()} />
			</I18nProvider>,
		);
		await screen.findByTestId("video-review-bar");
		expect(screen.queryByTestId("video-comment")).toBeNull();
		fireEvent.keyDown(window, { key: "c", code: "KeyC" });
		expect(screen.queryByTestId("video-review")).toBeNull();
	});
});

describe("TaskImageViewer with a shared audio track", () => {
	const STREAM_URL = "http://127.0.0.1:4242/shared-media/track";
	function track(id: string, name: string, caption?: string): SharedImage {
		return { ...img(id, name), storedPath: `/wt/shared-images/${id}.mp3`, mime: "audio/mpeg", ...(caption ? { caption } : {}) };
	}
	const LIST = [img("a", "one.png"), track("t", "voice.mp3", "listen at 0:02")];

	beforeEach(() => {
		(mockedApi.request.getSharedMediaUrl as ReturnType<typeof vi.fn>).mockReset();
		(mockedApi.request.getSharedMediaUrl as ReturnType<typeof vi.fn>).mockResolvedValue({ url: STREAM_URL, path: "/shared-media/track" });
		(mockedApi.request.readImageBase64 as ReturnType<typeof vi.fn>).mockClear();
		(mockedApi.request.readImageBase64 as ReturnType<typeof vi.fn>).mockResolvedValue({ dataUrl: "data:image/png;base64,AAAA" });
	});

	function renderList(initialIndex: number) {
		return render(
			<I18nProvider>
				<TaskImageViewer images={LIST} initialIndex={initialIndex} onClose={vi.fn()} taskId="t1" projectId="p1" />
			</I18nProvider>,
		);
	}

	it("plays the track in an audio player with controls, no autoplay, and its caption", async () => {
		renderList(1);
		const audio = (await screen.findByTestId("viewer-main-audio")) as HTMLAudioElement;
		expect(audio.tagName).toBe("AUDIO");
		expect(audio).toHaveAttribute("src", STREAM_URL);
		expect(audio.controls).toBe(true);
		expect(audio.autoplay).toBe(false);
		expect(audio).toHaveAttribute("preload", "metadata");
		expect(audio).toHaveAttribute("aria-label", "voice.mp3");
		expect(mockedApi.request.getSharedMediaUrl).toHaveBeenCalledWith({ path: "/wt/shared-images/t.mp3" });
		expect(mockedApi.request.readImageBase64).not.toHaveBeenCalledWith({ path: "/wt/shared-images/t.mp3" });
		expect(screen.queryByTestId("viewer-main-video")).toBeNull();
		expect(screen.queryByTestId("image-viewer-comment")).toBeNull();
		expect(screen.getByTestId("viewer-caption")).toHaveTextContent("listen at 0:02");
		expect(screen.getByRole("dialog", { name: "Shared media" })).toBeInTheDocument();
		expect(screen.getByTestId("image-viewer-download")).toHaveAccessibleName("Download audio");
	});

	it("marks the track's thumbnail as audio and streams it only once on stage", async () => {
		renderList(0);
		await waitFor(() => expect(mockedApi.request.readImageBase64).toHaveBeenCalledWith({ path: "/wt/shared-images/a.png" }));
		expect(screen.getByTestId("viewer-thumb-audio")).toHaveAttribute("title", "Audio");
		expect(mockedApi.request.getSharedMediaUrl).not.toHaveBeenCalled();
	});

	it("toggles play and pause with Space", async () => {
		renderList(1);
		const audio = (await screen.findByTestId("viewer-main-audio")) as HTMLAudioElement;
		const play = vi.spyOn(audio, "play").mockResolvedValue(undefined);
		fireEvent.keyDown(window, { key: " " });
		expect(play).toHaveBeenCalledTimes(1);
	});

	it("explains an undecodable track in audio terms", async () => {
		renderList(1);
		fireEvent.error(await screen.findByTestId("viewer-main-audio"));
		expect(await screen.findByTestId("viewer-media-error")).toHaveTextContent("This audio can't play here");
	});

	it("says the audio is unavailable when the host refuses to stream it", async () => {
		(mockedApi.request.getSharedMediaUrl as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		renderList(1);
		expect(await screen.findByTestId("viewer-media-error")).toHaveTextContent("Audio unavailable");
	});
});
