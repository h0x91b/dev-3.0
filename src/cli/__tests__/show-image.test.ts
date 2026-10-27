import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleShowImage, handleShowMedia } from "../commands/show-image";
import type { CliContext } from "../context";
import type { CliResponse } from "../../shared/types";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
const mockSend = vi.mocked(sendRequest);

const SOCKET = "/tmp/test.sock";
const CTX: CliContext = {
	projectId: "proj-001",
	taskId: "aaaaaaaa-1111-2222-3333-444444444444",
	socketPath: SOCKET,
};

const DIR = mkdtempSync(join(tmpdir(), "dev3-showimage-cli-"));
const PNG = join(DIR, "shot.png");
writeFileSync(PNG, "PNGDATA");
const PNG2 = join(DIR, "shot2.png");
writeFileSync(PNG2, "PNGDATA2");
const MP4 = join(DIR, "demo.mp4");
writeFileSync(MP4, "MP4DATA");
const WEBM = join(DIR, "qa.webm");
writeFileSync(WEBM, "WEBMDATA");
const MP3 = join(DIR, "voice.mp3");
writeFileSync(MP3, "ID3DATA");
const TXT = join(DIR, "notes.txt");
writeFileSync(TXT, "hi");

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

let stdoutOutput: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

function okResp(data: unknown): CliResponse {
	return { id: "t", ok: true, data };
}

beforeEach(() => {
	stdoutOutput = "";
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
		stdoutOutput += String(c);
		return true;
	});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
		throw new Error(`EXIT_${code ?? 0}`);
	}) as ReturnType<typeof vi.spyOn>;
	mockSend.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	exitSpy.mockRestore();
});

