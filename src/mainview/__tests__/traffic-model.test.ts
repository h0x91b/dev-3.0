import { describe, expect, it } from "vitest";
import type { AgentMessageLogRow } from "../../shared/agent-message-log";
import type { Task } from "../../shared/types";
import { USER_ENDPOINT_ID, endpointKey, fromKey, nodeSeq, routeKey, trafficNodes, trafficRecords } from "../components/agent-traffic/traffic-model";

const row = (overrides: Partial<AgentMessageLogRow> = {}): AgentMessageLogRow => ({
	v: 1, at: "2026-09-05T10:00:00.000Z", fromTaskId: "sender", fromSeq: 11,
	fromProjectId: "first", toProjectId: "second", toTaskId: "receiver", toSeq: 22,
	kind: "immediate", body: "message", bodyKind: "text", status: "held", ...overrides,
});
const task = (overrides: Partial<Task> = {}): Task => ({ id: "sender", projectId: "first", seq: 11, title: "Current title", description: "", status: "in-progress", ...overrides } as Task);

describe("traffic model", () => {
	it("preserves identical attempts and existing occurrence keys on prepend", () => {
		const original = trafficRecords([row(), row()]);
		const newer = trafficRecords([row({ at: "2026-09-05T10:01:00.000Z" }), row(), row()]);
		expect(new Set(original.map(item => item.key)).size).toBe(2);
		expect(newer.slice(1).map(item => item.key)).toEqual(original.map(item => item.key));
	});

	it("keeps same-seq variants separate and labels their variant numbers", () => {
		const nodes = trafficNodes([task({ groupId: "group", variantIndex: 1 }), task({ id: "variant", groupId: "group", variantIndex: 2 })], []);
		expect(nodes).toHaveLength(2);
		expect(nodes.map(nodeSeq)).toEqual(["#11-1", "#11-2"]);
	});

	it("uses current task metadata while keeping foreign deleted endpoints historical", () => {
		const nodes = trafficNodes([task()], [row({ fromTitle: "Old title", toTitle: "Deleted receiver" })]);
		expect(nodes.find(node => node.key === endpointKey("first", "sender"))).toMatchObject({ title: "Current title", task: expect.any(Object) });
		expect(nodes.find(node => node.key === endpointKey("second", "receiver"))).toMatchObject({ title: "Deleted receiver", projectId: "second" });
		expect(nodes.find(node => node.id === "receiver")?.task).toBeUndefined();
	});

	it("does not merge equal ids across projects or invent human nodes", () => {
		expect(trafficNodes([task(), task({ projectId: "second" })], [])).toHaveLength(2);
		expect(trafficNodes([], [row({ fromTaskId: null, fromSeq: null })])).toHaveLength(1);
	});

	it("gives a proven user message a sender endpoint in the recipient's project", () => {
		const userRow = row({ fromTaskId: null, fromSeq: null, fromProjectId: undefined, origin: "user" });
		expect(fromKey(userRow)).toBe(endpointKey("second", USER_ENDPOINT_ID));
		const nodes = trafficNodes([], [userRow]);
		const marker = nodes.find(node => node.user);
		expect(marker).toMatchObject({ projectId: "second", seq: null });
		// No task behind it, so nothing downstream can read a status off the human.
		expect(marker?.task).toBeUndefined();
	});

	it("still invents nothing for a sender-less row that proved nothing", () => {
		// An artifact submit, a dev3 hand-off and a `dev3 message` run outside a
		// worktree all look exactly like this, and none of them is the user.
		const anonymous = row({ fromTaskId: null, fromSeq: null });
		expect(fromKey(anonymous)).toBeNull();
		expect(trafficNodes([], [anonymous]).some(node => node.user)).toBe(false);
	});

	it("keeps one user endpoint per project rather than one per message", () => {
		const nodes = trafficNodes([], [
			row({ fromTaskId: null, fromSeq: null, origin: "user" }),
			row({ fromTaskId: null, fromSeq: null, origin: "user", toTaskId: "other", at: "2026-09-05T10:02:00.000Z" }),
			row({ fromTaskId: null, fromSeq: null, origin: "user", toProjectId: "third", at: "2026-09-05T10:03:00.000Z" }),
		]);
		expect(nodes.filter(node => node.user).map(node => node.projectId).sort()).toEqual(["second", "third"]);
	});

	it("cannot collide with a task whose id happens to be the sentinel", () => {
		const nodes = trafficNodes([task({ id: USER_ENDPOINT_ID, projectId: "second" })], [
			row({ fromTaskId: null, fromSeq: null, origin: "user" }),
		]);
		// The task keeps its own identity: a real task is never redrawn as the human.
		expect(nodes.filter(node => node.id === USER_ENDPOINT_ID)).toHaveLength(1);
		expect(nodes.find(node => node.id === USER_ENDPOINT_ID)?.user).toBeUndefined();
	});

	it("folds reverse cross-project direction without conflating other projects", () => {
		const forward = row();
		const reverse = row({ fromProjectId: "second", fromTaskId: "receiver", toProjectId: "first", toTaskId: "sender" });
		expect(routeKey(forward)).toBe(routeKey(reverse));
		expect(routeKey(forward)).not.toBe(routeKey(row({ fromProjectId: "third" })));
	});
});
