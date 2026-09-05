import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const push = vi.hoisted(() => vi.fn());
vi.mock("../rpc-handlers/shared-pure", () => ({ getPushMessageLocal: () => push }));
import { noteLocalMessageLogAppend, stopAgentMessageLogWatches, watchAgentMessageLog } from "../agent-message-log-watch";

let root: string;
let directory: string;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dev3-log-watch-"));
	directory = join(root, "messages");
	push.mockClear();
});
afterEach(() => { stopAgentMessageLogWatches(); rmSync(root, { recursive: true, force: true }); });

describe("external message log appends", () => {
	it("pushes a debounced invalidation for a real external append", async () => {
		mkdirSync(directory);
		const file = join(directory, "2026-09-05.jsonl");
		writeFileSync(file, "first\n");
		watchAgentMessageLog("project", directory);
		await delay(200);
		appendFileSync(file, "second\n");
		appendFileSync(file, "third\n");
		await vi.waitFor(() => expect(push).toHaveBeenCalledWith("agentMessageLogChanged", { projectId: "project" }), { timeout: 4000 });
		await delay(150);
		expect(push).toHaveBeenCalledTimes(1);
	});

	it("observes the first log directory and the next day without creating state on read", async () => {
		watchAgentMessageLog("project", directory);
		mkdirSync(directory);
		writeFileSync(join(directory, "2026-09-05.jsonl"), "first\n");
		await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1), { timeout: 4000 });
		writeFileSync(join(directory, "2026-09-06.jsonl"), "next day\n");
		await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(2), { timeout: 4000 });
	});

	it("ignores unrelated files and local appends already announced by the writer", async () => {
		mkdirSync(directory);
		watchAgentMessageLog("project", directory);
		writeFileSync(join(directory, "readme.txt"), "unrelated");
		writeFileSync(join(directory, "2026-09-05.jsonl"), "local append\n");
		noteLocalMessageLogAppend(directory);
		await delay(300);
		expect(push).not.toHaveBeenCalled();
	});

	it("closes watchers and pending invalidations on shutdown", async () => {
		mkdirSync(directory);
		watchAgentMessageLog("project", directory);
		writeFileSync(join(directory, "2026-09-05.jsonl"), "pending\n");
		await delay(20);
		stopAgentMessageLogWatches();
		await delay(200);
		expect(push).not.toHaveBeenCalled();
	});
});


it("observes an external append in the actual Bun runtime", () => {
	const watcherModule = new URL("../agent-message-log-watch.ts", import.meta.url).href;
	const pushModule = new URL("../rpc-handlers/shared-pure.ts", import.meta.url).href;
	const script = `
		import { watchAgentMessageLog, stopAgentMessageLogWatches } from ${JSON.stringify(watcherModule)};
		import { setPushMessage } from ${JSON.stringify(pushModule)};
		import * as fs from "node:fs";
		const directory = ${JSON.stringify(root)};
		const file = directory + "/2026-09-05.jsonl";
		fs.writeFileSync(file, "first\\n");
		let count = 0;
		setPushMessage((name, payload) => {
			if (name === "agentMessageLogChanged" && payload.projectId === "bun-proof") count++;
		});
		watchAgentMessageLog("bun-proof", directory);
		setTimeout(() => fs.appendFileSync(file, "external\\n"), 300);
		setTimeout(() => {
			stopAgentMessageLogWatches();
			console.log(count);
			process.exit(count === 1 ? 0 : 1);
		}, 2500);
	`;
	expect(execFileSync("bun", ["-e", script], { encoding: "utf8", timeout: 8000 }).trim()).toBe("1");
}, 10000);
