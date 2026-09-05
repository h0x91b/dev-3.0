import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleEvents } from "../commands/events";
import type { CliContext } from "../context";
import type { ParsedArgs } from "../args";
import type { CliResponse } from "../../shared/types";
import type { BoardEvent, EventSelection } from "../../shared/board-events";
import { EVENT_CURSOR_UNRESOLVED_PREFIX } from "../../shared/board-events";
import { CLI_EXIT_CODE_EVENT_CURSOR_INVALID, CLI_EXIT_CODE_USAGE_ERROR } from "../../shared/cli-exit-codes";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));

import { sendRequest } from "../socket-client";
const mockSend = vi.mocked(sendRequest);

const SOCKET = "/tmp/test.sock";
const CTX: CliContext = {
	projectId: "proj-001",
	taskId: "aaaaaaaa-1111-2222-3333-444444444444",
	socketPath: SOCKET,
};

function event(overrides?: Partial<BoardEvent>): BoardEvent {
	return {
		kind: "note",
		at: "2026-08-29T10:12:03.114Z",
		id: "86b9b644-1111-2222-3333-444444444444",
		projectId: "proj-001",
		projectName: "dev-3.0",
		taskId: "cccccccc-1111-2222-3333-444444444444",
		seq: 1738,
		taskTitle: "Add dev3 events",
		taskStatus: "completed",
		source: "ai",
		text: "Notes live as Task.notes[] inside tasks.json",
		...overrides,
	};
}

function selection(overrides?: Partial<EventSelection>): EventSelection {
	const events = overrides?.events ?? [event()];
	return {
		events,
		droppedNewer: 0,
		olderThanWindow: 0,
		matched: events.length,
		cursor: events.length ? "2026-08-29T10:12:03.114" : null,
		...overrides,
	};
}

function okResp(data: unknown): CliResponse {
	return { id: "test-id", ok: true, data };
}

function errResp(error: string): CliResponse {
	return { id: "test-id", ok: false, error };
}

function args(flags: Record<string, string> = {}, positional: string[] = []): ParsedArgs {
	return { positional, flags };
}

let stdoutOutput: string;
let stderrOutput: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	stdoutOutput = "";
	stderrOutput = "";
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdoutOutput += String(chunk);
		return true;
	});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderrOutput += String(chunk);
		return true;
	});
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

