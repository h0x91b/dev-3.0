/** Fixture-only adapter: replay captured native hooks through the production observer. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeSessionWatches } from "../src/bun/claude-session-watch";

const root = process.argv[2]!;
const watchers = new ClaudeSessionWatches();
let seen = 0;
let status = "user-questions";
const save = () => writeFileSync(join(root, "observed-status.json"), JSON.stringify({ status }));
save();
const timer = setInterval(() => {
	let lines: string[];
	try { lines = readFileSync(join(root, "hooks.jsonl"), "utf8").trim().split("\n"); } catch { return; }
	for (const line of lines.slice(seen)) {
		let payload: Record<string, any>;
		try { payload = JSON.parse(line).payload; } catch { break; }
		seen++;
		if (payload.hook_event_name === "UserPromptSubmit") {
			status = "in-progress";
			watchers.observe({ projectId: "fixture", taskId: "fixture", paneId: "fixture", sessionId: payload.session_id,
				directory: join(root, "config", "sessions"), cwd: join(root, "work") }, async event => {
				if (watchers.isCurrentIdle(event) && status === "in-progress") { status = "user-questions"; save(); }
			});
		} else if (payload.hook_event_name === "Stop" || payload.hook_event_name === "SessionEnd") {
			watchers.endTurn("fixture", "fixture", payload.session_id);
			if (payload.hook_event_name === "Stop") status = "review-by-user";
		} else if (payload.hook_event_name === "PermissionRequest") status = "user-questions";
		save();
	}
}, 25);
process.on("SIGTERM", () => { clearInterval(timer); watchers.close(); process.exit(0); });
