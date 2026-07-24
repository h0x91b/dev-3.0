// Verifies that task notifications prefer the native click channel: when the
// shim accepts the notification, the legacy Electrobun path must NOT fire and
// the focus-proxy slot must stay un-armed (real clicks make the proxy's
// "activation shortly after = click" guess obsolete — and dangerous, since a
// stale armed slot teleports the user on an unrelated app activation).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "../../shared/types";

vi.mock("electrobun/bun", () => ({
	PATHS: {
		VIEWS_FOLDER: "/fake-bundle/Resources/app/views/",
	},
	Utils: {
		showNotification: vi.fn(),
	},
	Updater: {},
}));

// shared.ts imports bun:ffi at top level (objc helpers) — stub it for Node.
vi.mock("bun:ffi", () => ({
	dlopen: vi.fn(() => ({ symbols: {} })),
	FFIType: { ptr: "ptr", function: "function", i32: "i32", void: "void" },
	JSCallback: class {
		ptr = 1;
		close() {}
	},
	CString: class {},
}));

vi.mock("../native-notifications", () => ({
	postNativeTaskNotification: vi.fn(() => false),
	encodeTaskNotificationIdentifier: vi.fn(),
	decodeTaskNotificationIdentifier: vi.fn(),
	initNativeNotifications: vi.fn(() => false),
	_resetNativeNotificationsForTests: vi.fn(),
}));

const { Utils } = await import("electrobun/bun");
const { postNativeTaskNotification } = await import("../native-notifications");
const {
	notifyWatchedTaskStatusChange,
	notifyFromCliDesktop,
	consumeRecentWatchedNotification,
	_resetWatchedNotificationState,
	setPushMessage,
	setTerminalFocus,
	setFocusMode,
	queueTerminalFocusToast,
	pushCliToast,
	pushCliAttention,
	pushTerminalBell,
	pushCliShowImage,
	pushCliShowArtifact,
} = await import("../rpc-handlers/shared");

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "task-1",
		projectId: "proj-1",
		seq: 42,
		description: "desc",
		customTitle: "Fix bug",
		status: "in-progress",
		createdAt: 0,
		updatedAt: 0,
		watched: true,
		...overrides,
	} as Task;
}

beforeEach(() => {
	vi.mocked(Utils.showNotification).mockClear();
	vi.mocked(postNativeTaskNotification).mockReset();
	_resetWatchedNotificationState();
	setPushMessage(() => {});
});

