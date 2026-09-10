import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessageLogRow } from "../../shared/agent-message-log";
import type { Task, TaskMovement, TaskStatus } from "../../shared/types";
import { I18nProvider } from "../i18n";
import TrafficNodes from "../components/agent-traffic/TrafficNodes";
import { CELEBRATION_MS } from "../components/agent-traffic/completion-celebration";
import {
	endpointKey,
	trafficRecords,
	type TrafficNode,
} from "../components/agent-traffic/traffic-model";
import type {
	TrafficTaskEvent,
	TrafficTimelineEvent,
} from "../components/agent-traffic/traffic-timeline";
import type { useTrafficPlayback } from "../components/agent-traffic/useTrafficPlayback";

const NOW = Date.parse("2026-09-09T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function movement(
	id: string,
	minutes: number,
	to: TaskStatus,
	kind: TaskMovement["kind"] = "status",
): TaskMovement {
	return { id, at: at(minutes), kind, to };
}

function task(id: string, seq: number, movements: TaskMovement[]): Task {
	return {
		id,
		projectId: "project",
		seq,
		title: `Task ${seq}`,
		status: movements[movements.length - 1]?.to ?? "todo",
		movements,
	} as unknown as Task;
}

function node(value: Task): TrafficNode {
	return {
		key: endpointKey(value.projectId, value.id),
		projectId: value.projectId,
		id: value.id,
		seq: value.seq,
		title: `Task ${value.seq}`,
		task: value,
	};
}

const row: AgentMessageLogRow = {
	v: 1,
	at: at(-5),
	fromTaskId: "task-a",
	fromSeq: 1,
	fromProjectId: "project",
	toTaskId: "task-b",
	toSeq: 2,
	toProjectId: "project",
	kind: "immediate",
	subject: "ping",
	body: "ping",
	bodyKind: "text",
	status: "delivered",
} as AgentMessageLogRow;
const records = trafficRecords([row]);

const WORKING = [movement("a0", -90, "todo", "created"), movement("a1", -60, "in-progress")];
const DONE = [...WORKING, movement("a2", 0, "completed")];
const other = task("task-b", 2, [movement("b0", -90, "todo", "created")]);

function playbackStub(
	current: TrafficTimelineEvent | null,
	index: number,
	revision: number,
): ReturnType<typeof useTrafficPlayback> {
	return {
		events: current ? [current] : [],
		current,
		currentRecord: null,
		cursor: {
			at: current?.at ?? null,
			index,
			total: 1,
			playing: false,
			kind: current?.kind ?? null,
		},
		index,
		playing: false,
		ended: false,
		speed: 1,
		intervalMs: 1000,
		revision,
		setSpeed: vi.fn(),
		playPause: vi.fn(),
		restart: vi.fn(),
		step: vi.fn(),
		seek: vi.fn(),
		seekToTime: vi.fn(),
		live: vi.fn(),
	} as unknown as ReturnType<typeof useTrafficPlayback>;
}

function completionEvent(taskValue: Task): TrafficTaskEvent {
	return {
		kind: "task",
		at: NOW,
		key: "task:project:task-a:a2",
		movement: movement("a2", 0, "completed"),
		node: { projectId: "project", taskId: taskValue.id },
		nodeKey: endpointKey("project", taskValue.id),
		seq: 1,
		title: "Task 1",
	};
}

function draw(
	nodes: TrafficNode[],
	playback?: ReturnType<typeof useTrafficPlayback>,
) {
	return (
		<I18nProvider>
			<TrafficNodes
				nodes={nodes}
				records={records}
				layoutRecords={records}
				selected={null}
				onSelect={vi.fn()}
				paused={false}
				ready
				scope="project"
				playback={playback}
			/>
		</I18nProvider>
	);
}

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.setSystemTime(NOW);
});
afterEach(() => {
	vi.useRealTimers();
});

