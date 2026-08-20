import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskImageViewer from "../TaskImageViewer";
import { I18nProvider } from "../../i18n";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import type { SharedImage } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			readImageBase64: vi.fn(),
			openImageFile: vi.fn().mockResolvedValue(undefined),
		},
	},
}));

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

beforeEach(() => {
	(mockedApi.request.readImageBase64 as ReturnType<typeof vi.fn>).mockResolvedValue({
		dataUrl: "data:image/png;base64,AAAA",
	});
});

describe("TaskImageViewer", () => {
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
			expect(screen.queryByTestId("image-viewer-context-menu")).toBeNull();
			fireEvent.contextMenu(image);
			expect(screen.getByTestId("image-viewer-context-menu")).toBeInTheDocument();
			await userEvent.click(screen.getByTestId("image-viewer-menu-download"));
			expect(spy.names).toEqual(["three.png"]);
			expect(screen.queryByTestId("image-viewer-context-menu")).toBeNull();
			spy.restore();
		});

		it("closes the right-click menu on Escape without closing the viewer", async () => {
			const onClose = renderViewer();
			const image = await screen.findByTestId("viewer-main-image");
			fireEvent.contextMenu(image);
			fireEvent.keyDown(window, { key: "Escape" });
			expect(screen.queryByTestId("image-viewer-context-menu")).toBeNull();
			expect(onClose).not.toHaveBeenCalled();
		});

		it("disables the header download while the bytes are unavailable", async () => {
			(mockedApi.request.readImageBase64 as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("nope"));
			renderViewer();
			await waitFor(() => expect(screen.getByTestId("image-viewer-download")).toBeDisabled());
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
