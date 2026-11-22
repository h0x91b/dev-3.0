import { act, render } from "@testing-library/react";
import TaskDetailModal from "../TaskDetailModal";
import { I18nProvider } from "../../i18n";
import type { Project, Task } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getTaskLineage: vi.fn(() => new Promise(() => {})),
			readImageBase64: vi.fn(() => new Promise(() => {})),
			getEpics: vi.fn(() => new Promise(() => {})),
			getTaskTerminalBackend: vi.fn(() => new Promise(() => {})),
			getNativeTerminalAvailability: vi.fn(() => new Promise(() => {})),
		},
	},
}));
vi.mock("../../analytics", () => ({ trackEvent: vi.fn(), agentNameFromId: vi.fn(() => "unknown") }));
vi.mock("../../utils/platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../utils/platform")>()),
	isTouchPrimary: vi.fn(() => false),
}));

const project: Project = {
	id: "p1",
	name: "Parity",
	path: "/home/user/parity",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
	labels: [{ id: "l1", name: "ui", color: "#3b82f6" }, { id: "l2", name: "perf", color: "#f59e0b" }],
};

const base: Task = {
	id: "t1",
	seq: 42,
	projectId: "p1",
	title: "Parity title",
	description: "Parity title",
	status: "todo",
	baseBranch: "main",
	worktreePath: null,
	branchName: null,
	groupId: null,
	variantIndex: null,
	agentId: null,
	configId: null,
	createdAt: "2025-01-01T00:00:00Z",
	updatedAt: "2025-01-02T00:00:00Z",
};

const note = (id: string, content: string) => ({ id, content, source: "user" as const, createdAt: "2025-01-03T00:00:00Z", updatedAt: "2025-01-03T00:00:00Z" });

/** Every optional row and section the view can draw, at once. */
const archivedFull: Task = {
	...base,
	status: "completed",
	description: "A **longer** description\n\n- with a list",
	customTitle: "Parity title",
	branchName: "feat/parity",
	baseBranch: "main",
	labelIds: ["l1", "l2"],
	priority: "P1",
	movedAt: "2025-01-04T00:00:00Z",
	origin: { kind: "import" },
	epicId: null,
	pullRequests: [
		{ number: 9, url: "https://github.com/o/r/pull/9", state: "MERGED", firstSeenAt: "2026-09-28T00:00:00Z" },
		{ number: 12, url: "https://github.com/o/r/pull/12", state: null, firstSeenAt: "2026-09-29T00:00:00Z" },
	],
	notes: [note("n1", "First note"), note("n2", "Second note")],
	sharedImages: [{ id: "img-1", storedPath: "/wt/shared-images/img-1.png", originalPath: "/tmp/img-1.png", name: "qa.png", mime: "image/png", bytes: 10, createdAt: 1_780_000_000_000 }],
	sharedArtifacts: [{ id: "art-1", kind: "html", title: "QA report", name: "index.html", storedPath: "/wt/a/index.html", originalPath: "/tmp/index.html", bytes: 10, createdAt: 1_780_000_000_000, assets: [] }],
} as unknown as Task;

const CASES: Record<string, Task> = {
	"archived-full": archivedFull,
	"archived-minimal": { ...base, status: "cancelled" },
	draft: { ...base, description: "Draft body that differs from the title", labelIds: ["l1"] },
};

const WIDTHS = { desktop: 1440, phone: 390 };

beforeEach(() => {
	// Dates render through the host's locale and time zone: pin them so CI and laptops agree.
	vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (this: Date) { return this.toISOString(); });
	vi.spyOn(Date.prototype, "toLocaleDateString").mockImplementation(function (this: Date) { return this.toISOString().slice(0, 10); });
	vi.spyOn(Date.prototype, "toLocaleTimeString").mockImplementation(function (this: Date) { return this.toISOString().slice(11, 16); });
	vi.useFakeTimers({ toFake: ["Date"], now: new Date("2025-02-01T00:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// Pins the modal's markup byte for byte (both views, both widths), so moving its body onto a slot
// cannot change a pixel. Regenerate only when a visible change to the modal is the point.
describe("TaskDetailModal markup parity", () => {
	it.each(Object.entries(WIDTHS).flatMap(([width, px]) => Object.keys(CASES).map((name) => [name, width, px] as const)))(
		"%s at %s width",
		async (name, width, px) => {
			Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
			const { container } = render(
				<I18nProvider>
					<TaskDetailModal task={CASES[name]} project={project} dispatch={vi.fn()} onClose={vi.fn()} onLaunchVariants={vi.fn()} navigate={vi.fn()} />
				</I18nProvider>,
			);
			await act(async () => {});
			// React useId values depend on how many components rendered before: not markup the user sees.
			await expect(container.innerHTML.replace(/_r_[0-9a-z]+_/g, "_r_")).toMatchFileSnapshot(`./__snapshots__/task-detail-${name}-${width}.html`);
		},
	);
});
