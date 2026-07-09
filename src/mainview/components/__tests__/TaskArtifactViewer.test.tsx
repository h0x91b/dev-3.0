import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SharedArtifact } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import TaskArtifactViewer from "../TaskArtifactViewer";

vi.mock("../../rpc", () => ({
	api: { request: { readArtifactContent: vi.fn(), readArtifactDownload: vi.fn() } },
}));
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

	it("toggles fullscreen and closes", async () => {
		const onClose = vi.fn();
		render(<I18nProvider><TaskArtifactViewer artifacts={[artifact("a")]} initialIndex={0} onClose={onClose} /></I18nProvider>);
		await userEvent.click(screen.getByTestId("artifact-viewer-fullscreen"));
		expect(screen.getByTestId("artifact-viewer")).toHaveAttribute("data-fullscreen", "true");
		await userEvent.click(screen.getByTestId("artifact-viewer-close"));
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("cycles artifact theme from dev3-following to light and dark overrides", async () => {
		render(<I18nProvider><TaskArtifactViewer artifacts={[artifact("a")]} initialIndex={0} onClose={vi.fn()} /></I18nProvider>);
		const frame = await screen.findByTitle("Artifact a") as HTMLIFrameElement;
		const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
		const theme = screen.getByTestId("artifact-viewer-theme");
		expect(theme).toHaveAccessibleName("Artifact theme: Follow dev3");
		await userEvent.click(theme);
		expect(theme).toHaveAccessibleName("Artifact theme: Light");
		await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: "dev3-artifact-theme", theme: "light" }, "*"));
		await userEvent.click(theme);
		expect(theme).toHaveAccessibleName("Artifact theme: Dark");
		await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: "dev3-artifact-theme", theme: "dark" }, "*"));
		await userEvent.click(theme);
		expect(theme).toHaveAccessibleName("Artifact theme: Follow dev3");
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
