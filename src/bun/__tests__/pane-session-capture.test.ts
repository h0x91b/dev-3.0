import { describe, expect, it } from "vitest";
import { placeRecordedPaneSession, type SessionPane } from "../pane-session-capture";

const entry = (paneId: string | null, sessionId: string | null, extra: Partial<SessionPane> = {}): SessionPane =>
	({ paneId, agentCmd: "claude", sessionId, agentId: "claude", configId: null, ...extra });

describe("placeRecordedPaneSession", () => {
	it("moves the entry that carries this pane onto its new conversation", () => {
		const panes = [entry("%1", "a", { sessionOriginCwd: "/old" }), entry("%2", "b")];
		expect(placeRecordedPaneSession(panes, "%1", "c")).toEqual([entry("%1", "c", { sessionOriginCwd: undefined }), entry("%2", "b")]);
	});

	it("does nothing when the pane already carries the session", () => {
		expect(placeRecordedPaneSession([entry("%1", "a")], "%1", "a")).toBeNull();
	});

	it("gives an unrecorded pane to the paneless entry that holds the same session id, keeping its other fields", () => {
		const panes = [entry(null, "a", { main: true, sessionOriginCwd: "/wt" }), entry("%2", "b")];
		expect(placeRecordedPaneSession(panes, "%1", "a")).toEqual([entry("%1", "a", { main: true, sessionOriginCwd: "/wt" }), entry("%2", "b")]);
	});

	it("does not bind an unrecorded pane that reports a different session id", () => {
		expect(placeRecordedPaneSession([entry(null, "a")], "%9", "teammate")).toBeNull();
	});

	it("does not bind when two paneless entries share the session id", () => {
		expect(placeRecordedPaneSession([entry(null, "a"), entry(null, "a")], "%1", "a")).toBeNull();
	});

	it("does not take over an entry that already has another pane", () => {
		expect(placeRecordedPaneSession([entry("%2", "a")], "%1", "a")).toBeNull();
	});
});
