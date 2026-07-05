import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("electrobun/bun", () => ({
	PATHS: {
		VIEWS_FOLDER: "/fake-bundle/Resources/app/views/",
	},
	Utils: {
		showNotification: vi.fn(),
	},
	Updater: {},
}));

// Vitest runs under Node — bun:ffi does not resolve. The guard tests below
// never reach dlopen (headless/platform/existsSync checks come first).
vi.mock("bun:ffi", () => ({
	dlopen: vi.fn(() => {
		throw new Error("dlopen must not be reached in these tests");
	}),
	FFIType: { ptr: "ptr", function: "function", i32: "i32", void: "void" },
	JSCallback: class {
		ptr = 1;
		close() {}
	},
	CString: class {},
}));

const {
	encodeTaskNotificationIdentifier,
	decodeTaskNotificationIdentifier,
	initNativeNotifications,
	postNativeTaskNotification,
	_resetNativeNotificationsForTests,
} = await import("../native-notifications");

afterEach(() => {
	_resetNativeNotificationsForTests();
	delete process.env.DEV3_HEADLESS;
});

describe("task notification identifier codec", () => {
	it("round-trips a task target", () => {
		const target = {
			taskId: "ed35273b-70cf-4f93-8351-33fd77d2df47",
			projectId: "a1c9fe4e-8389-4214-9018-4a2580c261f0",
		};
		expect(decodeTaskNotificationIdentifier(encodeTaskNotificationIdentifier(target))).toEqual(target);
	});

	it("is stable per task so newer notifications replace older ones", () => {
		const target = { taskId: "t-1", projectId: "p-1" };
		expect(encodeTaskNotificationIdentifier(target)).toBe(encodeTaskNotificationIdentifier({ ...target }));
	});

	it("rejects identifiers without the dev3 prefix", () => {
		expect(decodeTaskNotificationIdentifier("some-foreign-notification-id")).toBeNull();
		expect(decodeTaskNotificationIdentifier("other-prefix|task|project")).toBeNull();
	});

	it("rejects identifiers with missing parts", () => {
		expect(decodeTaskNotificationIdentifier("dev3-task-nav|only-task")).toBeNull();
		expect(decodeTaskNotificationIdentifier("dev3-task-nav||project")).toBeNull();
		expect(decodeTaskNotificationIdentifier("dev3-task-nav|task|")).toBeNull();
		expect(decodeTaskNotificationIdentifier("dev3-task-nav|a|b|extra")).toBeNull();
		expect(decodeTaskNotificationIdentifier("")).toBeNull();
	});
});

describe("initNativeNotifications guards", () => {
	it("returns false in headless mode without touching FFI", () => {
		process.env.DEV3_HEADLESS = "1";
		expect(initNativeNotifications(() => {})).toBe(false);
	});

	it.runIf(process.platform !== "darwin")("returns false on non-macOS platforms", () => {
		expect(initNativeNotifications(() => {})).toBe(false);
	});

	it.runIf(process.platform === "darwin")("returns false when the shim dylib does not exist", () => {
		// VIEWS_FOLDER is mocked to a nonexistent bundle path — init must degrade
		// to false (focus-proxy fallback), not throw.
		expect(initNativeNotifications(() => {})).toBe(false);
	});
});

describe("postNativeTaskNotification", () => {
	it("returns false when the native channel was never initialized", () => {
		expect(
			postNativeTaskNotification({
				taskId: "t-1",
				projectId: "p-1",
				title: "#1 Task",
				body: "body",
			}),
		).toBe(false);
	});
});
