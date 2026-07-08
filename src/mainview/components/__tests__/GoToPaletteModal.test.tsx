import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import GoToPaletteModal, { recencyBucket, taskRecencyBucket } from "../GoToPaletteModal";
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
	project("p3", "billing"), // "billing" is referenced by no task → a projects-only marker
];
const ALL_TASKS: Task[] = [
	task("t1", "p1", "Fix login redirect", TODAY),
	task("t2", "p2", "Add rate limiter", YESTERDAY),
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
	it("opens in Projects mode by default: projects only, no tasks", () => {
		renderModal();
		expect(seg("Projects").getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByText("billing")).toBeTruthy(); // a project row
		expect(screen.queryByText("Fix login redirect")).toBeNull(); // no tasks
	});

	it("always shows all three mode segments", () => {
		renderModal();
		expect(seg("Projects")).toBeTruthy();
		expect(seg("Both")).toBeTruthy();
		expect(seg("Tasks")).toBeTruthy();
	});

	it("cycles Projects → Both → Tasks on a lone Shift tap", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.keyboard("{Shift>}{/Shift}");
		expect(seg("Both").getAttribute("aria-pressed")).toBe("true");
		// Both = projects AND tasks together.
		expect(screen.getByText("Fix login redirect")).toBeTruthy();
		expect(screen.getByText("billing")).toBeTruthy();
		await user.keyboard("{Shift>}{/Shift}");
		expect(seg("Tasks").getAttribute("aria-pressed")).toBe("true");
		// Tasks = tasks only.
		expect(screen.getByText("Fix login redirect")).toBeTruthy();
		expect(screen.queryByText("billing")).toBeNull();
	});

	it("does NOT cycle when Shift types a capital", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.keyboard("{Shift>}A{/Shift}");
		expect(seg("Projects").getAttribute("aria-pressed")).toBe("true");
		expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("A");
	});

	it("switches mode when a segment is clicked", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.click(seg("Both"));
		expect(seg("Both").getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByText("Fix login redirect")).toBeTruthy();
		expect(screen.getByText("billing")).toBeTruthy();
	});

	it("remembers the last-used mode via localStorage", () => {
		localStorage.setItem("dev3-gotopalette-mode", "tasks");
		renderModal();
		expect(seg("Tasks").getAttribute("aria-pressed")).toBe("true");
		expect(screen.queryByText("billing")).toBeNull();
	});
});

describe("GoToPaletteModal — rows & sections", () => {
	it("Both mode interleaves a recently-accessed project into the task date buckets (no separate Projects section)", () => {
		localStorage.setItem("dev3-gotopalette-mode", "mixed");
		renderModal({ projectAccessTimes: { p3: Date.now() } }); // "billing" opened just now → Today
		const headers = [...document.querySelectorAll('[data-testid="go-to-palette"] [role=presentation]')].map(
			(h) => h.textContent,
		);
		expect(headers).not.toContain("Projects"); // projects fold into date buckets, not a trailing section
		expect(headers[0]).toBe("Today");
		// "billing" (a project) sits in the Today bucket — above the Yesterday header.
		const nodes = [
			...document.querySelectorAll(
				'[data-testid="go-to-palette"] [role=presentation], [data-testid="go-to-palette"] [role=option]',
			),
		];
		const billingIdx = nodes.findIndex((n) => n.textContent?.includes("billing"));
		const yesterdayIdx = nodes.findIndex((n) => n.getAttribute("role") === "presentation" && n.textContent === "Yesterday");
		expect(billingIdx).toBeGreaterThanOrEqual(0);
		expect(yesterdayIdx).toBeGreaterThan(billingIdx);
	});

	it("Both mode drops never-accessed projects into Older", () => {
		localStorage.setItem("dev3-gotopalette-mode", "mixed");
		renderModal(); // no projectAccessTimes → every project recency 0 → Older
		const nodes = [
			...document.querySelectorAll(
				'[data-testid="go-to-palette"] [role=presentation], [data-testid="go-to-palette"] [role=option]',
			),
		];
		const olderIdx = nodes.findIndex((n) => n.getAttribute("role") === "presentation" && n.textContent === "Older");
		const billingIdx = nodes.findIndex((n) => n.textContent?.includes("billing"));
		expect(olderIdx).toBeGreaterThanOrEqual(0);
		expect(billingIdx).toBeGreaterThan(olderIdx); // billing appears after the Older header
	});

	it("Tasks mode buckets by date and shows a project badge per row", () => {
		localStorage.setItem("dev3-gotopalette-mode", "tasks");
		renderModal();
		expect(screen.getByText("Today")).toBeTruthy();
		expect(screen.getByText("Yesterday")).toBeTruthy();
		const row = screen.getByText("Fix login redirect").closest("[role=option]");
		expect(row?.textContent).toContain("users-service"); // project badge
	});

	it("ranks a task by last-opened when it beats updatedAt (worked-in-today → Today)", () => {
		localStorage.setItem("dev3-gotopalette-mode", "tasks");
		// t2 ("Add rate limiter") was last UPDATED yesterday but OPENED just now.
		renderModal({ taskAccessTimes: { t2: Date.now() } });
		const nodes = [
			...document.querySelectorAll(
				'[data-testid="go-to-palette"] [role=presentation], [data-testid="go-to-palette"] [role=option]',
			),
		];
		let cur: string | null = null;
		let bucket: string | null = null;
		for (const n of nodes) {
			if (n.getAttribute("role") === "presentation") {
				cur = n.textContent;
				continue;
			}
			if (n.textContent?.includes("Add rate limiter")) bucket = cur;
		}
		expect(bucket).toBe("Today"); // promoted by last-opened, despite updatedAt = yesterday
	});

	it("orders task date buckets Today → Yesterday → This week → Older", () => {
		localStorage.setItem("dev3-gotopalette-mode", "tasks");
		render(
			<I18nProvider>
				<GoToPaletteModal
					projects={[]}
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
		localStorage.setItem("dev3-gotopalette-mode", "tasks");
		render(
			<I18nProvider>
				<GoToPaletteModal
					projects={[]}
					tasks={[task("a", "p1", "Alpha", TODAY), task("b", "p1", "Beta", TODAY)]}
					projectById={PROJECT_BY_ID}
					onSelectProject={vi.fn()}
					onSelectTask={vi.fn()}
					onClose={vi.fn()}
				/>
			</I18nProvider>,
		);
		const options = screen.getAllByRole("option");
		expect(options[0].className).toContain("scroll-mt-9"); // first-in-bucket → header above
		expect(options[1].className).not.toContain("scroll-mt-9"); // same bucket, no header
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

	it("opens a task on click (Tasks mode)", async () => {
		localStorage.setItem("dev3-gotopalette-mode", "tasks");
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

describe("recencyBucket", () => {
	const now = new Date("2026-07-06T12:00:00").getTime();
	const DAY = 86_400_000;

	it("buckets an epoch-ms timestamp by local-day distance", () => {
		expect(recencyBucket(now, now)).toBe("today");
		expect(recencyBucket(now - DAY, now)).toBe("yesterday");
		expect(recencyBucket(now - 3 * DAY, now)).toBe("week");
		expect(recencyBucket(now - 30 * DAY, now)).toBe("older");
	});

	it("treats 0 / NaN (never accessed) as older", () => {
		expect(recencyBucket(0, now)).toBe("older");
		expect(recencyBucket(Number.NaN, now)).toBe("older");
	});
});