describe("completion celebration on the traffic stage", () => {
	it("stays silent when the screen opens on an already-completed task", () => {
		render(draw([node(task("task-a", 1, DONE)), node(other)]));
		expect(screen.queryByTestId("traffic-celebration")).toBeNull();
	});

	it("celebrates a completion recorded while the stage is open, with the worked duration", () => {
		const { rerender } = render(
			draw([node(task("task-a", 1, WORKING)), node(other)]),
		);
		expect(screen.queryByTestId("traffic-celebration")).toBeNull();

		rerender(draw([node(task("task-a", 1, DONE)), node(other)]));
		const badge = screen.getByTestId("traffic-celebration");
		expect(badge.dataset.basis).toBe("worked");
		expect(badge.textContent).toContain("1h");
	});

	it("celebrates the same movement once, however many times the board re-renders", () => {
		const { rerender } = render(
			draw([node(task("task-a", 1, WORKING)), node(other)]),
		);
		rerender(draw([node(task("task-a", 1, DONE)), node(other)]));
		expect(screen.getByTestId("traffic-celebration")).toBeTruthy();

		act(() => {
			vi.advanceTimersByTime(CELEBRATION_MS + 50);
		});
		expect(screen.queryByTestId("traffic-celebration")).toBeNull();

		// A fresh Task object carrying the same movement log — what a board push
		// delivers — must not fire the celebration a second time.
		rerender(draw([node(task("task-a", 1, DONE)), node(other)]));
		expect(screen.queryByTestId("traffic-celebration")).toBeNull();
	});

	it("labels a completion with no recorded work start as task age, not as work", () => {
		const born = [movement("a0", -90, "todo", "created")];
		const { rerender } = render(draw([node(task("task-a", 1, born)), node(other)]));
		rerender(
			draw([
				node(task("task-a", 1, [...born, movement("a2", 0, "completed")])),
				node(other),
			]),
		);
		expect(screen.getByTestId("traffic-celebration").dataset.basis).toBe("age");
	});

	it("prints no duration at all when the log cannot prove one", () => {
		const truncated = [movement("a5", -30, "review-by-user")];
		const { rerender } = render(
			draw([node(task("task-a", 1, truncated)), node(other)]),
		);
		rerender(
			draw([
				node(task("task-a", 1, [...truncated, movement("a2", 0, "completed")])),
				node(other),
			]),
		);
		const badge = screen.getByTestId("traffic-celebration");
		expect(badge.dataset.basis).toBe("unknown");
		expect(badge.textContent).toBe("Completed");
	});

	it("celebrates when replay crosses the completion forward", () => {
		const completed = task("task-a", 1, DONE);
		const event = completionEvent(completed);
		const { rerender } = render(
			draw([node(completed), node(other)], playbackStub(null, -1, 0)),
		);
		expect(screen.queryByTestId("traffic-celebration")).toBeNull();

		rerender(draw([node(completed), node(other)], playbackStub(event, 3, 1)));
		expect(screen.getByTestId("traffic-celebration")).toBeTruthy();
	});

	it("stays silent when replay is merely parked on the completion", () => {
		const completed = task("task-a", 1, DONE);
		const event = completionEvent(completed);
		const { rerender } = render(
			draw([node(completed), node(other)], playbackStub(event, 3, 1)),
		);
		act(() => {
			vi.advanceTimersByTime(CELEBRATION_MS + 50);
		});
		expect(screen.queryByTestId("traffic-celebration")).toBeNull();

		// Same index, new revision: a re-render standing still, not a crossing.
		rerender(draw([node(completed), node(other)], playbackStub(event, 3, 2)));
		expect(screen.queryByTestId("traffic-celebration")).toBeNull();
	});

	it("stays silent when replay scrubs backwards over the completion", () => {
		const completed = task("task-a", 1, DONE);
		const event = completionEvent(completed);
		const { rerender } = render(
			draw([node(completed), node(other)], playbackStub(null, 9, 1)),
		);
		rerender(draw([node(completed), node(other)], playbackStub(event, 3, 2)));
		expect(screen.queryByTestId("traffic-celebration")).toBeNull();
	});
});
