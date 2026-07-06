import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import GoToPaletteModal, { taskRecencyBucket } from "../GoToPaletteModal";
import type { Project, Task } from "../../../shared/types";

// Timestamps anchored on the real local midnight (the same anchor the component
// uses via Date.now()), so bucketing is deterministic regardless of timezone or
// when the suite runs.
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

const TASKS: Task[] = [
	task("t1", "p1", "Fix login redirect", TODAY),
	task("t2", "p2", "Add rate limiter", YESTERDAY),
];

const PROJECT_BY_ID = new Map(PROJECTS.map((p) => [p.id, p]));

function renderModal(
	handlers: {
		onSelectProject?: (id: string) => void;
		onSelectTask?: (t: Task) => void;
		onClose?: () => void;
	} = {},
) {
	const onSelectProject = handlers.onSelectProject ?? vi.fn();
	const onSelectTask = handlers.onSelectTask ?? vi.fn();
	const onClose = handlers.onClose ?? vi.fn();
	render(
		<I18nProvider>
			<GoToPaletteModal
				projects={PROJECTS}
				tasks={TASKS}
				projectById={PROJECT_BY_ID}
				onSelectProject={onSelectProject}
				onSelectTask={onSelectTask}
				onClose={onClose}
			/>
		</I18nProvider>,
	);
	return { onSelectProject, onSelectTask, onClose };
}

beforeEach(() => {
	document.body.innerHTML = "";
});

describe("GoToPaletteModal", () => {
	it("traps focus inside the dialog on open", () => {
		renderModal();
		const dialog = screen.getByRole("dialog");
		expect(dialog.contains(document.activeElement)).toBe(true);
	});

	it("lists all tasks and projects initially, tasks first", () => {
		renderModal();
		const options = screen.getAllByRole("option");
		// Tasks come before projects (fixed section order — task switching is primary).
		expect(options[0].textContent).toContain("Fix login redirect");
		expect(options).toHaveLength(PROJECTS.length + TASKS.length);
		// The last rows are the projects section ("users-service" also appears as t1's badge).
		expect(options[TASKS.length].textContent).toContain("users-service");
		expect(screen.getByText("Add rate limiter")).toBeTruthy();
	});

	it("renders date-bucket task headers and the Projects header", () => {
		renderModal();
		expect(screen.getByText("Today")).toBeTruthy();
		expect(screen.getByText("Yesterday")).toBeTruthy();
		expect(screen.getByText("Projects")).toBeTruthy();
	});

	it("buckets tasks into date sections in Today → Yesterday → This week → Older → Projects order", () => {
		render(
			<I18nProvider>
				<GoToPaletteModal
					projects={PROJECTS}
					tasks={[
						task("older", "p1", "Older task", OLDER),
						task("today", "p1", "Today task", TODAY),
						task("week", "p1", "Week task", THIS_WEEK),
						task("yst", "p1", "Yesterday task", YESTERDAY),
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
		expect(headers).toEqual(["Today", "Yesterday", "This week", "Older", "Projects"]);
	});

	it("shows the project badge on task rows", () => {
		renderModal();
		const taskRow = screen.getByText("Fix login redirect").closest("[role=option]");
		expect(taskRow?.textContent).toContain("users-service");
	});

	it("filters both projects and tasks as the user types", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.type(screen.getByRole("textbox"), "login");
		const options = screen.getAllByRole("option");
		expect(options).toHaveLength(1);
		expect(options[0].textContent).toContain("Fix login redirect");
	});

	it("opens a project on Enter over a project match", async () => {
		const user = userEvent.setup();
		const { onSelectProject } = renderModal();
		await user.type(screen.getByRole("textbox"), "users");
		await user.keyboard("{Enter}");
		expect(onSelectProject).toHaveBeenCalledWith("p1");
	});

	it("opens a task on click", async () => {
		const user = userEvent.setup();
		const { onSelectTask } = renderModal();
		await user.click(screen.getByText("Add rate limiter"));
		expect(onSelectTask).toHaveBeenCalledWith(TASKS[1]);
	});

	it("navigates across the flat row list with arrow keys, crossing the section header", async () => {
		const user = userEvent.setup();
		const { onSelectProject } = renderModal();
		// Rows: t1, t2, p1, p2, p3. Two ArrowDowns cross the Tasks→Projects header to p1.
		await user.keyboard("{ArrowDown}{ArrowDown}");
		await user.keyboard("{Enter}");
		expect(onSelectProject).toHaveBeenCalledWith("p1");
	});

	it("shows an empty state when nothing matches", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.type(screen.getByRole("textbox"), "zzzzz");
		expect(screen.queryAllByRole("option")).toHaveLength(0);
		expect(screen.getByText("No matching projects or tasks")).toBeTruthy();
	});

	it("closes on Escape", async () => {
		const user = userEvent.setup();
		const { onClose } = renderModal();
		await user.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});

	it("renders the ⌘N badge from the board index, not the display row", () => {
		render(
			<I18nProvider>
				<GoToPaletteModal
					projects={[PROJECTS[2], PROJECTS[0], PROJECTS[1]]}
					tasks={[]}
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
