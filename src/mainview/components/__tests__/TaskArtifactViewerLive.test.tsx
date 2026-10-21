import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LiveArtifact, SharedArtifact } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import TaskArtifactViewer from "../TaskArtifactViewer";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			readArtifactContent: vi.fn(),
			readArtifactDownload: vi.fn(),
			openArtifactInBrowser: vi.fn(),
			createArtifactLink: vi.fn(),
			sendArtifactMessageToAgent: vi.fn(),
			liveArtifactOp: vi.fn(),
			openLiveArtifactInBrowser: vi.fn(),
			adoptLiveArtifact: vi.fn(),
		},
	},
}));
vi.mock("../../utils/platform", () => ({ isMac: () => true, isRemote: () => false }));
vi.mock("../../toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("../../confirm", () => ({ confirm: vi.fn() }));
import { api } from "../../rpc";
import { confirm } from "../../confirm";
const request = vi.mocked(api.request, true);

function artifact(id: string): SharedArtifact {
	return { id, kind: "html", title: `Artifact ${id}`, name: `${id}.html`, storedPath: `/wt/shared-artifacts/${id}/${id}.html`, originalPath: "/tmp/x.html", bytes: 1, createdAt: 1, assets: [] };
}

function live(pageRev = 1, title = "Board"): LiveArtifact {
	return { pageRev, createdAt: 1, updatedAt: 1, page: { ...artifact(`page${pageRev}`), title } };
}

function renderViewer(props: { artifacts?: SharedArtifact[]; live?: LiveArtifact; initialIndex?: number; taskStatus?: "in-progress" | "completed" }) {
	const element = (next: typeof props) => (
		<I18nProvider>
			<TaskArtifactViewer
				taskId="task-9"
				projectId="p1"
				taskStatus={next.taskStatus ?? "in-progress"}
				artifacts={next.artifacts ?? [artifact("a")]}
				live={next.live}
				initialIndex={next.initialIndex ?? 0}
				onClose={vi.fn()}
			/>
		</I18nProvider>
	);
	const view = render(element(props));
	return { ...view, update: (next: typeof props) => view.rerender(element({ ...props, ...next })) };
}

function fromFrame(frame: HTMLIFrameElement, data: Record<string, unknown>) {
	const event = new MessageEvent("message", { data });
	Object.defineProperty(event, "source", { value: frame.contentWindow });
	window.dispatchEvent(event);
}

beforeEach(() => {
	vi.clearAllMocks();
	request.readArtifactContent.mockResolvedValue({ html: "<!doctype html><html><head></head><body>x</body></html>", assets: [], downloadKind: "html" });
	request.liveArtifactOp.mockResolvedValue({ ok: true, result: { rev: 1 } });
	request.adoptLiveArtifact.mockResolvedValue(live(2));
	request.openLiveArtifactInBrowser.mockResolvedValue(undefined);
});

describe("TaskArtifactViewer — live page", () => {
	it("lists the live page last, badged, with the live client in its document", async () => {
		renderViewer({ live: live(), initialIndex: 1 });
		expect(screen.getByTestId("artifact-viewer-live-badge")).toBeInTheDocument();
		const frame = await screen.findByTitle("Board") as HTMLIFrameElement;
		await waitFor(() => expect(frame.getAttribute("srcdoc")).toContain("data-dev3-live-client"));
		expect(frame.getAttribute("srcdoc")).toContain('"transport":"frame"');
		expect(screen.queryByTestId("artifact-viewer-make-live")).not.toBeInTheDocument();
	});

	it("an ordinary artifact gets no live client and offers Make live", async () => {
		renderViewer({ live: live(), initialIndex: 0 });
		const frame = await screen.findByTitle("Artifact a") as HTMLIFrameElement;
		await waitFor(() => expect(frame.getAttribute("srcdoc")).toContain("data-dev3-artifact-bridge"));
		expect(frame.getAttribute("srcdoc")).not.toContain("data-dev3-live-client");
		expect(screen.queryByTestId("artifact-viewer-live-badge")).not.toBeInTheDocument();
		expect(screen.getByTestId("artifact-viewer-make-live")).toBeInTheDocument();
	});

	it("runs the page's dev3.live requests as the task's and answers into the frame", async () => {
		renderViewer({ live: live(), initialIndex: 1 });
		const frame = await screen.findByTitle("Board") as HTMLIFrameElement;
		await waitFor(() => expect(frame.getAttribute("srcdoc")).toContain("data-dev3-live-client"));
		const post = vi.spyOn(frame.contentWindow!, "postMessage");
		fromFrame(frame, { type: "dev3-live-request", id: 5, op: "patch", args: { collection: "cards", id: "c1", patch: { a: 1 } } });
		await waitFor(() => expect(request.liveArtifactOp).toHaveBeenCalledWith({ taskId: "task-9", projectId: "p1", op: "patch", args: { collection: "cards", id: "c1", patch: { a: 1 } } }));
		await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "dev3-live-result", id: 5, ok: true }), "*"));
	});

	it("forwards store changes for its task into the live page only", async () => {
		renderViewer({ live: live(), initialIndex: 1 });
		const frame = await screen.findByTitle("Board") as HTMLIFrameElement;
		await waitFor(() => expect(frame.getAttribute("srcdoc")).toContain("data-dev3-live-client"));
		const post = vi.spyOn(frame.contentWindow!, "postMessage");
		window.dispatchEvent(new CustomEvent("rpc:liveArtifactChange", { detail: { taskId: "other", changes: [{ rev: 1 }] } }));
		window.dispatchEvent(new CustomEvent("rpc:liveArtifactChange", { detail: { taskId: "task-9", changes: [{ rev: 2 }] } }));
		expect(post).toHaveBeenCalledTimes(1);
		expect(post).toHaveBeenCalledWith({ type: "dev3-live-change", changes: [{ rev: 2 }] }, "*");
	});

	it("reloads the document for a new page but not for an unrelated task update", async () => {
		const view = renderViewer({ live: live(1), initialIndex: 1 });
		await screen.findByTitle("Board");
		await waitFor(() => expect(request.readArtifactContent).toHaveBeenCalledTimes(1));
		view.update({ live: { ...live(1), updatedAt: 99 } });
		view.update({ live: live(2) });
		await waitFor(() => expect(request.readArtifactContent).toHaveBeenCalledTimes(2));
		expect(request.readArtifactContent).toHaveBeenLastCalledWith({ artifact: expect.objectContaining({ storedPath: "/wt/shared-artifacts/page2/page2.html" }) });
	});

	it("opens the live page on the loopback server", async () => {
		renderViewer({ live: live(), initialIndex: 1 });
		await screen.findByTitle("Board");
		await waitFor(() => expect(screen.getByTestId("artifact-viewer-open-browser")).not.toBeDisabled());
		await userEvent.click(screen.getByTestId("artifact-viewer-open-browser"));
		expect(request.openLiveArtifactInBrowser).toHaveBeenCalledWith({ taskId: "task-9", projectId: "p1" });
		expect(request.openArtifactInBrowser).not.toHaveBeenCalled();
	});

	it("Make live asks before replacing an existing live page", async () => {
		vi.mocked(confirm).mockResolvedValue(false);
		renderViewer({ live: live(), initialIndex: 0 });
		await userEvent.click(screen.getByTestId("artifact-viewer-make-live"));
		expect(confirm).toHaveBeenCalled();
		expect(request.adoptLiveArtifact).not.toHaveBeenCalled();
	});

	it("Make live with no live page yet adopts the artifact version and lands on it", async () => {
		const view = renderViewer({ initialIndex: 0 });
		await userEvent.click(screen.getByTestId("artifact-viewer-make-live"));
		expect(confirm).not.toHaveBeenCalled();
		await waitFor(() => expect(request.adoptLiveArtifact).toHaveBeenCalledWith({ taskId: "task-9", projectId: "p1", artifactId: "a", version: 1 }));
		view.update({ live: live(2) });
		await waitFor(() => expect(screen.getByTestId("artifact-viewer-live-badge")).toBeInTheDocument());
	});

	it("a finished task offers no Make live", () => {
		renderViewer({ taskStatus: "completed" });
		expect(screen.queryByTestId("artifact-viewer-make-live")).not.toBeInTheDocument();
	});
});
