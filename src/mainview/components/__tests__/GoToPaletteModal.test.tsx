import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import GoToPaletteModal, { taskRecencyBucket } from "../GoToPaletteModal";
import type { Project, Task } from "../../../shared/types";

// Timestamps anchored on the real local midnight (the same anchor the component
// uses via Date.now()), so date bucketing is deterministic across timezones/runs.
const DAY = 86_400_000;
const startOfToday = (() => {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	return d.getTime();
})();
const iso = (ms: number) => new Date(ms).toISOString();
const TODAY = iso(Date.now());
const YESTERDAY = iso(startOfToday - 12 * 3_600_000);
const THIS_WEEK = iso(startOfToday - 3 * DAY);
const OLDER = iso(startOfToday - 30 * DAY);

function project(id: string, name: string): Project {
	return {
		id,
		name,
		path: `/tmp/${id}`,
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "",
	};
}

function task(id: string, projectId: string, title: string, updatedAt = TODAY): Task {
	return {
		id,
		seq: 1,
		projectId,
		title,
		description: "",
		status: "in-progress",
		createdAt: "",
		updatedAt,
	} as Task;
}

const PROJECTS: Project[] = [
	project("p1", "users-service"),
	project("p2", "auth-gateway"),
	project("p3", "billing"),
];
// All-projects tasks ("All tasks" mode).
const ALL_TASKS: Task[] = [
	task("t1", "p1", "Fix login redirect", TODAY),
	task("t2", "p2", "Add rate limiter", YESTERDAY),
];
// Current-project tasks ("This project" mode) — both in the p1 project.
const PROJECT_TASKS: Task[] = [
	task("pt1", "p1", "Project alpha task", TODAY),
	task("pt2", "p1", "Project beta task", TODAY),
];
const PROJECT_BY_ID = new Map(PROJECTS.map((p) => [p.id, p]));

function renderModal(overrides: Partial<React.ComponentProps<typeof GoToPaletteModal>> = {}) {
	const onSelectProject = vi.fn();
	const onSelectTask = vi.fn();
	const onClose = vi.fn();
	render(
		<I18nProvider>
			<GoToPaletteModal
				projects={PROJECTS}
				tasks={ALL_TASKS}
				projectTasks={PROJECT_TASKS}
				hasCurrentProject
				projectById={PROJECT_BY_ID}
				onSelectProject={onSelectProject}
				onSelectTask={onSelectTask}
				onClose={onClose}
				{...overrides}
			/>
		</I18nProvider>,
	);
	return { onSelectProject, onSelectTask, onClose };
}

const seg = (name: string) => screen.getByRole("button", { name });

beforeEach(() => {
	localStorage.clear();
});
afterEach(() => cleanup());

describe("GoToPaletteModal — modes", () => {
	it("opens in Projects mode by default and lists projects, not tasks", () => {
		renderModal();
		expect(seg("Projects").getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByText("users-service")).toBeTruthy();
		expect(screen.queryByText("Fix login redirect")).toBeNull();
	});

	it("shows all three mode segments when a project is in view", () => {
		renderModal();
		expect(seg("Projects")).toBeTruthy();
		expect(seg("This project")).toBeTruthy();
		expect(seg("All tasks")).toBeTruthy();
	});

	it("hides the This-project mode when no project is in view", () => {
		renderModal({ hasCurrentProject: false });
		expect(seg("Projects")).toBeTruthy();
		expect(seg("All tasks")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "This project" })).toBeNull();
	});

	it("cycles modes on a lone Shift tap: Projects → This project → All tasks", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.keyboard("{Shift>}{/Shift}");
		expect(seg("This project").getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByText("Project alpha task")).toBeTruthy();
		await user.keyboard("{Shift>}{/Shift}");
		expect(seg("All tasks").getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByText("Add rate limiter")).toBeTruthy();
	});

	it("does NOT cycle when Shift is used to type a capital", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.keyboard("{Shift>}A{/Shift}");
		expect(seg("Projects").getAttribute("aria-pressed")).toBe("true"); // still Projects
		expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("A");
	});

	it("switches mode when a segment is clicked", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.click(seg("This project"));
		expect(seg("This project").getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByText("Project alpha task")).toBeTruthy();
	});

	it("remembers the last-used mode via localStorage", () => {
		localStorage.setItem("dev3-gotopalette-mode", "all-tasks");
		renderModal();
		expect(seg("All tasks").getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByText("Fix login redirect")).toBeTruthy();
	});

	it("falls back to All tasks when the remembered This-project mode is unavailable", () => {
		localStorage.setItem("dev3-gotopalette-mode", "project-tasks");
		renderModal({ hasCurrentProject: false });
		expect(seg("All tasks").getAttribute("aria-pressed")).toBe("true");
	});
});

