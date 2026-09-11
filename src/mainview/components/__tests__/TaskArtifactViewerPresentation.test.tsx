import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SharedArtifact } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import TaskArtifactViewer from "../TaskArtifactViewer";
import { setArtifactDock } from "../../utils/artifact-dock";

vi.mock("../../rpc", () => ({
	api: { request: { readArtifactContent: vi.fn(), readArtifactDownload: vi.fn(), openArtifactInBrowser: vi.fn(), sendArtifactMessageToAgent: vi.fn() } },
}));
vi.mock("../../utils/platform", () => ({ isMac: () => true, isRemote: () => false }));
vi.mock("../../toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { api } from "../../rpc";
const mockedApi = vi.mocked(api, true);

function artifact(): SharedArtifact {
	return {
		id: "a1",
		kind: "html",
		title: "Report",
		name: "a1.html",
		storedPath: "/wt/shared-artifacts/a1/a1.html",
		originalPath: "/tmp/a1.html",
		bytes: 10,
		createdAt: 1,
		assets: [],
	};
}

let dock: HTMLDivElement | null = null;

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(mockedApi.request.readArtifactContent).mockResolvedValue({
		html: "<!doctype html><html><head></head><body>hi</body></html>",
		assets: [],
	});
});

afterEach(() => {
	act(() => setArtifactDock(null));
	dock?.remove();
	dock = null;
	document.documentElement.removeAttribute("data-artifact-viewer");
});

function mountDock(): HTMLDivElement {
	dock = document.createElement("div");
	document.body.appendChild(dock);
	act(() => setArtifactDock(dock));
	return dock;
}

