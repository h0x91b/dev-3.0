import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessageLogRow } from "../../shared/agent-message-log";
import type { NotificationLogRow } from "../../shared/notification-log";
import type { Task, TaskMovement, TaskStatus } from "../../shared/types";
import { I18nProvider } from "../i18n";
import { notificationEvents } from "../notification-event";
import TrafficNodes from "../components/agent-traffic/TrafficNodes";
import {
	notificationCloud,
	notificationCloudPuffs,
} from "../components/agent-traffic/notification-cloud";
import {
	endpointKey,
	trafficRecords,
	type TrafficNode,
} from "../components/agent-traffic/traffic-model";
import type { TrafficTimelineEvent } from "../components/agent-traffic/traffic-timeline";
import type { useTrafficPlayback } from "../components/agent-traffic/useTrafficPlayback";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function movement(id: string, minutes: number, to: TaskStatus, kind: TaskMovement["kind"] = "status"): TaskMovement {
	return { id, at: at(minutes), kind, to };
}

function task(id: string, seq: number): Task {
	return {
		id,
		projectId: "project",
		seq,
		title: `Task ${seq}`,
		status: "in-progress",
		movements: [movement(`${id}-0`, -90, "todo", "created"), movement(`${id}-1`, -60, "in-progress")],
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

const message: AgentMessageLogRow = {
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
const records = trafficRecords([message]);

function notificationRow(over: Partial<NotificationLogRow> = {}): NotificationLogRow {
	return {
		v: 1,
		at: at(0),
		mode: "toast",
		level: "success",
		message: "backfill finished, 4812 rows written",
		taskId: "task-b",
		taskSeq: 2,
		projectId: "project",
		sourceProjectId: "project",
		sourceTaskId: "task-a",
		sourceSeq: 1,
		outcome: "delivered",
		...over,
	} as NotificationLogRow;
}

/** The notification arm of the timeline, as the playback cursor hands it over. */
function notificationEvent(over: Partial<NotificationLogRow> = {}): TrafficTimelineEvent {
	const [event] = notificationEvents([notificationRow(over)]);
	return { kind: "notification", at: event.at, key: event.key, notification: event };
}

function playbackStub(current: TrafficTimelineEvent | null): ReturnType<typeof useTrafficPlayback> {
	return {
		events: current ? [current] : [],
		current,
		currentRecord: null,
		cursor: { at: current?.at ?? null, index: 0, total: 1, playing: false, kind: current?.kind ?? null },
		index: 0,
		playing: false,
		ended: false,
		speed: 1,
		intervalMs: 1000,
		revision: 1,
		setSpeed: vi.fn(),
		playPause: vi.fn(),
		restart: vi.fn(),
		step: vi.fn(),
		seek: vi.fn(),
		seekToTime: vi.fn(),
		live: vi.fn(),
	} as unknown as ReturnType<typeof useTrafficPlayback>;
}

function draw(playback?: ReturnType<typeof useTrafficPlayback>) {
	return (
		<I18nProvider>
			<TrafficNodes
				nodes={[node(task("task-a", 1)), node(task("task-b", 2))]}
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

describe("the notification cloud outline", () => {
	it("is a single closed outline, never a union of circles", () => {
		const { path } = notificationCloud(220, 34, false);
		// One `M` and one `Z`: a second subpath would be a lobe, and a lobe is the
		// repeated primitive this shape exists to avoid.
		expect(path.match(/M/g)).toHaveLength(1);
		expect(path.match(/Z/g)).toHaveLength(1);
		expect(path).toContain("C");
		expect(path).not.toContain("NaN");
	});

	it("insets the content past the corner arc, not merely inside the drawn box", () => {
		const cloud = notificationCloud(220, 34, false);
		const rightGap = cloud.width - (cloud.content.x + cloud.content.width);
		// Flush against the outline the text pokes through the wave and the corner —
		// seen in the browser before the padding existed. The gap has to clear the
		// corner radius, not just the stroke.
		expect(cloud.content.x).toBeGreaterThan(6);
		expect(rightGap).toBeGreaterThan(6);
		expect(cloud.content.y).toBeGreaterThan(0);
		expect(cloud.content.y + cloud.content.height).toBeLessThan(cloud.height);
	});

	it("spends less height on the wave when compact, for the same text", () => {
		const full = notificationCloud(220, 34, false);
		const compact = notificationCloud(220, 34, true);
		expect(compact.height).toBeLessThan(full.height);
		// The wave survives the shrink rather than flattening into a rounded box.
		expect(compact.path).toContain("C");
	});

	it("trails exactly two puffs toward the card, shrinking as they go", () => {
		const cloud = notificationCloud(220, 34, false);
		// The card sits well to the left of a cloud leaning off its shoulder.
		const puffs = notificationCloudPuffs(cloud, 40, false);
		expect(puffs).toHaveLength(2);
		const [near, far] = puffs;
		// Smaller the further it gets, or it reads as a second cloud rather than a
		// thought trailing off.
		expect(far.rx).toBeLessThan(near.rx);
		expect(far.ry).toBeLessThan(near.ry);
		// Diagonal, not a vertical column: straight down reads as a leader line.
		expect(far.cx).toBeLessThan(near.cx);
		expect(far.cy).toBeGreaterThan(near.cy);
		// Below the body, and inside the drawn box on every side.
		expect(near.cy - near.ry).toBeGreaterThan(cloud.content.y + cloud.content.height);
		expect(far.cy + far.ry).toBeLessThanOrEqual(cloud.height);
		expect(far.cx - far.rx).toBeGreaterThan(0);
	});

	it("aims the far puff at the card, wherever the card is", () => {
		const cloud = notificationCloud(220, 34, false);
		// The far puff lands ON the target, so the trail ends over the card and not
		// at a fixed offset that happens to miss it.
		expect(notificationCloudPuffs(cloud, 40, false)[1].cx).toBeCloseTo(40);
		expect(notificationCloudPuffs(cloud, 200, false)[1].cx).toBeCloseTo(200);
		// A card directly underneath gets a straight trail rather than a bent one.
		const straight = notificationCloudPuffs(cloud, cloud.width / 2, false);
		expect(straight[0].cx).toBeCloseTo(cloud.width / 2);
		expect(straight[1].cx).toBeCloseTo(cloud.width / 2);
	});

	it("flips the trail above the body when the cloud hangs below its card", () => {
		const above = notificationCloud(220, 34, false, false);
		const below = notificationCloud(220, 34, false, true);
		// Same box either way — only the side the trail leaves from changes.
		expect(below.height).toBe(above.height);
		expect(below.content.y).toBeGreaterThan(above.content.y);
		const puffs = notificationCloudPuffs(below, 40, false);
		for (const puff of puffs) {
			expect(puff.cy).toBeLessThan(below.content.y);
			expect(puff.cy - puff.ry).toBeGreaterThanOrEqual(0);
		}
		// Still the far one that is further out.
		expect(puffs[1].cy).toBeLessThan(puffs[0].cy);
	});

	it("keeps the compact trail smaller than the full one", () => {
		const full = notificationCloud(220, 34, false);
		const compact = notificationCloud(220, 34, true);
		expect(notificationCloudPuffs(compact, 40, true)[0].rx).toBeLessThan(
			notificationCloudPuffs(full, 40, false)[0].rx,
		);
	});

	it("survives a box narrower than its own corners without a negative step", () => {
		const { path } = notificationCloud(6, 14, true);
		expect(path).not.toContain("NaN");
		expect(path.match(/M/g)).toHaveLength(1);
	});
});

describe("the notification preview on the traffic stage", () => {
	it("previews the text and its level over the card that sent it", () => {
		render(draw(playbackStub(notificationEvent())));
		const cloud = screen.getByTestId("traffic-notification-cloud");
		expect(cloud.dataset.level).toBe("success");
		expect(cloud.textContent).toContain("backfill finished, 4812 rows written");
		expect(cloud.textContent).toContain("success");
		// The trail is what says WHICH card this belongs to, so it is not optional
		// decoration: a cloud with no puffs floats unattributed.
		expect(cloud.querySelectorAll(".traffic-notification-cloud-puff")).toHaveLength(2);
	});

	it("marks an error apart from an info, in words and not only in colour", () => {
		const { rerender } = render(draw(playbackStub(notificationEvent({ level: "error" }))));
		expect(screen.getByTestId("traffic-notification-cloud").textContent).toContain("error");

		rerender(draw(playbackStub(notificationEvent({ level: "info" }))));
		expect(screen.getByTestId("traffic-notification-cloud").textContent).toContain("info");
	});

	it("shows nothing on the stage when the archive recorded no sender", () => {
		render(draw(playbackStub(notificationEvent({ sourceTaskId: null }))));
		expect(screen.queryByTestId("traffic-notification-cloud")).toBeNull();
	});

	it("shows nothing while the cursor is on a message rather than a notification", () => {
		render(draw(playbackStub(null)));
		expect(screen.queryByTestId("traffic-notification-cloud")).toBeNull();
	});
});

/** Live: the cursor stands nowhere, so `index` is -1 and `current` is null. */
function livePlayback(events: TrafficTimelineEvent[]): ReturnType<typeof useTrafficPlayback> {
	return {
		...playbackStub(null),
		events,
		index: -1,
		cursor: { at: null, index: -1, total: events.length, playing: false, kind: null },
	} as unknown as ReturnType<typeof useTrafficPlayback>;
}

/** An arrival stamped against the real clock, which is what freshness is measured on. */
function arrival(msAgo: number, over: Partial<NotificationLogRow> = {}): TrafficTimelineEvent {
	return notificationEvent({ at: new Date(Date.now() - msAgo).toISOString(), ...over });
}

describe("the notification preview in Live Follow", () => {
	afterEach(() => vi.useRealTimers());

	it("previews a notification that arrives while Live is running", () => {
		const { rerender } = render(draw(livePlayback([])));
		expect(screen.queryByTestId("traffic-notification-cloud")).toBeNull();

		rerender(draw(livePlayback([arrival(200)])));
		const cloud = screen.getByTestId("traffic-notification-cloud");
		expect(cloud.dataset.level).toBe("success");
		expect(cloud.textContent).toContain("backfill finished, 4812 rows written");
	});

	it("stays silent on the first archive read, however much it carries", () => {
		render(
			draw(
				livePlayback([
					arrival(400, { message: "one" }),
					arrival(300, { message: "two" }),
					arrival(200, { message: "three" }),
				]),
			),
		);
		expect(screen.queryByTestId("traffic-notification-cloud")).toBeNull();
	});

	it("stays silent for a row that is merely new to this reader, not new in time", () => {
		const { rerender } = render(draw(livePlayback([])));
		rerender(draw(livePlayback([arrival(60_000)])));
		expect(screen.queryByTestId("traffic-notification-cloud")).toBeNull();
	});

	it("takes the preview back down after its bounded lifetime", () => {
		vi.useFakeTimers();
		const { rerender } = render(draw(livePlayback([])));
		rerender(draw(livePlayback([arrival(200)])));
		expect(screen.getByTestId("traffic-notification-cloud")).toBeTruthy();

		act(() => void vi.advanceTimersByTime(6100));
		expect(screen.queryByTestId("traffic-notification-cloud")).toBeNull();
	});

	it("does not re-preview a notification the archive hands back unchanged", () => {
		vi.useFakeTimers();
		const events = [arrival(200)];
		const { rerender } = render(draw(livePlayback([])));
		rerender(draw(livePlayback(events)));
		act(() => void vi.advanceTimersByTime(6100));

		// A refetch returning the same row: a different array, the same key.
		rerender(draw(livePlayback([...events])));
		expect(screen.queryByTestId("traffic-notification-cloud")).toBeNull();
	});
});
