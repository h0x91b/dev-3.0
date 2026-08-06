import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SharedArtifact } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import TaskArtifactViewer from "../TaskArtifactViewer";

vi.mock("../../rpc", () => ({
	api: { request: { readArtifactContent: vi.fn(), readArtifactDownload: vi.fn(), openArtifactInBrowser: vi.fn() } },
}));

// Pin the platform so the ⌘F assertions don't depend on the host running them.
const platform = vi.hoisted(() => ({ remote: false }));
vi.mock("../../utils/platform", () => ({ isMac: () => true, isRemote: () => platform.remote }));
import { api } from "../../rpc";
const mockedApi = vi.mocked(api, true);

function artifact(id: string, withBundle = false): SharedArtifact {
	return {
		id,
		kind: "html",
		title: `Artifact ${id}`,
		name: `${id}.html`,
		storedPath: `/wt/shared-artifacts/${id}/${id}.html`,
		originalPath: `/tmp/${id}.html`,
		bytes: 10,
		createdAt: 1,
		assets: [],
		...(withBundle ? { bundlePath: `/wt/shared-artifacts/${id}/${id}.zip`, bundleBytes: 20 } : {}),
	};
}

beforeEach(() => {
	vi.mocked(mockedApi.request.readArtifactContent).mockResolvedValue({
		html: '<!doctype html><html><head></head><body><img src="chart.png"></body></html>',
		assets: [{ name: "chart.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" }],
	});
	platform.remote = false;
	vi.mocked(mockedApi.request.openArtifactInBrowser).mockResolvedValue(undefined);
	vi.mocked(mockedApi.request.readArtifactDownload).mockResolvedValue({
		fileName: "b.zip",
		mime: "application/zip",
		base64: "UEsDBA==",
	});
});

