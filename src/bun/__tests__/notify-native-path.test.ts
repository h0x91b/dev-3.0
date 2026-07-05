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
});
