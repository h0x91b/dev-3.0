import { act, render, screen, waitFor } from "@testing-library/react";
import type { Context } from "cordis";
import type { SharedArtifact } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import { getAppRoot } from "../../plugins/root";
import TaskDock from "../TaskDock";
import TaskPanelInstances from "../TaskPanelInstances";
import { activateTaskPanel, getTaskDock, openTaskPanel } from "../dock-store";
import {
	ARTIFACT_PANEL_ID,
	closeArtifactViewer,
	isArtifactViewerShowing,
	setArtifactPopupPreference,
	showArtifactViewer,
} from "../artifact-panel";
import { installTaskPanelBuiltins } from "./install-builtins";

vi.mock("../../rpc", () => ({
	api: { request: { readArtifactContent: vi.fn(), getTaskReview: vi.fn(() => Promise.resolve(null)) } },
}));

import { api } from "../../rpc";

const artifacts: SharedArtifact[] = [{ id: "a1", kind: "html", title: "Report", name: "a1.html", storedPath: "/wt/a1.html", originalPath: "/tmp/a1.html", bytes: 1, createdAt: 1, assets: [] }];

function Screen({ taskId }: { taskId: string | null }) {
	return (
		<I18nProvider>
			<TaskPanelInstances tasks={[]} />
			{taskId && <div className="flex"><TaskDock taskId={taskId} covered={false} canDock /></div>}
		</I18nProvider>
	);
}

function viewer() {
	return screen.getByTestId("artifact-viewer");
}

beforeEach(async () => {
	localStorage.clear();
	vi.mocked(api.request.readArtifactContent).mockReset().mockResolvedValue({ html: "<p>hi</p>", assets: [], downloadKind: "html" });
	await installTaskPanelBuiltins();
});

describe("artifact panel", () => {
	it("re-hosts the same viewer when the popup preference flips, without reloading it", async () => {
		render(<Screen taskId="t1" />);
		act(() => showArtifactViewer({ taskId: "t1", artifacts, index: 0 }));
		await waitFor(() => expect(viewer()).toHaveAttribute("data-presentation", "docked"));
		await waitFor(() => expect(api.request.readArtifactContent).toHaveBeenCalledTimes(1));

		act(() => setArtifactPopupPreference(true));
		expect(viewer()).toHaveAttribute("data-presentation", "popup");
		expect(screen.queryByTestId("task-dock")).toBeNull();
		expect(getTaskDock("t1").floating).toEqual([ARTIFACT_PANEL_ID]);

		act(() => setArtifactPopupPreference(false));
		expect(viewer()).toHaveAttribute("data-presentation", "docked");
		expect(screen.getAllByTestId("artifact-viewer")).toHaveLength(1);
		expect(api.request.readArtifactContent).toHaveBeenCalledTimes(1);
	});

	it("keeps a paneless viewer a popup that takes no tab, on or off its task", () => {
		const { rerender } = render(<Screen taskId="t1" />);
		act(() => showArtifactViewer({ taskId: "t1", artifacts, index: 0, paneless: true }));
		expect(viewer()).toHaveAttribute("data-presentation", "popup");
		expect(screen.queryByTestId("task-dock")).toBeNull();
		rerender(<Screen taskId="t2" />);
		expect(viewer()).toHaveAttribute("data-presentation", "popup");
		expect(isArtifactViewerShowing("t1")).toBe(true);
	});

	it("brings a republished artifact to the front of the dock", async () => {
		getAppRoot().plugin({
			name: "notes",
			inject: ["taskPanels"],
			apply(ctx: Context) {
				ctx.taskPanels.register({ id: "ext:notes", title: () => "notes", component: () => <div data-testid="notes" /> });
			},
		});
		for (let tick = 0; tick < 50 && !getAppRoot().taskPanels.get("ext:notes"); tick++) await Promise.resolve();
		render(<Screen taskId="t1" />);
		act(() => showArtifactViewer({ taskId: "t1", artifacts, index: 0 }));
		act(() => {
			openTaskPanel("t1", "ext:notes");
			activateTaskPanel("t1", "ext:notes");
		});
		expect(viewer()).toHaveAttribute("data-presentation", "offscreen");

		act(() => showArtifactViewer((previous) => ({ ...previous!, artifacts: [...artifacts, { ...artifacts[0], id: "a2" }], index: 1 })));
		expect(getTaskDock("t1").active).toBe(ARTIFACT_PANEL_ID);
		expect(viewer()).toHaveAttribute("data-presentation", "docked");
	});

	it("is one viewer app-wide: another task's artifact closes the first tab, Close closes its own", () => {
		render(<Screen taskId="t1" />);
		act(() => showArtifactViewer({ taskId: "t1", artifacts, index: 0 }));
		expect(getTaskDock("t1").open).toEqual([ARTIFACT_PANEL_ID]);
		act(() => showArtifactViewer({ taskId: "t2", artifacts, index: 0 }));
		expect(getTaskDock("t1").open).toEqual([]);
		expect(getTaskDock("t2").open).toEqual([ARTIFACT_PANEL_ID]);
		expect(isArtifactViewerShowing("t2")).toBe(false);
		expect(viewer()).toHaveAttribute("data-presentation", "offscreen");

		act(() => closeArtifactViewer());
		expect(getTaskDock("t2").open).toEqual([]);
		expect(screen.queryByTestId("artifact-viewer")).toBeNull();
	});
});
