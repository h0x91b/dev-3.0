import { describe, it, expect, vi, beforeEach } from "vitest";

const { openPathMock, infoMock } = vi.hoisted(() => ({
	openPathMock: vi.fn(),
	infoMock: vi.fn(),
}));

vi.mock("electrobun/bun", () => ({
	Utils: {
		openPath: openPathMock,
	},
}));

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: infoMock,
		warn: vi.fn(),
		error: vi.fn(),
	}),
	getLogPath: vi.fn(() => "/tmp/test-dev3/logs"),
}));

import { openLogsDirectory } from "../menu-actions";

describe("openLogsDirectory", () => {
	beforeEach(() => {
		openPathMock.mockClear();
		infoMock.mockClear();
	});

	it("opens the app logs directory via Utils.openPath", () => {
		const result = openLogsDirectory();

		expect(result).toBe("/tmp/test-dev3/logs");
		expect(openPathMock).toHaveBeenCalledWith("/tmp/test-dev3/logs");
		expect(infoMock).toHaveBeenCalledWith("Opening logs directory", { path: "/tmp/test-dev3/logs" });
	});
});
