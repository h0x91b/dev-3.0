import { render, screen, act } from "@testing-library/react";
import TaskCardRail from "../TaskCardRail";
import { I18nProvider } from "../../i18n";
import type { Project } from "../../../shared/types";

const project: Project = {
	id: "p1",
	name: "Test",
	path: "/tmp/test",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

/** Drives the rail's own ResizeObserver, which happy-dom does not provide. */
function installResizeObserver(): { fire: () => void } {
	const callbacks: Array<() => void> = [];
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(cb: () => void) {
				callbacks.push(cb);
			}
			observe() {}
			disconnect() {}
		},
	);
	return { fire: () => callbacks.forEach((cb) => cb()) };
}

function railHeight(px: number) {
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		() => ({ height: px, width: 20, top: 0, left: 0, right: 20, bottom: px, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
	);
}

function renderRail() {
	render(
		<I18nProvider>
			<TaskCardRail
				status="in-progress"
				project={project}
				color="#afbaff"
				canComplete={false}
				completing={false}
				onOpenMenu={vi.fn()}
				onComplete={vi.fn()}
				menuTriggerRef={{ current: null }}
				autoLabel
			/>
		</I18nProvider>,
	);
}

function label(): HTMLElement | null {
	return screen.getByTestId("task-card-rail").querySelector("[class*=vertical-rl]");
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("TaskCardRail autoLabel", () => {
	it("drops the upright word again when the row shrinks back", () => {
		const observer = installResizeObserver();
		railHeight(273); // a sidebar row carrying an overview
		renderRail();
		expect(label()).not.toBeNull();

		// The overview goes away with the task losing focus: the row is short again,
		// so the word must go with it instead of holding the height it needs.
		railHeight(88);
		act(() => observer.fire());
		expect(label()).toBeNull();
	});

	it("keeps the word out of flow so it never props up the height that measures it", () => {
		const observer = installResizeObserver();
		railHeight(273);
		renderRail();
		observer.fire();

		expect(label()!.className).toContain("absolute");
	});

	it("hides the word on a short row from the first paint", () => {
		installResizeObserver();
		railHeight(88);
		renderRail();

		expect(label()).toBeNull();
	});
});
