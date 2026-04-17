import { describe, it, expect } from "vitest";
import { openFolderPicker, subscribeFolderPicker } from "../folder-picker";

describe("folder-picker bridge", () => {
	it("delivers the request to the subscribed host and resolves with the chosen path", async () => {
		const unsubscribe = subscribeFolderPicker((req) => {
			expect(req.options).toEqual({});
			req.resolve("/selected/path");
		});
		await expect(openFolderPicker()).resolves.toBe("/selected/path");
		unsubscribe();
	});

	it("passes options through to the host", async () => {
		let seen: unknown = null;
		const unsubscribe = subscribeFolderPicker((req) => {
			seen = req.options;
			req.resolve(null);
		});
		await openFolderPicker({ initialPath: "/tmp", title: "pick one" });
		expect(seen).toEqual({ initialPath: "/tmp", title: "pick one" });
		unsubscribe();
	});

	it("queues requests made before a host subscribes and flushes them on subscribe", async () => {
		const pending = openFolderPicker({ initialPath: "/early" });
		const unsubscribe = subscribeFolderPicker((req) => {
			expect(req.options.initialPath).toBe("/early");
			req.resolve("/early/resolved");
		});
		await expect(pending).resolves.toBe("/early/resolved");
		unsubscribe();
	});

	it("resolves with null when the user cancels", async () => {
		const unsubscribe = subscribeFolderPicker((req) => req.resolve(null));
		await expect(openFolderPicker()).resolves.toBeNull();
		unsubscribe();
	});
});
