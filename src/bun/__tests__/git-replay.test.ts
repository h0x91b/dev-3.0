import { describe, it, expect, vi } from "vitest";
import {
	createGitReplayMock,
	createGitRecorder,
	sessionSpawn,
	useReplay,
	endScenario,
	toBase64,
	type GitTranscript,
} from "./git-replay";

const utf8 = (text: string) => toBase64(new TextEncoder().encode(text));

function transcriptOf(cmd: string[], stdout: string, exitCode = 0): GitTranscript {
	return [{ cmd, cwd: "<repo>", stdin: null, exitCode, stdout: utf8(stdout), stderr: utf8("") }];
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
	return new Response(stream).text();
}

// The whole value of the replay layer rests on a miss being LOUD. If a wrong or
// missing key quietly produced empty output, every converted suite would keep
// passing after the code changed what it asks git — the exact failure the recorded
// fixtures exist to avoid.
describe("git replay", () => {
	const REPO = "/replay/worktree";

	it("replays the recorded bytes for the exact recorded command", async () => {
		const mock = createGitReplayMock(transcriptOf(["git", "rev-list", "--count", "HEAD"], "3\n"), REPO);

		const proc = mock.spawn(["git", "rev-list", "--count", "HEAD"], { cwd: REPO }) as {
			exited: Promise<number>;
			stdout: ReadableStream<Uint8Array>;
		};

		await expect(readAll(proc.stdout)).resolves.toBe("3\n");
		await expect(proc.exited).resolves.toBe(0);
	});

	it("fails loudly when the command changed, naming the command and how to fix it", async () => {
		const mock = createGitReplayMock(transcriptOf(["git", "diff", "--find-renames"], "x"), REPO);
		vi.spyOn(console, "error").mockImplementation(() => {});

		// Same intent, one flag dropped — the shape a real regression takes.
		const proc = mock.spawn(["git", "diff"], { cwd: REPO }) as { exited: Promise<number> };

		await expect(proc.exited).rejects.toThrow(/no recorded git response/);
		await expect(proc.exited).rejects.toThrow(/re-record/);
	});

	it("keys on cwd too, so a call against the wrong repo cannot borrow an answer", async () => {
		const mock = createGitReplayMock(transcriptOf(["git", "status"], "clean"), REPO);
		vi.spyOn(console, "error").mockImplementation(() => {});

		const proc = mock.spawn(["git", "status"], { cwd: "/some/other/place" }) as { exited: Promise<number> };

		await expect(proc.exited).rejects.toThrow(/no recorded git response/);
	});

	it("scrubs the recording repo's path so a fixture is portable", async () => {
		// Recorded under REPO, asked for under REPO: the placeholder must match both ways.
		const mock = createGitReplayMock(
			[{ cmd: ["git", "-C", "<repo>", "log"], cwd: "<repo>", stdin: null, exitCode: 0, stdout: utf8("ok"), stderr: utf8("") }],
			REPO,
		);

		const proc = mock.spawn(["git", "-C", REPO, "log"], { cwd: REPO }) as {
			stdout: ReadableStream<Uint8Array>;
		};

		await expect(readAll(proc.stdout)).resolves.toBe("ok");
	});

	it("reports recorded exchanges nothing asked for", () => {
		const mock = createGitReplayMock(transcriptOf(["git", "fetch"], ""), REPO);
		expect(mock.unused()).toHaveLength(1);
		mock.spawn(["git", "fetch"], { cwd: REPO });
		expect(mock.unused()).toHaveLength(0);
	});

	it("refuses to reach real git when no scenario is installed", () => {
		endScenario();
		expect(() => sessionSpawn(["git", "status"], { cwd: REPO })).toThrow(/no scenario is installed/);
	});

	it("routes through whichever scenario is currently installed", async () => {
		useReplay(transcriptOf(["git", "status"], "second"), REPO);
		const proc = sessionSpawn(["git", "status"], { cwd: REPO }) as { stdout: ReadableStream<Uint8Array> };
		await expect(readAll(proc.stdout)).resolves.toBe("second");
		endScenario();
	});

	it("records what a real spawn actually did, base64 and all", async () => {
		const transcript: GitTranscript = [];
		const fake = () => ({
			exited: Promise.resolve(0),
			stdout: new Response("a\0b").body as ReadableStream<Uint8Array>,
			stderr: new Response("").body as ReadableStream<Uint8Array>,
		});
		const spawn = createGitRecorder(fake, REPO, transcript);

		const proc = spawn(["git", "ls-files", "-z"], { cwd: REPO });
		await expect(readAll(proc.stdout)).resolves.toBe("a\0b");
		await proc.exited;

		expect(transcript).toHaveLength(1);
		expect(transcript[0].cmd).toEqual(["git", "ls-files", "-z"]);
		// cwd is stored scrubbed, so the fixture does not carry the recording machine's path.
		expect(transcript[0].cwd).toBe("<repo>");
		expect(transcript[0].stdout).toBe(utf8("a\0b"));
	});
});