describe("native notification channel routing", () => {
	it("skips the legacy path and does not arm the focus-proxy when the shim posts", () => {
		vi.mocked(postNativeTaskNotification).mockReturnValue(true);

		notifyWatchedTaskStatusChange(makeTask(), "in-progress", "review-by-user", "MyProject");

		expect(postNativeTaskNotification).toHaveBeenCalledWith({
			taskId: "task-1",
			projectId: "proj-1",
			title: "#42 Fix bug",
			subtitle: "MyProject",
			body: "In Progress → Review By User",
			silent: true,
		});
		expect(Utils.showNotification).not.toHaveBeenCalled();
		// The native delegate reports real clicks — the proxy slot must stay empty.
		expect(consumeRecentWatchedNotification()).toBeNull();
	});

	it("still mirrors a web notification to remote clients when the shim posts", () => {
		vi.mocked(postNativeTaskNotification).mockReturnValue(true);
		const push = vi.fn();
		setPushMessage(push);

		notifyFromCliDesktop({ task: makeTask(), body: "done", projectName: "MyProject" });

		expect(push).toHaveBeenCalledWith("webNotification", expect.objectContaining({ taskId: "task-1", body: "done" }));
	});

	it("falls back to the legacy path and arms the focus-proxy when the shim declines", () => {
		vi.mocked(postNativeTaskNotification).mockReturnValue(false);

		notifyWatchedTaskStatusChange(makeTask(), "in-progress", "review-by-user", "MyProject");

		expect(Utils.showNotification).toHaveBeenCalledWith({
			title: "#42 Fix bug",
			body: "In Progress → Review By User",
			subtitle: "MyProject",
			silent: true,
		});
		expect(consumeRecentWatchedNotification()).toEqual({ taskId: "task-1", projectId: "proj-1" });
	});

	it("queues native and web notifications until terminal focus ends", () => {
		const push = vi.fn();
		setPushMessage(push);
		vi.mocked(postNativeTaskNotification).mockReturnValue(true);
		setTerminalFocus(true);

		notifyFromCliDesktop({ task: makeTask(), body: "done", projectName: "MyProject" });

		expect(postNativeTaskNotification).not.toHaveBeenCalled();
		expect(push).not.toHaveBeenCalled();

		setTerminalFocus(false);

		expect(postNativeTaskNotification).toHaveBeenCalledWith(expect.objectContaining({ body: "done" }));
		expect(push).toHaveBeenCalledWith("webNotification", expect.objectContaining({ body: "done" }));
	});

	it("queues native and web notifications until persistent Focus Mode ends", () => {
		const push = vi.fn();
		setPushMessage(push);
		vi.mocked(postNativeTaskNotification).mockReturnValue(true);
		setFocusMode(true);

		notifyFromCliDesktop({ task: makeTask(), body: "done", projectName: "MyProject" });

		expect(postNativeTaskNotification).not.toHaveBeenCalled();
		expect(push).not.toHaveBeenCalled();

		setFocusMode(false);

		expect(postNativeTaskNotification).toHaveBeenCalledWith(expect.objectContaining({ body: "done" }));
		expect(push).toHaveBeenCalledWith("webNotification", expect.objectContaining({ body: "done" }));
	});

	it("flushes queued CLI toasts after terminal focus ends", () => {
		const push = vi.fn();
		setPushMessage(push);
		setTerminalFocus(true);
		const payload = {
			taskId: "task-1",
			projectId: "proj-1",
			message: "build done",
			level: "success" as const,
			taskSeq: 42,
			taskTitle: "Fix bug",
			projectName: "MyProject",
		};

		queueTerminalFocusToast(payload);
		expect(push).not.toHaveBeenCalled();

		setTerminalFocus(false);

		expect(push).toHaveBeenCalledWith("cliToast", payload);
	});

	it("flushes queued attention badges after Focus Mode ends", () => {
		const push = vi.fn();
		setPushMessage(push);
		setFocusMode(true);

		pushCliAttention({ taskId: "task-1", reason: "CI passed" });
		expect(push).not.toHaveBeenCalled();

		setFocusMode(false);

		expect(push).toHaveBeenCalledWith("cliAttention", { taskId: "task-1", reason: "CI passed" });
	});

	it("flushes mixed notification types in arrival order with their task targets", () => {
		const push = vi.fn();
		setPushMessage(push);
		setFocusMode(true);

		pushCliToast({ taskId: "task-1", projectId: "proj-1", message: "toast", level: "info" });
		pushTerminalBell("task-1");
		pushCliShowImage({ taskId: "task-1", projectId: "proj-1", images: [], newCount: 1 });
		pushCliAttention({ taskId: "task-2", reason: "attention" });
		pushCliShowArtifact({ taskId: "task-2", projectId: "proj-1", artifacts: [], newCount: 1 });

		expect(push).not.toHaveBeenCalled();
		setFocusMode(false);

		expect(push.mock.calls.map(([name]) => name)).toEqual([
			"cliToast",
			"terminalBell",
			"cliShowImage",
			"cliAttention",
			"cliShowArtifact",
		]);
		expect(push).toHaveBeenCalledWith("cliShowImage", expect.objectContaining({ taskId: "task-1" }));
		expect(push).toHaveBeenCalledWith("cliAttention", { taskId: "task-2", reason: "attention" });
	});

	it("keeps queued notifications hidden until every suppression source ends", () => {
		const push = vi.fn();
		setPushMessage(push);
		setTerminalFocus(true);
		setFocusMode(true);

		pushCliAttention({ taskId: "task-1", reason: "still busy" });
		setTerminalFocus(false);
		expect(push).not.toHaveBeenCalled();

		setFocusMode(false);
		expect(push).toHaveBeenCalledWith("cliAttention", { taskId: "task-1", reason: "still busy" });
	});
});