describe("TaskArtifactViewer", () => {
	it("loads the latest artifact into a sandboxed iframe", async () => {
		render(<I18nProvider><TaskArtifactViewer artifacts={[artifact("a"), artifact("b", true)]} initialIndex={1} onClose={vi.fn()} /></I18nProvider>);
		expect(screen.getByText("Artifact b")).toBeInTheDocument();
		const frame = await screen.findByTitle("Artifact b");
		expect(frame).toHaveAttribute("sandbox", "allow-scripts");
		await waitFor(() => expect(frame.getAttribute("srcdoc")).toContain("data:image/png;base64,AAA"));
	});

	it("opens the latest artifact when the list updates while the viewer is open", async () => {
		const { rerender } = render(
			<I18nProvider><TaskArtifactViewer artifacts={[artifact("a"), artifact("b")]} initialIndex={1} onClose={vi.fn()} /></I18nProvider>,
		);

		rerender(
			<I18nProvider><TaskArtifactViewer artifacts={[artifact("a"), artifact("b"), artifact("c")]} initialIndex={2} onClose={vi.fn()} /></I18nProvider>,
		);

		expect(screen.getByText("Artifact c")).toBeInTheDocument();
		expect(screen.getByText("3 / 3")).toBeInTheDocument();
		const frame = await screen.findByTitle("Artifact c");
		expect(frame).toBeInTheDocument();
	});

	it("toggles fullscreen and closes", async () => {
		const onClose = vi.fn();
		render(<I18nProvider><TaskArtifactViewer artifacts={[artifact("a")]} initialIndex={0} onClose={onClose} /></I18nProvider>);
		await userEvent.click(screen.getByTestId("artifact-viewer-fullscreen"));
		expect(screen.getByTestId("artifact-viewer")).toHaveAttribute("data-fullscreen", "true");
		await userEvent.click(screen.getByTestId("artifact-viewer-close"));
		expect(onClose).toHaveBeenCalledOnce();
	});

	it.each(["light", "dark"] as const)("starts in the current dev3 %s theme and keeps the override cycle", async (hostTheme) => {
		const previousTheme = document.documentElement.dataset.theme;
		document.documentElement.dataset.theme = hostTheme;
		try {
			render(<I18nProvider><TaskArtifactViewer artifacts={[artifact("a")]} initialIndex={0} onClose={vi.fn()} /></I18nProvider>);
			const frame = await screen.findByTitle("Artifact a") as HTMLIFrameElement;
			const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
			const theme = screen.getByTestId("artifact-viewer-theme");
			const nextTheme = hostTheme === "light" ? "dark" : "light";
			expect(theme).toHaveAccessibleName(`Artifact theme: ${hostTheme === "light" ? "Light" : "Dark"}`);
			fireEvent.load(frame);
			await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: "dev3-artifact-theme", theme: hostTheme }, "*"));
			await userEvent.click(theme);
			expect(theme).toHaveAccessibleName(`Artifact theme: ${nextTheme === "light" ? "Light" : "Dark"}`);
			await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: "dev3-artifact-theme", theme: nextTheme }, "*"));
			await userEvent.click(theme);
			expect(theme).toHaveAccessibleName("Artifact theme: Follow dev3");
			await userEvent.click(theme);
			expect(theme).toHaveAccessibleName(`Artifact theme: ${hostTheme === "light" ? "Light" : "Dark"}`);
		} finally {
			if (previousTheme) document.documentElement.dataset.theme = previousTheme;
			else delete document.documentElement.dataset.theme;
		}
	});

	it("does not consume terminal shortcuts until focus enters the viewer", async () => {
		const onClose = vi.fn();
		render(<I18nProvider><button type="button">Terminal</button><TaskArtifactViewer artifacts={[artifact("a")]} initialIndex={0} onClose={onClose} /></I18nProvider>);
		screen.getByRole("button", { name: "Terminal" }).focus();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).not.toHaveBeenCalled();
		screen.getByTestId("artifact-viewer-close").focus();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("saves an artifact image to Downloads when the sandboxed iframe requests it", async () => {
		const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
		vi.mocked(mockedApi.request.readArtifactContent).mockResolvedValueOnce({
			html: '<img src="charts/chart.png">',
			assets: [{ name: "charts/chart.png", mime: "image/png", dataUrl }],
		});
		const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:img");
		const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		let savedName = "";
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
			savedName = this.download;
		});

		render(<I18nProvider><TaskArtifactViewer artifacts={[artifact("a")]} initialIndex={0} onClose={vi.fn()} /></I18nProvider>);
		const frame = await screen.findByTitle("Artifact a") as HTMLIFrameElement;
		await waitFor(() => expect(frame.getAttribute("srcdoc")).toContain(dataUrl));

		const foreign = new MessageEvent("message", { data: { type: "dev3-artifact-save-image", src: dataUrl, alt: "" } });
		window.dispatchEvent(foreign);
		expect(click).not.toHaveBeenCalled();

		const event = new MessageEvent("message", { data: { type: "dev3-artifact-save-image", src: dataUrl, alt: "" } });
		Object.defineProperty(event, "source", { value: frame.contentWindow });
		window.dispatchEvent(event);

		await waitFor(() => expect(click).toHaveBeenCalled());
		expect(createObjectURL).toHaveBeenCalled();
		expect(savedName).toBe("chart.png");

		createObjectURL.mockRestore();
		revokeObjectURL.mockRestore();
		click.mockRestore();
	});

	async function openFind(artifactList = [artifact("a")]) {
		render(<I18nProvider><button type="button">Terminal</button><TaskArtifactViewer artifacts={artifactList} initialIndex={0} onClose={vi.fn()} /></I18nProvider>);
		const frame = await screen.findByTitle(`Artifact ${artifactList[0].id}`) as HTMLIFrameElement;
		const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
		return { frame, postMessage };
	}

	/** Fake a reply from the sandboxed document for the newest query token. */
	function replyFromFrame(frame: HTMLIFrameElement, token: number, matches: number, index: number) {
		const event = new MessageEvent("message", { data: { type: "dev3-artifact-find-result", token, matches, index } });
		Object.defineProperty(event, "source", { value: frame.contentWindow });
		window.dispatchEvent(event);
	}

	it("opens find on ⌘F only once focus is inside the viewer, and searches the sandboxed document", async () => {
		const { frame, postMessage } = await openFind();

		screen.getByRole("button", { name: "Terminal" }).focus();
		fireEvent.keyDown(window, { code: "KeyF", metaKey: true });
		expect(screen.queryByTestId("artifact-search-bar")).not.toBeInTheDocument();

		screen.getByTestId("artifact-viewer-close").focus();
		fireEvent.keyDown(window, { code: "KeyF", metaKey: true });
		expect(screen.getByTestId("artifact-search-bar")).toBeInTheDocument();

		await userEvent.type(screen.getByPlaceholderText("Find in artifact"), "revenue");
		await waitFor(() => expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: "dev3-artifact-find", query: "revenue" }),
			"*",
		));

		replyFromFrame(frame, 1, 3, 0);
		await waitFor(() => expect(screen.getByTestId("artifact-search-count")).toHaveTextContent("1/3"));

		await userEvent.click(screen.getByRole("button", { name: /next match/i }));
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "dev3-artifact-find-step", delta: 1 }), "*");
	});

	// Regression: the magnifier shipped as an EMPTY button once — the Nerd Font glyph
	// was lost in editing, so the control rendered as a blank box.
	it("renders an actual magnifier glyph on the header toggle and in the bar", async () => {
		render(<I18nProvider><TaskArtifactViewer artifacts={[artifact("a")]} initialIndex={0} onClose={vi.fn()} /></I18nProvider>);
		await screen.findByTitle("Artifact a");
		const toggle = screen.getByTestId("artifact-viewer-search");
		expect(toggle).toHaveTextContent("\uf002");
		await userEvent.click(toggle);
		expect(screen.getByTestId("artifact-search-bar")).toHaveTextContent("\uf002");
	});

	it("opens find when the artifact relays its own ⌘F, and the header magnifier toggles it", async () => {
		const { frame } = await openFind();

		const relay = new MessageEvent("message", { data: { type: "dev3-artifact-find-open" } });
		Object.defineProperty(relay, "source", { value: frame.contentWindow });
		window.dispatchEvent(relay);
		await waitFor(() => expect(screen.getByTestId("artifact-search-bar")).toBeInTheDocument());

		await userEvent.click(screen.getByTestId("artifact-viewer-search"));
		expect(screen.queryByTestId("artifact-search-bar")).not.toBeInTheDocument();
		await userEvent.click(screen.getByTestId("artifact-viewer-search"));
		expect(screen.getByTestId("artifact-search-bar")).toBeInTheDocument();
	});

	it("keeps Escape and the arrow keys off artifact history while find is open", async () => {
		const onClose = vi.fn();
		render(<I18nProvider><TaskArtifactViewer artifacts={[artifact("a"), artifact("b")]} initialIndex={0} onClose={onClose} /></I18nProvider>);
		await screen.findByTitle("Artifact a");
		screen.getByTestId("artifact-viewer-close").focus();
		fireEvent.keyDown(window, { code: "KeyF", metaKey: true });
		expect(screen.getByTestId("artifact-search-bar")).toBeInTheDocument();

		// Arrows belong to the query caret, not to the artifact history.
		fireEvent.keyDown(window, { key: "ArrowRight" });
		expect(screen.getByText("Artifact a")).toBeInTheDocument();

		// Escape unwinds one layer: find first, the viewer only after.
		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.queryByTestId("artifact-search-bar")).not.toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
		// Focus must land back on the toggle, never on the iframe — key events inside
		// the sandboxed document never reach this window, so the next Escape would die.
		expect(document.activeElement).toBe(screen.getByTestId("artifact-viewer-search"));
		fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalledOnce();
	});

	// Regression: the app-level Escape handler is a bubble listener registered at root
	// mount, so it used to run FIRST and navigate out of the task workspace while the
	// viewer merely closed itself — one keypress, two layers gone (decision 181).
	it("consumes Escape and the arrow keys before the app-level handler sees them", async () => {
		const appLevel = vi.fn();
		window.addEventListener("keydown", appLevel);
		try {
			const onClose = vi.fn();
			render(<I18nProvider><TaskArtifactViewer artifacts={[artifact("a"), artifact("b")]} initialIndex={0} onClose={onClose} /></I18nProvider>);
			await screen.findByTitle("Artifact a");
			const close = screen.getByTestId("artifact-viewer-close");
			close.focus();

			// Dispatched on the focused element, like a real keypress — the viewer's
			// capture listener must stop it before it bubbles up to window.
			fireEvent.keyDown(close, { key: "ArrowRight" });
			expect(screen.getByText("Artifact b")).toBeInTheDocument();
			fireEvent.keyDown(close, { key: "Escape" });
			expect(onClose).toHaveBeenCalledOnce();
			expect(appLevel).not.toHaveBeenCalled();
		} finally {
			window.removeEventListener("keydown", appLevel);
		}
	});

	it("hands the stored artifact file to the OS browser on desktop", async () => {
		render(<I18nProvider><TaskArtifactViewer artifacts={[artifact("a")]} initialIndex={0} onClose={vi.fn()} /></I18nProvider>);
		await screen.findByTitle("Artifact a");
		await userEvent.click(screen.getByTestId("artifact-viewer-open-browser"));
		expect(mockedApi.request.openArtifactInBrowser).toHaveBeenCalledWith({ artifact: artifact("a") });
	});

	it("opens the composed document in a new tab in remote mode, without touching the host", async () => {
		platform.remote = true;
		vi.mocked(mockedApi.request.openArtifactInBrowser).mockClear();
		const openSpy = vi.fn().mockReturnValue({});
		window.open = openSpy;
		render(<I18nProvider><TaskArtifactViewer artifacts={[artifact("a")]} initialIndex={0} onClose={vi.fn()} /></I18nProvider>);
		await screen.findByTitle("Artifact a");
		await userEvent.click(screen.getByTestId("artifact-viewer-open-browser"));
		expect(mockedApi.request.openArtifactInBrowser).not.toHaveBeenCalled();
		expect(openSpy).toHaveBeenCalledOnce();
		expect(String(openSpy.mock.calls[0][0])).toMatch(/^blob:/);
	});

	it("requests ZIP download when the artifact has assets", async () => {
		const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		render(<I18nProvider><TaskArtifactViewer artifacts={[artifact("b", true)]} initialIndex={0} onClose={vi.fn()} /></I18nProvider>);
		await userEvent.click(screen.getByRole("button", { name: /download zip/i }));
		await waitFor(() => expect(mockedApi.request.readArtifactDownload).toHaveBeenCalled());
		expect(createObjectURL).toHaveBeenCalled();
		expect(click).toHaveBeenCalled();
		createObjectURL.mockRestore();
		click.mockRestore();
	});
});
