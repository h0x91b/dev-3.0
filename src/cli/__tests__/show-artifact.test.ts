import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliResponse } from "../../shared/types";
import type { CliContext } from "../context";
import { handleShowArtifact } from "../commands/show-artifact";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));
import { sendRequest } from "../socket-client";

const mockSend = vi.mocked(sendRequest);
const SOCKET = "/tmp/test.sock";
const CTX: CliContext = {
	projectId: "proj-001",
	taskId: "aaaaaaaa-1111-2222-3333-444444444444",
	socketPath: SOCKET,
};
const DIR = mkdtempSync(join(tmpdir(), "dev3-showartifact-cli-"));
const HTML = join(DIR, "report.html");
const PNG = join(DIR, "chart.png");
const PNG2 = join(DIR, "diagram.webp");
writeFileSync(HTML, "<!doctype html><h1>Report</h1>");
writeFileSync(PNG, "PNG");
writeFileSync(PNG2, "WEBP");

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function okResp(data: unknown): CliResponse { return { id: "t", ok: true, data }; }

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
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

describe("show-artifact", () => {
	it("sends one HTML file plus every path following --images", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, stored: 1, taskId: CTX.taskId }));
		await handleShowArtifact([HTML, "--images", PNG, PNG2, "--title", "Metrics"], SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "ui.show-artifact", {
			taskId: CTX.taskId,
			projectId: CTX.projectId,
			htmlPath: HTML,
			imagePaths: [PNG, PNG2],
			title: "Metrics",
		});
	});

	it("supports an artifact with no images", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, stored: 1, taskId: CTX.taskId }));
		await handleShowArtifact([HTML], SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "ui.show-artifact", expect.objectContaining({ imagePaths: [] }));
	});

	it("rejects non-HTML input and unsupported assets", async () => {
		await expect(handleShowArtifact([PNG], SOCKET, CTX)).rejects.toThrow("EXIT_3");
		const txt = join(DIR, "bad.txt");
		writeFileSync(txt, "x");
		await expect(handleShowArtifact([HTML, "--images", txt], SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});
});