describe("show-image", () => {
	it("sends resolved absolute paths for the in-context task", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, stored: 1, taskId: CTX.taskId }));

		await handleShowImage([PNG], SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "ui.show-image", {
			taskId: CTX.taskId,
			images: [{ path: PNG }],
			projectId: CTX.projectId,
		});
		expect(stdoutOutput).toContain("Shared 1 image");
	});

	it("binds a --caption to the image path it follows", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, stored: 1, taskId: CTX.taskId }));
		await handleShowImage([PNG, "--caption", "login screen"], SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(
			SOCKET,
			"ui.show-image",
			expect.objectContaining({ images: [{ path: PNG, caption: "login screen" }] }),
		);
	});

	it("binds a separate caption to each image", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, stored: 2, taskId: CTX.taskId }));
		await handleShowImage([PNG, "--caption", "before", PNG2, "-c", "after"], SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(
			SOCKET,
			"ui.show-image",
			expect.objectContaining({
				images: [
					{ path: PNG, caption: "before" },
					{ path: PNG2, caption: "after" },
				],
			}),
		);
	});

	it("leaves images without a caption uncaptioned", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, stored: 2, taskId: CTX.taskId }));
		await handleShowImage([PNG, PNG2, "--caption", "only the second"], SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(
			SOCKET,
			"ui.show-image",
			expect.objectContaining({
				images: [{ path: PNG }, { path: PNG2, caption: "only the second" }],
			}),
		);
	});

	it("errors when --caption precedes any image path", async () => {
		await expect(handleShowImage(["--caption", "orphan", PNG], SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects an unknown flag", async () => {
		await expect(handleShowImage([PNG, "--bogus", "x"], SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("reports a viewer queued by Focus Mode", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, queued: true, stored: 2, taskId: CTX.taskId }));
		await handleShowImage([PNG], SOCKET, CTX);
		expect(stdoutOutput).toContain("viewer queued until Focus Mode ends");
	});

	it("errors with a usage code when no paths are given", async () => {
		await expect(handleShowImage([], SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects a missing file", async () => {
		await expect(handleShowImage([join(DIR, "gone.png")], SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects an unsupported type", async () => {
		await expect(handleShowImage([TXT], SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("requires a task in context", async () => {
		await expect(handleShowImage([PNG], SOCKET, null)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});
});

describe("show-media", () => {
	function stderrText(): string {
		return stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
	}

	it("sends video clips with their captions to ui.show-media", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, stored: 2, taskId: CTX.taskId }));
		await handleShowMedia([MP4, "--caption", "the bug", WEBM], SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "ui.show-media", {
			taskId: CTX.taskId,
			images: [{ path: MP4, caption: "the bug" }, { path: WEBM }],
			projectId: CTX.projectId,
		}, { timeoutMs: 300_000 });
		expect(stdoutOutput).toContain("Shared 2 media files");
	});

	it("accepts MP3 (the reported repro) and every supported audio container next to video", async () => {
		const extra = ["take.m4a", "beep.wav", "loop.ogg"].map((name) => {
			const path = join(DIR, name);
			writeFileSync(path, "AUDIO");
			return path;
		});
		mockSend.mockResolvedValue(okResp({ delivered: true, stored: 5, taskId: CTX.taskId }));
		await handleShowMedia([MP3, "-c", "listen", ...extra, MP4], SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "ui.show-media", {
			taskId: CTX.taskId,
			images: [{ path: MP3, caption: "listen" }, ...extra.map((path) => ({ path })), { path: MP4 }],
			projectId: CTX.projectId,
		}, { timeoutMs: 300_000 });
		expect(stdoutOutput).toContain("Shared 5 media files");
	});

	it("says one media file in the singular", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, stored: 1, taskId: CTX.taskId }));
		await handleShowMedia([MP3], SOCKET, CTX);
		expect(stdoutOutput).toContain("Shared 1 media file to task");
	});

	it.each(["track.flac", "track.opus", "track.aac", "clip.mov", "notes.txt"])("rejects %s before contacting the app", async (name) => {
		const path = join(DIR, name);
		writeFileSync(path, "x");
		await expect(handleShowMedia([path], SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(stderrText()).toContain("Unsupported media file type");
		expect(stderrText()).toContain("mp4, webm, mp3, m4a, wav, ogg");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects an image and names the supported containers", async () => {
		await expect(handleShowMedia([PNG], SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(stderrText()).toContain('Unsupported media file type "png"');
		expect(stderrText()).toContain("mp4, webm, mp3, m4a, wav, ogg");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects a clip one byte over the 300 MB cap before contacting the app, with exact sizes", async () => {
		const big = join(DIR, "big.mp4");
		writeFileSync(big, "");
		truncateSync(big, 300 * 1024 * 1024 + 1);
		await expect(handleShowMedia([big], SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(stderrText()).toContain("Media file too large");
		expect(stderrText()).toContain("314,572,801 bytes; max 300 MB = 314,572,800 bytes");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("sends clips at and just below the cap to the app with a long copy timeout", async () => {
		for (const size of [300 * 1024 * 1024 - 1, 300 * 1024 * 1024]) {
			mockSend.mockReset();
			mockSend.mockResolvedValue(okResp({ delivered: true, stored: 1, taskId: CTX.taskId }));
			const clip = join(DIR, `edge-${size}.mp4`);
			writeFileSync(clip, "");
			truncateSync(clip, size);
			await handleShowMedia([clip], SOCKET, CTX);
			expect(mockSend).toHaveBeenCalledWith(SOCKET, "ui.show-media", expect.anything(), { timeoutMs: 300_000 });
		}
	});

	it("keeps the 25 MB cap for images", async () => {
		const big = join(DIR, "big.png");
		writeFileSync(big, "");
		truncateSync(big, 25 * 1024 * 1024 + 1);
		await expect(handleShowImage([big], SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(stderrText()).toContain("max 25 MB = 26,214,400 bytes");
	});

	it.each([["video", MP4], ["audio", MP3]])("points show-image users at show-media for %s", async (_kind, path) => {
		await expect(handleShowImage([path], SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(stderrText()).toContain("dev3 show-media");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("names its own command in the orphan-caption error", async () => {
		await expect(handleShowMedia(["--caption", "x"], SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(stderrText()).toContain("must follow a media file path");
		expect(stderrText()).toContain("dev3 show-media demo.mp4");
	});
});