describe("dev3 events — the cursor is never guessed", () => {
	it("exits 19 and reads nothing when --from cannot be parsed", async () => {
		await expect(handleEvents(args({ from: "yesterday" }), SOCKET, CTX)).rejects.toThrow(
			`EXIT_${CLI_EXIT_CODE_EVENT_CURSOR_INVALID}`,
		);
		expect(mockSend).not.toHaveBeenCalled();
		expect(stderrOutput).toContain("Unparseable --from value: yesterday");
		expect(stderrOutput).toContain("Four shapes are accepted");
	});

	it("accepts a duration and resolves it to an instant before sending", async () => {
		mockSend.mockResolvedValue(okResp(selection()));

		await handleEvents(args({ from: "2h" }), SOCKET, CTX);

		const sent = mockSend.mock.calls[0]![2]!.cursor as string;
		expect(sent).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		const ageMs = Date.now() - Date.parse(sent);
		expect(ageMs).toBeGreaterThan(2 * 60 * 60 * 1000 - 5000);
		expect(ageMs).toBeLessThan(2 * 60 * 60 * 1000 + 5000);
	});

	it("is a usage error when --from carries no value", async () => {
		await expect(handleEvents(args({ from: "true" }), SOCKET, CTX)).rejects.toThrow(
			`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`,
		);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("sends an id prefix as cursorId, leaving the instant for the app to resolve", async () => {
		mockSend.mockResolvedValue(okResp(selection({ from: "2026-08-29T09:00:00.000" })));

		await handleEvents(args({ from: "8eb2da3d" }), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "events.list", {
			limit: 100,
			cursor: null,
			cursorId: "8eb2da3d",
			projectId: "proj-001",
		});
	});

	it("keeps the position after a quiet sweep started from an id", async () => {
		mockSend.mockResolvedValue(okResp(selection({
			events: [], cursor: null, matched: 0, from: "2026-08-29T09:00:00.000",
		})));

		await handleEvents(args({ from: "8eb2da3d" }), SOCKET, CTX);

		expect(stdoutOutput).toContain("Cursor: 2026-08-29T09:00:00.000");
		expect(stdoutOutput).not.toContain("none yet");
	});

	it("reports an id that resolves to nothing as exit 19, not a failed read", async () => {
		mockSend.mockResolvedValue(errResp(
			`${EVENT_CURSOR_UNRESOLVED_PREFIX}no event id starts with "deadbeef".\nA task keeps only its 50 most recent notes.`,
		));

		await expect(handleEvents(args({ from: "deadbeef" }), SOCKET, CTX)).rejects.toThrow(
			`EXIT_${CLI_EXIT_CODE_EVENT_CURSOR_INVALID}`,
		);
		expect(stderrOutput).toContain('no event id starts with "deadbeef"');
		expect(stderrOutput).not.toContain(EVENT_CURSOR_UNRESOLVED_PREFIX);
	});

	it("sends the parsed cursor to the app", async () => {
		mockSend.mockResolvedValue(okResp(selection()));

		await handleEvents(args({ from: "2026-08-29T09:00:00.000" }), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "events.list", {
			limit: 100,
			cursor: "2026-08-29T09:00:00.000Z",
			projectId: "proj-001",
		});
	});
});

describe("dev3 events — the footer never lies about what was cut", () => {
	it("names the window as a window and counts what is older than it", async () => {
		mockSend.mockResolvedValue(okResp(selection({ olderThanWindow: 340 })));

		await handleEvents(args(), SOCKET, CTX);

		expect(stdoutOutput).toContain("WINDOW, not a position");
		expect(stdoutOutput).toContain("Older than the window: 340 events NOT shown.");
		expect(stdoutOutput).toContain("Cursor: 2026-08-29T10:12:03.114");
		expect(stdoutOutput).toContain("Next:   dev3 events --from 2026-08-29T10:12:03.114");
	});

	it("says plainly when the window cut nothing off", async () => {
		mockSend.mockResolvedValue(okResp(selection()));

		await handleEvents(args(), SOCKET, CTX);

		expect(stdoutOutput).toContain("Older than the window: 0 events. Nothing was cut off.");
	});

	it("reports the cap as a number and says the oldest were kept", async () => {
		mockSend.mockResolvedValue(okResp(selection({ droppedNewer: 43, matched: 143 })));

		await handleEvents(args({ limit: "100" }), SOCKET, CTX);

		expect(stdoutOutput).toContain("Capped at --limit 100: 43 NEWER events not shown.");
		expect(stdoutOutput).toContain("leaves no hole");
	});

	it("echoes the incoming cursor on a quiet sweep so the caller keeps a position", async () => {
		mockSend.mockResolvedValue(okResp(selection({ events: [], cursor: null, matched: 0 })));

		await handleEvents(args({ from: "2026-08-29T10:12:03.114" }), SOCKET, CTX);

		expect(stdoutOutput).toContain("No events");
		expect(stdoutOutput).toContain("0 events since 2026-08-29T10:12:03.114.");
		expect(stdoutOutput).toContain("Cursor: 2026-08-29T10:12:03.114");
	});
});

describe("dev3 events — the line carries its owner", () => {
	it("prints seq, status and title next to every note", async () => {
		mockSend.mockResolvedValue(okResp(selection()));

		await handleEvents(args(), SOCKET, CTX);

		expect(stdoutOutput).toContain("KIND");
		expect(stdoutOutput).toContain("note");
		expect(stdoutOutput).toContain("1738");
		expect(stdoutOutput).toContain("completed");
		expect(stdoutOutput).toContain("Add dev3 events");
		expect(stdoutOutput).toContain("86b9b644");
	});

	it("adds a PROJECT column only when the sweep spans boards", async () => {
		mockSend.mockResolvedValue(okResp(selection()));
		await handleEvents(args({ project: "all" }), SOCKET, CTX);
		expect(stdoutOutput).toContain("PROJECT");
		expect(mockSend.mock.calls[0]![2]).not.toHaveProperty("projectId");

		stdoutOutput = "";
		mockSend.mockResolvedValue(okResp(selection()));
		await handleEvents(args(), SOCKET, CTX);
		expect(stdoutOutput).not.toContain("PROJECT");
	});
});

describe("dev3 events — argument guards", () => {
	it("echoes the RESOLVED instant, not the duration, on a quiet sweep", async () => {
		mockSend.mockResolvedValue(okResp(selection({ events: [], cursor: null, matched: 0 })));

		await handleEvents(args({ from: "2h" }), SOCKET, CTX);

		expect(stdoutOutput).toContain("0 events since 2h.");
		expect(stdoutOutput).not.toContain("Cursor: 2h");
		expect(stdoutOutput).toMatch(/Cursor: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\n/);
	});
});

describe("dev3 events — argument guards", () => {
	it("rejects an unknown flag", async () => {
		await expect(handleEvents(args({ since: "2h" }), SOCKET, CTX)).rejects.toThrow(
			`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`,
		);
		expect(stderrOutput).toContain("--since");
	});

	it("rejects a positional, since there is no subcommand", async () => {
		await expect(handleEvents(args({}, ["list"]), SOCKET, CTX)).rejects.toThrow(
			`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`,
		);
	});

	it("rejects a non-numeric or zero --limit", async () => {
		await expect(handleEvents(args({ limit: "lots" }), SOCKET, CTX)).rejects.toThrow(
			`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`,
		);
		await expect(handleEvents(args({ limit: "0" }), SOCKET, CTX)).rejects.toThrow(
			`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`,
		);
	});

	it("clamps --limit to the maximum instead of asking the app for everything", async () => {
		mockSend.mockResolvedValue(okResp(selection()));
		await handleEvents(args({ limit: "99999" }), SOCKET, CTX);
		expect(mockSend.mock.calls[0]![2]!.limit).toBe(1000);
	});

	it("rejects an unknown --kind", async () => {
		await expect(handleEvents(args({ kind: "movements" }), SOCKET, CTX)).rejects.toThrow(
			`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`,
		);
	});

	it("emits the raw selection under --json", async () => {
		mockSend.mockResolvedValue(okResp(selection({ olderThanWindow: 5 })));
		await handleEvents(args({ json: "true" }), SOCKET, CTX);
		expect(JSON.parse(stdoutOutput).olderThanWindow).toBe(5);
	});

	describe("movements are a filter, not a reshape", () => {
		const moveEvent = () => event({
			kind: "move",
			id: "aaaa0001-1111-2222-3333-444444444444",
			source: undefined,
			movement: { kind: "status", from: "in-progress", to: "completed" },
			text: "Agent is Working → Completed",
		});

		it("accepts --kind move and passes it to the app", async () => {
			mockSend.mockResolvedValue(okResp(selection({ events: [moveEvent()] })));
			await handleEvents(args({ kind: "move" }), SOCKET, CTX);
			expect(mockSend.mock.calls[0]![2]!.kind).toBe("move");
			expect(stdoutOutput).toContain("move");
			expect(stdoutOutput).toContain("Agent is Working → Completed");
		});

		it("sends no kind at all when the caller did not filter", async () => {
			mockSend.mockResolvedValue(okResp(selection()));
			await handleEvents(args(), SOCKET, CTX);
			expect(mockSend.mock.calls[0]![2]!).not.toHaveProperty("kind");
		});

		// A cursor earned under a filter does not cover the kinds that filter hid.
		it("warns that a filtered cursor only advances over that kind", async () => {
			mockSend.mockResolvedValue(okResp(selection({ events: [moveEvent()] })));
			await handleEvents(args({ kind: "move" }), SOCKET, CTX);
			expect(stdoutOutput).toContain("the cursor below advances over move events ONLY");
		});

		it("stays silent about filtering when nothing was filtered", async () => {
			mockSend.mockResolvedValue(okResp(selection()));
			await handleEvents(args(), SOCKET, CTX);
			expect(stdoutOutput).not.toContain("advances over");
		});

		// Retention loss is stated as a number: a trimmed log presented as complete
		// is the same silent loss the cursor exists to prevent.
		it("says how many movements the cap destroyed inside the range", async () => {
			mockSend.mockResolvedValue(okResp(selection({ movementsEvicted: 7 })));
			await handleEvents(args({ from: "2026-08-01" }), SOCKET, CTX);
			expect(stdoutOutput).toContain("Retention loss: 7 movements were evicted");
			expect(stdoutOutput).toContain("NOT complete");
		});

		it("says nothing about retention when the cap destroyed nothing in range", async () => {
			mockSend.mockResolvedValue(okResp(selection({ movementsEvicted: 0 })));
			await handleEvents(args({ from: "2026-08-01" }), SOCKET, CTX);
			expect(stdoutOutput).not.toContain("Retention loss");
		});
	});
});
