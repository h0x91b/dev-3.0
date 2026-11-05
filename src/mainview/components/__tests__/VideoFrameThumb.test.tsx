import { act, render, screen, waitFor } from "@testing-library/react";
import VideoFrameThumb from "../VideoFrameThumb";
import { FIRST_FRAME_TIME } from "../../utils/video-first-frame";
import { installImmediateIntersectionObserver } from "../../test-utils/immediate-intersection";

vi.mock("../../rpc", () => ({ api: { request: { getSharedMediaUrl: vi.fn() } } }));
import { api } from "../../rpc";
const getUrl = vi.mocked(api.request.getSharedMediaUrl);

const created: HTMLVideoElement[] = [];
const realCreate = document.createElement.bind(document);
let drawImage: ReturnType<typeof vi.fn>;

beforeEach(() => {
	created.length = 0;
	getUrl.mockReset().mockImplementation(async ({ path }) => ({ url: `http://127.0.0.1/shared-media/${path}`, path }));
	drawImage = vi.fn();
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
	vi.spyOn(document, "createElement").mockImplementation(((tag: string, options?: ElementCreationOptions) => {
		const el = realCreate(tag, options);
		if (tag === "video") {
			const video = el as HTMLVideoElement;
			let time = 0;
			Object.defineProperty(video, "videoWidth", { configurable: true, get: () => 720 });
			Object.defineProperty(video, "videoHeight", { configurable: true, get: () => 1280 });
			Object.defineProperty(video, "currentTime", { configurable: true, get: () => time, set: (v: number) => { time = v; } });
			vi.spyOn(video, "load").mockImplementation(() => {});
			vi.spyOn(video, "pause").mockImplementation(() => {});
			created.push(video);
		}
		return el;
	}) as typeof document.createElement);
});

afterEach(() => vi.restoreAllMocks());

const fallback = <span data-testid="glyph">▶</span>;

describe("VideoFrameThumb", () => {
	it("streams nothing while the tile is off screen", async () => {
		render(<VideoFrameThumb path="/wt/v.mp4" fallback={fallback} />);
		await act(async () => {});
		expect(getUrl).not.toHaveBeenCalled();
		expect(screen.getByTestId("glyph")).toBeInTheDocument();
	});

	it("paints the first frame onto a canvas once visible, then releases the video", async () => {
		installImmediateIntersectionObserver();
		render(<VideoFrameThumb path="/wt/v.mp4" fallback={fallback} badge={<span data-testid="badge" />} />);
		await waitFor(() => expect(created[0]?.getAttribute("src")).toBe("http://127.0.0.1/shared-media//wt/v.mp4"));
		const video = created[0];
		expect(video.preload).toBe("metadata");
		expect(video.muted).toBe(true);

		act(() => { video.dispatchEvent(new Event("loadedmetadata")); });
		expect(video.currentTime).toBe(FIRST_FRAME_TIME);
		act(() => { video.dispatchEvent(new Event("seeked")); });

		const canvas = screen.getByTestId("video-frame-thumb") as HTMLCanvasElement;
		expect(drawImage).toHaveBeenCalledWith(video, 0, 0);
		expect([canvas.width, canvas.height]).toEqual([720, 1280]);
		expect(canvas).toHaveAttribute("data-captured", "true");
		expect(screen.queryByTestId("glyph")).toBeNull();
		expect(screen.getByTestId("badge")).toBeInTheDocument();
		// Pixels stay, the connection and decoder go.
		expect(video.hasAttribute("src")).toBe(false);
		expect(video.load).toHaveBeenCalled();
	});

	it("keeps the glyph when the host refuses to stream the clip", async () => {
		installImmediateIntersectionObserver();
		getUrl.mockResolvedValue(null);
		render(<VideoFrameThumb path="/wt/v.mp4" fallback={fallback} />);
		await waitFor(() => expect(getUrl).toHaveBeenCalled());
		await act(async () => {});
		expect(screen.getByTestId("glyph")).toBeInTheDocument();
		expect(screen.getByTestId("video-frame-thumb")).not.toHaveAttribute("data-captured");
	});

	it("grabs at most two frames at a time and hands the slot on when one finishes", async () => {
		installImmediateIntersectionObserver();
		render(<>{["a", "b", "c"].map((id) => <VideoFrameThumb key={id} path={`/wt/${id}.mp4`} fallback={fallback} />)}</>);
		await waitFor(() => expect(getUrl).toHaveBeenCalledTimes(2));
		await act(async () => {});
		expect(getUrl).toHaveBeenCalledTimes(2);
		act(() => { created[0].dispatchEvent(new Event("error")); });
		await waitFor(() => expect(getUrl).toHaveBeenCalledWith({ path: "/wt/c.mp4" }));
	});

	it("releases the video and its slot when the tile unmounts mid-grab", async () => {
		installImmediateIntersectionObserver();
		const { unmount } = render(<VideoFrameThumb path="/wt/v.mp4" fallback={fallback} />);
		await waitFor(() => expect(created[0]?.hasAttribute("src")).toBe(true));
		unmount();
		expect(created[0].hasAttribute("src")).toBe(false);
		render(<>{["x", "y"].map((id) => <VideoFrameThumb key={id} path={`/wt/${id}.mp4`} fallback={fallback} />)}</>);
		await waitFor(() => expect(getUrl).toHaveBeenCalledTimes(3));
	});
});
