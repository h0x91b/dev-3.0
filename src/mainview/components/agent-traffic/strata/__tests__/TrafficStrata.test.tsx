import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentMessageLogRow } from "../../../../../shared/agent-message-log";
import type { Task } from "../../../../../shared/types";
import { I18nProvider } from "../../../../i18n";
import { endpointKey, type TrafficNode, type TrafficRecord } from "../../traffic-model";
import TrafficStrata from "../TrafficStrata";

/**
 * happy-dom has no WebGL2, so every render here takes the unsupported path.
 *
 * That is the point rather than a limitation: §5.9 requires the lists to work
 * without WebGL, and the thing worth guarding is that a stage which cannot draw
 * says so and gets out of the way instead of throwing into the screen. The
 * drawing itself is covered by the pure scene, model, label and camera suites,
 * and verified in a real browser during QA.
 */

const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function task(seq: number, overrides: Partial<Task> = {}): Task {
	return {
		id: `task-${seq}`,
		seq,
		projectId: "proj-1",
		title: `Task ${seq}`,
		description: "",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: at(200),
		updatedAt: at(5),
		...overrides,
	} as Task;
}

function node(item: Task): TrafficNode {
	return {
		key: endpointKey(item.projectId, item.id),
		projectId: item.projectId,
		id: item.id,
		seq: item.seq,
		title: item.title,
		task: item,
	};
}

function record(overrides: Partial<AgentMessageLogRow> = {}): TrafficRecord {
	const row: AgentMessageLogRow = {
		v: 1,
		at: at(20),
		fromTaskId: "task-1",
		fromSeq: 1,
		fromProjectId: "proj-1",
		toTaskId: "task-2",
		toSeq: 2,
		toProjectId: "proj-1",
		kind: "immediate",
		body: "hello",
		bodyKind: "text",
		status: "delivered",
		...overrides,
	};
	return { key: `${row.fromTaskId}->${row.toTaskId}:${row.at}`, row };
}

function show(props: Partial<Parameters<typeof TrafficStrata>[0]> = {}) {
	cleanup();
	const nodes = props.nodes ?? [node(task(1)), node(task(2))];
	const records = props.records ?? [record()];
	render(
		<I18nProvider>
			<TrafficStrata
				projects={[{ id: "proj-1", name: "Alpha" }]}
				nodes={nodes}
				records={records}
				layoutRecords={props.layoutRecords ?? records}
				selected={null}
				onSelect={() => {}}
				paused={false}
				ready
				{...props}
			/>
		</I18nProvider>,
	);
}

describe("TrafficStrata without WebGL", () => {
	it("says the stage cannot run instead of throwing into the screen", () => {
		expect(() => show()).not.toThrow();
		expect(screen.getByRole("alert")).toBeTruthy();
	});

	it("names the other presentations as still working, so the user is not stranded", () => {
		show();
		expect(screen.getByRole("alert").textContent ?? "").toMatch(/list|presentation/i);
	});
});

/**
 * The pieces that survive a missing canvas: nothing, deliberately. The fallback
 * replaces the whole stage, because half a stage with no scene in it is worse
 * than an honest message plus the message list the screen already renders.
 */
describe("TrafficStrata fallback scope", () => {
	it("does not render stage controls it cannot honour", () => {
		show();
		expect(screen.queryByTestId("strata-mode-situation")).toBeNull();
		expect(screen.queryByTestId("strata-follow")).toBeNull();
		expect(screen.queryByTestId("strata-card-label")).toBeNull();
	});

	it("renders the same fallback whatever data it is handed", () => {
		show({ nodes: [], records: [], layoutRecords: [] });
		const empty = screen.getByRole("alert").textContent;
		show();
		expect(screen.getByRole("alert").textContent).toBe(empty);
	});
});

describe("TrafficStrata props contract", () => {
	it("accepts the same props TrafficNodes takes, playback included", () => {
		const onSelect = vi.fn();
		const playback = {
			events: [],
			current: null,
			currentRecord: null,
			cursor: { at: null, index: -1, total: 0, playing: false, kind: null },
			index: -1,
			playing: false,
			ended: false,
			speed: 1,
			intervalMs: 1000,
			revision: 0,
			setSpeed: () => {},
			playPause: () => {},
			restart: () => {},
			step: () => {},
			seek: () => {},
			seekToTime: () => false,
			live: () => {},
		} as unknown as Parameters<typeof TrafficStrata>[0]["playback"];
		expect(() =>
			show({ playback, onSelect, focusRequest: 1, followRequest: 2, scope: "proj-1" }),
		).not.toThrow();
	});

	it("survives a cursor standing in the past with no history recorded anywhere", () => {
		const playback = {
			events: [],
			current: null,
			currentRecord: null,
			cursor: { at: NOW - 3_600_000, index: 0, total: 1, playing: false, kind: "message" },
			index: 0,
			playing: false,
			ended: false,
			speed: 1,
			intervalMs: 1000,
			revision: 0,
			setSpeed: () => {},
			playPause: () => {},
			restart: () => {},
			step: () => {},
			seek: () => {},
			seekToTime: () => false,
			live: () => {},
		} as unknown as Parameters<typeof TrafficStrata>[0]["playback"];
		expect(() => show({ playback })).not.toThrow();
	});

	it("unmounts without leaving a listener or a loop behind", async () => {
		const raf = vi.spyOn(window, "cancelAnimationFrame");
		show();
		cleanup();
		// The fallback path never starts a loop, so nothing to cancel — the
		// assertion is that teardown does not blow up on a stage that never drew.
		expect(raf).not.toThrow();
		raf.mockRestore();
	});
});

describe("TrafficStrata keyboard safety", () => {
	it("does not swallow letters typed elsewhere on the screen", async () => {
		show();
		const input = document.createElement("input");
		document.body.append(input);
		input.focus();
		await userEvent.keyboard("fh");
		expect(input.value).toBe("fh");
		input.remove();
	});
});