describe("TaskArtifactViewer presentation", () => {
	it("renders as a popup when no dock is published", async () => {
		render(<I18nProvider><TaskArtifactViewer taskId="t1" artifacts={[artifact()]} initialIndex={0} onClose={vi.fn()} /></I18nProvider>);
		const viewer = await screen.findByTestId("artifact-viewer");
		expect(viewer).toHaveAttribute("data-presentation", "popup");
		expect(viewer).toHaveAttribute("aria-modal", "true");
		// The popup covers the terminal, so the WebGL canvas has to be hidden.
		expect(document.documentElement).toHaveAttribute("data-artifact-viewer", "open");
	});

	it("renders inside the published dock and leaves the terminal visible", async () => {
		const slot = mountDock();
		render(<I18nProvider><TaskArtifactViewer taskId="t1" artifacts={[artifact()]} initialIndex={0} onClose={vi.fn()} /></I18nProvider>);
		const viewer = await screen.findByTestId("artifact-viewer");
		expect(viewer).toHaveAttribute("data-presentation", "docked");
		expect(slot.contains(viewer)).toBe(true);
		// Not modal: the terminal beside the panel is live.
		expect(viewer).not.toHaveAttribute("aria-modal");
		expect(document.documentElement).not.toHaveAttribute("data-artifact-viewer");
	});

	it("keeps the same viewer and its loaded document when the dock disappears", async () => {
		mountDock();
		render(<I18nProvider><TaskArtifactViewer taskId="t1" artifacts={[artifact()]} initialIndex={0} onClose={vi.fn()} /></I18nProvider>);
		await screen.findByTestId("artifact-viewer");
		await waitFor(() => expect(mockedApi.request.readArtifactContent).toHaveBeenCalledTimes(1));

		act(() => setArtifactDock(null));

		const viewer = await screen.findByTestId("artifact-viewer");
		expect(viewer).toHaveAttribute("data-presentation", "popup");
		// One viewer, one instance: re-hosting must not re-fetch or duplicate it.
		expect(screen.getAllByTestId("artifact-viewer")).toHaveLength(1);
		expect(mockedApi.request.readArtifactContent).toHaveBeenCalledTimes(1);
	});

	// The other direction: turning the preference off (or walking back into the
	// task) hands the live popup into the slot without reloading it.
	it("keeps the same viewer when a dock appears under an open popup", async () => {
		render(<I18nProvider><TaskArtifactViewer taskId="t1" artifacts={[artifact()]} initialIndex={0} onClose={vi.fn()} /></I18nProvider>);
		await screen.findByTestId("artifact-viewer");
		await waitFor(() => expect(mockedApi.request.readArtifactContent).toHaveBeenCalledTimes(1));

		const slot = mountDock();

		const viewer = await screen.findByTestId("artifact-viewer");
		expect(viewer).toHaveAttribute("data-presentation", "docked");
		expect(slot.contains(viewer)).toBe(true);
		expect(screen.getAllByTestId("artifact-viewer")).toHaveLength(1);
		expect(mockedApi.request.readArtifactContent).toHaveBeenCalledTimes(1);
		expect(document.documentElement).not.toHaveAttribute("data-artifact-viewer");
	});

	// Leaving the task takes the dock with it. Offscreen is what stops that from
	// turning the panel into a popup over an unrelated board.
	it("waits hidden when its task leaves the screen, and comes back loaded", async () => {
		const onClose = vi.fn();
		// One stable list across rerenders — a fresh array is a new artifact to the
		// viewer and would legitimately re-fetch, hiding the point of this test.
		const list = [artifact()];
		mountDock();
		const view = render(<I18nProvider><TaskArtifactViewer taskId="t1" artifacts={list} initialIndex={0} onClose={onClose} /></I18nProvider>);
		await screen.findByTestId("artifact-viewer");
		await waitFor(() => expect(mockedApi.request.readArtifactContent).toHaveBeenCalledTimes(1));

		act(() => setArtifactDock(null));
		view.rerender(<I18nProvider><TaskArtifactViewer taskId="t1" artifacts={list} initialIndex={0} offscreen onClose={onClose} /></I18nProvider>);

		const hidden = screen.getByTestId("artifact-viewer");
		expect(hidden).toHaveAttribute("data-presentation", "offscreen");
		expect(screen.getByTestId("artifact-viewer-offscreen")).toHaveAttribute("hidden");
		// Owns nothing while hidden: no modal role, no blanked terminal, no Escape.
		expect(hidden).not.toHaveAttribute("aria-modal");
		expect(document.documentElement).not.toHaveAttribute("data-artifact-viewer");
		fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).not.toHaveBeenCalled();

		const slot = mountDock();
		view.rerender(<I18nProvider><TaskArtifactViewer taskId="t1" artifacts={list} initialIndex={0} onClose={onClose} /></I18nProvider>);

		const viewer = screen.getByTestId("artifact-viewer");
		expect(viewer).toHaveAttribute("data-presentation", "docked");
		expect(slot.contains(viewer)).toBe(true);
		expect(mockedApi.request.readArtifactContent).toHaveBeenCalledTimes(1);
	});

	it("docked, Escape only closes while focus is inside the panel", async () => {
		const onClose = vi.fn();
		mountDock();
		render(<I18nProvider><TaskArtifactViewer taskId="t1" artifacts={[artifact()]} initialIndex={0} onClose={onClose} /></I18nProvider>);
		await screen.findByTestId("artifact-viewer");

		const outside = document.createElement("button");
		document.body.appendChild(outside);
		outside.focus();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).not.toHaveBeenCalled();

		screen.getByTestId("artifact-viewer-close").focus();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
		outside.remove();
	});

	it("popup closes on Escape from anywhere", async () => {
		const onClose = vi.fn();
		render(<I18nProvider><TaskArtifactViewer taskId="t1" artifacts={[artifact()]} initialIndex={0} onClose={onClose} /></I18nProvider>);
		await screen.findByTestId("artifact-viewer");
		fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("docked fullscreen covers the terminal and hides the WebGL canvas", async () => {
		mountDock();
		render(<I18nProvider><TaskArtifactViewer taskId="t1" artifacts={[artifact()]} initialIndex={0} onClose={vi.fn()} /></I18nProvider>);
		await screen.findByTestId("artifact-viewer");
		await userEvent.click(screen.getByTestId("artifact-viewer-fullscreen"));

		const viewer = screen.getByTestId("artifact-viewer");
		expect(viewer).toHaveAttribute("data-fullscreen", "true");
		expect(viewer).toHaveAttribute("data-presentation", "docked");
		expect(document.documentElement).toHaveAttribute("data-artifact-viewer", "open");
	});

	// A docked panel can be dragged narrower than its own toolbar. Everything else
	// may scroll out of sight there; Close may not, or the panel has no way out.
	it("keeps Close out of the row that scrolls when the panel is narrow", async () => {
		mountDock();
		render(<I18nProvider><TaskArtifactViewer taskId="t1" artifacts={[artifact(), { ...artifact(), id: "a2", title: "Second" }]} initialIndex={0} onClose={vi.fn()} /></I18nProvider>);
		const actions = await screen.findByTestId("artifact-viewer-actions");

		expect(actions.contains(screen.getByTestId("artifact-viewer-close"))).toBe(false);
		expect(actions.className).toContain("overflow-x-auto");
		for (const id of ["artifact-viewer-search", "artifact-viewer-theme", "artifact-viewer-open-browser", "artifact-viewer-fullscreen"]) {
			expect(actions.contains(screen.getByTestId(id))).toBe(true);
		}
	});
});
