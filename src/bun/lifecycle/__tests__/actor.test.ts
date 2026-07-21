import { describe, expect, it } from "vitest";
import { TaskActorRegistry } from "../actor";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("TaskActorRegistry", () => {
	it("serializes events for one task", async () => {
		const first = deferred<string>();
		const started: string[] = [];
		const actors = new TaskActorRegistry<string, string>(async (_taskId, event) => {
			started.push(event);
			if (event === "first") return first.promise;
			return event;
		});

		const firstResult = actors.dispatch("task-1", "first");
		const secondResult = actors.dispatch("task-1", "second");
		await Promise.resolve();

		expect(started).toEqual(["first"]);
		first.resolve("first-done");
		expect(await firstResult).toBe("first-done");
		expect(await secondResult).toBe("second");
		expect(started).toEqual(["first", "second"]);
	});

	it("processes different tasks in parallel", async () => {
		const taskA = deferred<string>();
		const taskB = deferred<string>();
		const started: string[] = [];
		const actors = new TaskActorRegistry<string, string>(async (taskId) => {
			started.push(taskId);
			return taskId === "task-a" ? taskA.promise : taskB.promise;
		});

		const resultA = actors.dispatch("task-a", "event");
		const resultB = actors.dispatch("task-b", "event");
		await Promise.resolve();

		expect(started).toEqual(["task-a", "task-b"]);
		taskB.resolve("b-done");
		expect(await resultB).toBe("b-done");
		taskA.resolve("a-done");
		expect(await resultA).toBe("a-done");
	});

	it("resolves each caller when its own event finishes", async () => {
		const first = deferred<string>();
		const second = deferred<string>();
		const actors = new TaskActorRegistry<string, string>(async (_taskId, event) => {
			return event === "first" ? first.promise : second.promise;
		});

		let secondSettled = false;
		const firstResult = actors.dispatch("task-1", "first");
		const secondResult = actors.dispatch("task-1", "second").then((value) => {
			secondSettled = true;
			return value;
		});

		first.resolve("first-done");
		expect(await firstResult).toBe("first-done");
		expect(secondSettled).toBe(false);
		second.resolve("second-done");
		expect(await secondResult).toBe("second-done");
	});
});
