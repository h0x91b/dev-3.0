/**
 * How the git-operation panes are LAUNCHED, per platform, EXECUTED on the
 * platform it claims (Seq 1547).
 *
 * This file exists because a mutation caught the gap it fills. The E2E that runs
 * the generated scripts calls `generatedScriptLaunch` itself, so restoring the
 * `nativeLaunch: { executable: "/bin/bash" }` hardcode inside `openGitOpPane`
 * left every one of its 18 checks green on windows-latest (run 31874748311) —
 * the scripts were fine and the pane still could not start them. The script and
 * the launch are two separate things and each needs its own proof.
 *
 * Sibling of `agent-spawn-shell-launch.test.ts`, which does the same for the
 * agent panes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
	getProject: vi.fn(),
	getTask: vi.fn(),
	openAuxPane: vi.fn(),
	writeLaunchScript: vi.fn(async (_scriptPath: string, _body: string) => {}),
	refExists: vi.fn(async () => true),
	getCurrentBranch: vi.fn(async () => "dev3/feature"),
}));

// `./shared` re-exports through electrobun, which cannot load outside the app.
vi.mock("../shared", () => ({
	getPushMessage: () => null,
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../data", () => ({
	getProject: mocks.getProject,
	getTask: mocks.getTask,
	updateTask: vi.fn(),
}));

vi.mock("../../git", () => ({
	refExists: mocks.refExists,
	getCurrentBranch: mocks.getCurrentBranch,
	fetchOrigin: vi.fn(async () => true),
	getBranchStatus: vi.fn(async () => ({ ahead: 1, behind: 0 })),
}));

vi.mock("../../task-aux-panes", () => ({
	openAuxPane: mocks.openAuxPane,
	auxPaneAlive: vi.fn(async () => false),
	auxPaneTitle: () => "Git",
}));

vi.mock("../shared-pure", async (importOriginal) => ({
	...(await importOriginal<typeof import("../shared-pure")>()),
	writeLaunchScript: mocks.writeLaunchScript,
}));

vi.mock("../../github", () => ({ getGitHubShellExports: vi.fn(async () => []) }));
vi.mock("../../settings", () => ({ loadSettings: vi.fn(async () => ({})) }));
vi.mock("../../agent-prompt-delivery", () => ({ deliverAgentPrompt: vi.fn() }));
vi.mock("../../scheduled-message-scheduler", () => ({
	scheduleMessage: vi.fn(),
	cancelScheduledMessage: vi.fn(),
	sendScheduledMessageNow: vi.fn(),
}));
vi.mock("../../task-branch-sync", () => ({ syncTaskBranchName: vi.fn() }));
vi.mock("../../lifecycle/service", () => ({ lifecycleActorRuntime: vi.fn(() => ({})) }));
vi.mock("../../lifecycle/activities", () => ({
	PR_DETECTION_TIMEOUT_MS: 1000,
	dismissMergeCompletionPrompt: vi.fn(),
	persistProjectPrIdentities: vi.fn(),
	persistTaskPrIdentity: vi.fn(),
	prepareMergeCompletionPrompt: vi.fn(),
	refreshTaskPrStatus: vi.fn(),
}));
vi.mock("../../lifecycle/merge-fingerprint", () => ({ getMergeCompletionFingerprint: vi.fn() }));

import { gitOperationHandlers } from "../git-operations";

const PROJECT = { id: "proj-1", name: "p", path: "/repo", defaultBaseBranch: "main" } as any;
const TASK = {
	id: "abcdef12-0000-0000-0000-000000000003",
	title: "Port the panes",
	branchName: "dev3/feature",
	worktreePath: "/repo/wt",
} as any;
const isWindows = process.platform === "win32";

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	mocks.getProject.mockResolvedValue(PROJECT);
	mocks.getTask.mockResolvedValue(TASK);
	mocks.refExists.mockResolvedValue(true);
	mocks.getCurrentBranch.mockResolvedValue("dev3/feature");
	mocks.openAuxPane.mockResolvedValue({ backend: "native", paneId: "%9" });
});

const OPERATIONS = [
	{ name: "rebase", run: () => gitOperationHandlers.rebaseTask({ taskId: TASK.id, projectId: PROJECT.id }) },
	{ name: "push", run: () => gitOperationHandlers.pushTask({ taskId: TASK.id, projectId: PROJECT.id }) },
	{ name: "merge", run: () => gitOperationHandlers.mergeTask({ taskId: TASK.id, projectId: PROJECT.id }) },
] as const;

describe(`git-op pane launch on ${process.platform}`, () => {
	for (const operation of OPERATIONS) {
		it(`${operation.name} never hands the pane a POSIX shell path that cannot exist here`, async () => {
			await operation.run();
			const launch = mocks.openAuxPane.mock.calls[0][0].nativeLaunch;
			if (isWindows) {
				expect(launch.executable).not.toBe("/bin/bash");
				expect(launch.executable).not.toMatch(/^\/bin\//);
				expect(launch.executable).toMatch(/(powershell|pwsh)(\.exe)?$/i);
				expect(launch.argv).toContain("-File");
				expect(launch.argv[launch.argv.length - 1]).toMatch(/\.ps1$/);
			} else {
				// The POSIX control: byte-identical to the literal it replaced.
				expect(launch.executable).toBe("/bin/bash");
				expect(launch.argv[launch.argv.length - 1]).toMatch(/\.sh$/);
				expect(launch.argv).toHaveLength(1);
			}
		});

		it(`${operation.name} writes the script to the very path the pane launches`, async () => {
			await operation.run();
			const launch = mocks.openAuxPane.mock.calls[0][0].nativeLaunch;
			const written = mocks.writeLaunchScript.mock.calls
				.map(([path]) => String(path))
				.filter((path) => !path.endsWith(".txt"));
			expect(written).toContain(launch.argv[launch.argv.length - 1]);
		});
	}

	// The same assertion the windows-latest leg makes natively, forced from any
	// platform, so the regression is catchable in an ordinary local run too.
	it("resolves PowerShell for every operation when the platform reports win32", async () => {
		const real = process.platform;
		const realSystemRoot = process.env.SystemRoot;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		process.env.SystemRoot ??= "C:\\Windows";
		try {
			for (const operation of OPERATIONS) {
				mocks.openAuxPane.mockClear();
				await operation.run();
				const launch = mocks.openAuxPane.mock.calls[0][0].nativeLaunch;
				expect(launch.executable, operation.name).toMatch(/(powershell|pwsh)(\.exe)?$/i);
				expect(launch.argv, operation.name).toContain("-File");
			}
		} finally {
			Object.defineProperty(process, "platform", { value: real, configurable: true });
			if (realSystemRoot === undefined) delete process.env.SystemRoot;
		}
	});

	// Opening a PR from the pane still runs a hand-written bash prelude
	// (`github.getGitHubShellExports`), so on Windows it must refuse rather than
	// hand that text to PowerShell and open a pane that cannot work.
	it("refuses to open a PR pane on Windows instead of opening a broken one", async () => {
		const real = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		process.env.SystemRoot ??= "C:\\Windows";
		try {
			await expect(gitOperationHandlers.openPullRequest({ taskId: TASK.id, projectId: PROJECT.id }))
				.rejects.toThrow(/not supported on Windows/);
			expect(mocks.openAuxPane).not.toHaveBeenCalled();
		} finally {
			Object.defineProperty(process, "platform", { value: real, configurable: true });
		}
	});
});