describe("GoToPaletteModal — rows", () => {
	it("shows a project badge on task rows in All-tasks mode", () => {
		localStorage.setItem("dev3-gotopalette-mode", "all-tasks");
		renderModal();
		const allRow = screen.getByText("Fix login redirect").closest("[role=option]");
		expect(allRow?.textContent).toContain("users-service"); // badge present
	});

	it("omits the project badge in This-project mode", () => {
		localStorage.setItem("dev3-gotopalette-mode", "project-tasks");
		renderModal();
		const projRow = screen.getByText("Project alpha task").closest("[role=option]");
		expect(projRow?.textContent).not.toContain("users-service"); // badge omitted
	});

	it("buckets task modes by date (Today / Yesterday headers)", () => {
		localStorage.setItem("dev3-gotopalette-mode", "all-tasks");
		renderModal();
		expect(screen.getByText("Today")).toBeTruthy();
		expect(screen.getByText("Yesterday")).toBeTruthy();
	});

	it("orders date buckets Today → Yesterday → This week → Older", () => {
		localStorage.setItem("dev3-gotopalette-mode", "all-tasks");
		render(
			<I18nProvider>
				<GoToPaletteModal
					projects={PROJECTS}
					projectTasks={[]}
					hasCurrentProject={false}
					tasks={[
						task("o", "p1", "Older task", OLDER),
						task("t", "p1", "Today task", TODAY),
						task("w", "p1", "Week task", THIS_WEEK),
						task("y", "p1", "Yesterday task", YESTERDAY),
					]}
					projectById={PROJECT_BY_ID}
					onSelectProject={vi.fn()}
					onSelectTask={vi.fn()}
					onClose={vi.fn()}
				/>
			</I18nProvider>,
		);
		const headers = [...document.querySelectorAll('[data-testid="go-to-palette"] [role=presentation]')].map(
			(h) => h.textContent,
		);
		expect(headers).toEqual(["Today", "Yesterday", "This week", "Older"]);
	});

	it("reserves top scroll-margin only on rows that sit under a section header", () => {
		localStorage.setItem("dev3-gotopalette-mode", "project-tasks");
		renderModal(); // PROJECT_TASKS are both Today → first has the header, second does not
		const options = screen.getAllByRole("option");
		expect(options[0].className).toContain("scroll-mt-9");
		expect(options[1].className).not.toContain("scroll-mt-9");
	});
});

describe("GoToPaletteModal — selection", () => {
	it("opens a project on Enter over a project match (Projects mode)", async () => {
		const user = userEvent.setup();
		const { onSelectProject } = renderModal();
		await user.type(screen.getByRole("textbox"), "users");
		await user.keyboard("{Enter}");
		expect(onSelectProject).toHaveBeenCalledWith("p1");
	});

	it("opens a task on click (All-tasks mode)", async () => {
		localStorage.setItem("dev3-gotopalette-mode", "all-tasks");
		const user = userEvent.setup();
		const { onSelectTask } = renderModal();
		await user.click(screen.getByText("Fix login redirect"));
		expect(onSelectTask).toHaveBeenCalledWith(ALL_TASKS[0]);
	});

	it("closes on Escape", async () => {
		const user = userEvent.setup();
		const { onClose } = renderModal();
		await user.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});

	it("traps focus inside the dialog on open", () => {
		renderModal();
		expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
	});
});

describe("GoToPaletteModal — project ⌘N badges", () => {
	it("renders the ⌘N badge from the board index, not the display row", () => {
		render(
			<I18nProvider>
				<GoToPaletteModal
					projects={[PROJECTS[2], PROJECTS[0], PROJECTS[1]]}
					tasks={[]}
					projectTasks={[]}
					hasCurrentProject={false}
					projectById={PROJECT_BY_ID}
					shortcutIndexById={{ p1: 0, p2: 1, p3: 2 }}
					onSelectProject={vi.fn()}
					onSelectTask={vi.fn()}
					onClose={vi.fn()}
				/>
			</I18nProvider>,
		);
		const options = screen.getAllByRole("option");
		expect(options[0].textContent).toContain("billing");
		expect(options[0].textContent).toContain("⌘3");
		expect(options[1].textContent).toContain("⌘1");
	});

	it("renders the builtin Operations board with its bracketed name and ⌘0 badge", () => {
		const ops: Project = { ...project("vp1", "Operations"), kind: "virtual", builtin: true };
		render(
			<I18nProvider>
				<GoToPaletteModal
					projects={[ops, PROJECTS[0]]}
					tasks={[]}
					projectTasks={[]}
					hasCurrentProject={false}
					projectById={
						new Map([
							[ops.id, ops],
							[PROJECTS[0].id, PROJECTS[0]],
						])
					}
					shortcutIndexById={{ p1: 0 }}
					onSelectProject={vi.fn()}
					onSelectTask={vi.fn()}
					onClose={vi.fn()}
				/>
			</I18nProvider>,
		);
		const options = screen.getAllByRole("option");
		expect(options[0].textContent).toContain("[ Operations ]");
		expect(options[0].textContent).toContain("⌘0");
		expect(options[1].textContent).toContain("⌘1");
	});
});

describe("taskRecencyBucket", () => {
	// Local-time (no-Z) strings so the local-midnight anchor is timezone-stable.
	const now = new Date("2026-07-06T12:00:00").getTime();

	it("classifies same-day timestamps as today", () => {
		expect(taskRecencyBucket("2026-07-06T00:05:00", now)).toBe("today");
		expect(taskRecencyBucket("2026-07-06T11:59:00", now)).toBe("today");
	});

	it("classifies the previous calendar day as yesterday", () => {
		expect(taskRecencyBucket("2026-07-05T23:59:00", now)).toBe("yesterday");
		expect(taskRecencyBucket("2026-07-05T00:01:00", now)).toBe("yesterday");
	});

	it("classifies the preceding 7-day window as this week", () => {
		expect(taskRecencyBucket("2026-07-02T10:00:00", now)).toBe("week");
		expect(taskRecencyBucket("2026-06-30T10:00:00", now)).toBe("week");
	});

	it("classifies anything older, blank, or unparsable as older", () => {
		expect(taskRecencyBucket("2026-06-01T10:00:00", now)).toBe("older");
		expect(taskRecencyBucket("", now)).toBe("older");
		expect(taskRecencyBucket("not-a-date", now)).toBe("older");
	});
});
