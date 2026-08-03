#!/usr/bin/env bun
/**
 * Pane input against a REAL native host and shell, on the real Bun runtime — vitest stubs
 * the Bun global, so a live host cannot run there. Run: `bun run test:pane-input-native-e2e`.
 *
 * Two claims a mock cannot make: through the public seam `deliverPaneInput`, an unbound
 * process refuses instead of attaching a client that would make it the writer; and through
 * `bindNativeTaskPane`, a real binding captures the identity of the record it DIALLED.
 *
 * Isolation: registry state, host images and logs live in a tmpdir, never `~/.dev3.0/`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_MULTIPANE_DIR_ENV } from "../native-terminal-multipane/paths";

let failures = 0;
function check(condition: boolean, message: string): void {
	console.log(`  ${condition ? "ok  " : "FAIL"} - ${message}`);
	if (!condition) failures += 1;
}

const TASK_ID = "eeeeeeee-1111-2222-3333-444444444444";
const PANE_ID = "pane-1";

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "dev3-pane-input-e2e-"));
	try {
		await runCases(root);
	} finally {
		// Teardown belongs here, not after the last check: a throw anywhere above would
		// otherwise leave a real host and shell running for the rest of the machine's uptime.
		await import("../native-task-panes")
			.then((m) => m.stopNativeTaskPanes(TASK_ID))
			.catch(() => undefined);
		rmSync(root, { recursive: true, force: true });
	}
}

async function runCases(root: string): Promise<void> {
	const work = join(root, "work");
	mkdirSync(join(root, "sessions"), { recursive: true });
	mkdirSync(join(root, "multipane"), { recursive: true });
	mkdirSync(work, { recursive: true });
	process.env.DEV3_NATIVE_SESSIONS_DIR = join(root, "sessions");
	process.env[NATIVE_MULTIPANE_DIR_ENV] = join(root, "multipane");
	process.env.DEV3_NATIVE_HOST_IMAGES_DIR = join(root, "host-images");
	process.env.DEV3_LOG_DIR = join(root, "logs");

	// Imported after the env redirect so every module resolves the tmpdir paths.
	const { startNativeTaskPanes } = await import("../native-task-panes");
	const { bindNativeTaskPane } = await import("../native-task-terminal");
	const { deliverPaneInput, pinTaskPane, newPaneInputDeliveryId } = await import("../pane-input");
	const { inspectNativePaneIdentity } = await import("../native-pane-identity");

	const task = {
		id: TASK_ID,
		projectId: "p1",
		worktreePath: work,
		terminalBackend: "native",
	} as unknown as Parameters<typeof deliverPaneInput>[0];

	const state = await startNativeTaskPanes({
		taskId: TASK_ID,
		cwd: work,
		env: {},
		launch: { executable: "/bin/sh", argv: ["-c", "cat > out.txt"] },
		cols: 80,
		rows: 24,
	});
	const pane = state.panes.find((p) => p.paneId === PANE_ID);
	check(Boolean(pane?.alive), "a real native pane started");
	if (!pane) throw new Error("no pane");

	const pin = await pinTaskPane(task, PANE_ID);
	check(pin.ok, "the public seam pins the live pane");
	if (!pin.ok) throw new Error(pin.detail);

	const program = (attemptId: string) => ({
		deliveryId: newPaneInputDeliveryId(attemptId),
		attempt: 1,
		incarnation: pin.incarnation,
		stages: [{ steps: [{ kind: "text" as const, text: "FIRST" }] }],
	});

	// ── 1. no local binding: refuse, and never become the writer ────────────────
	const before = inspectNativePaneIdentity(pane.sessionId);
	const unbound = await deliverPaneInput(task, program("unbound"));
	check(
		unbound.status === "not-started" && unbound.reason === "read-only",
		`an unbound process refuses instead of attaching (got ${unbound.status}/${"reason" in unbound ? unbound.reason : "-"})`,
	);
	const after = inspectNativePaneIdentity(pane.sessionId);
	check(
		before.ok && after.ok && before.identity.host.pid === after.identity.host.pid && before.identity.shell.pid === after.identity.shell.pid,
		"the host and shell are untouched by the refused delivery",
	);
	// The shell is `cat > out.txt`, so anything that reached it would be on disk.
	const sink = join(work, "out.txt");
	await new Promise((resolve) => setTimeout(resolve, 300));
	const leaked = existsSync(sink) ? readFileSync(sink, "utf8") : "";
	check(leaked === "", `not one byte reached the shell (sink=${JSON.stringify(leaked)})`);

	// ── 2. a real binding that holds the lease ──────────────────────────────────
	const terminal = await bindNativeTaskPane(pane.sessionId, {
		onOutput: () => undefined,
		onClosed: () => undefined,
	});
	check(Boolean(terminal), "the app binds to the real host");
	if (!terminal) throw new Error("bindNativeTaskPane returned no terminal");
	// Both processes, both signatures — undefined or a partial identity must FAIL here.
	const bound = terminal.boundIdentity;
	check(
		Boolean(bound?.host.startSignature) && Boolean(bound?.shell.startSignature) && bound?.sessionId === pane.sessionId,
		`the binding captured the registry-proved identity it dialled (${JSON.stringify(bound)})`,
	);
	check(terminal.hostRole() === "writer", "this process holds the writer lease after binding");
	terminal.detach();
}

main()
	.then(() => {
		console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
		process.exit(failures === 0 ? 0 : 1);
	})
	.catch((err) => {
		console.error("\nE2E CRASHED", err);
		process.exit(1);
	});
