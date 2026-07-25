/**
 * The native terminal's in-band bridge framing (seq 1300).
 *
 * The same wire carries tmux's bare terminal text and the native backend's
 * framed messages, so the decoder's most important property is that it says
 * "not mine" for anything it does not fully understand — a truncated, foreign
 * version, or plain-text frame must fall through to the terminal untouched
 * rather than throw or half-parse.
 */
import { describe, it, expect } from "vitest";
import {
	attachMessage,
	claimMessage,
	decodeNativeStreamMessage,
	encodeNativeStreamMessage,
	isNativeStreamMessage,
	outputMessage,
	parseSinceParam,
	ptyUrlWithSince,
	releaseMessage,
	roleMessage,
	NATIVE_STREAM_PROTOCOL_VERSION,
} from "../../shared/native-terminal-stream";

const ATTACH = {
	seq: 7,
	role: "writer" as const,
	sessionId: "dev3-task-abc",
	paneId: "dev3-task-abc:0",
	hostPid: 100,
	shellPid: 101,
	resumed: true,
};

describe("native stream framing", () => {
	it("round-trips an attach with its replay payload", () => {
		const decoded = decodeNativeStreamMessage(attachMessage(ATTACH, "hello\r\n"));

		expect(decoded?.header).toEqual({ t: "attach", v: NATIVE_STREAM_PROTOCOL_VERSION, ...ATTACH });
		expect(decoded?.payload).toBe("hello\r\n");
	});

	it("carries a reset reason only when the screen is being replaced", () => {
		const rebuilt = decodeNativeStreamMessage(
			attachMessage({ ...ATTACH, resumed: false, reset: "pressure" }, "screen"),
		);

		expect(rebuilt?.header).toMatchObject({ resumed: false, reset: "pressure" });
		expect(decodeNativeStreamMessage(attachMessage(ATTACH, ""))?.header).not.toHaveProperty("reset");
	});

	it("round-trips output, role, and ownership frames", () => {
		expect(decodeNativeStreamMessage(outputMessage(42, "data"))).toEqual({
			header: { t: "o", v: NATIVE_STREAM_PROTOCOL_VERSION, seq: 42 },
			payload: "data",
		});
		expect(decodeNativeStreamMessage(roleMessage("observer", true))?.header).toMatchObject({
			t: "role",
			role: "observer",
			refused: true,
		});
		expect(decodeNativeStreamMessage(claimMessage())?.header.t).toBe("claim");
		expect(decodeNativeStreamMessage(releaseMessage())?.header.t).toBe("release");
	});

	it("keeps a payload containing the frame marker intact", () => {
		// Terminal output can legitimately contain escape sequences; only the FIRST
		// header is consumed, everything after it is opaque bytes.
		const payload = `tail ${outputMessage(1, "inner")}`;
		const decoded = decodeNativeStreamMessage(outputMessage(9, payload));

		expect(decoded?.header).toMatchObject({ seq: 9 });
		expect(decoded?.payload).toBe(payload);
	});

	it("treats plain terminal text as not-a-frame", () => {
		expect(isNativeStreamMessage("$ ls -la\r\n")).toBe(false);
		expect(decodeNativeStreamMessage("$ ls -la\r\n")).toBeNull();
		expect(decodeNativeStreamMessage("\x1b[31mred\x1b[0m")).toBeNull();
	});

	it("refuses a truncated, malformed, or foreign-version frame", () => {
		expect(decodeNativeStreamMessage("\x1b_dev3nt;{\"t\":\"o\",\"v\":1,\"seq\":1}")).toBeNull();
		expect(decodeNativeStreamMessage("\x1b_dev3nt;not json\x1b\\payload")).toBeNull();
		expect(decodeNativeStreamMessage(encodeNativeStreamMessage({ t: "o", v: 99, seq: 1 }))).toBeNull();
		expect(decodeNativeStreamMessage(encodeNativeStreamMessage({ t: "o", v: 1 } as never))).toBeNull();
	});
});

describe("resume addressing", () => {
	it("leaves a URL untouched when there is no watermark (the tmux path)", () => {
		expect(ptyUrlWithSince("ws://host/pty?session=t1", null)).toBe("ws://host/pty?session=t1");
		expect(ptyUrlWithSince("ws://host/pty?session=t1", -1)).toBe("ws://host/pty?session=t1");
	});

	it("appends the watermark with the right separator", () => {
		expect(ptyUrlWithSince("ws://host/pty?session=t1", 12)).toBe("ws://host/pty?session=t1&since=12");
		expect(ptyUrlWithSince("ws://host/pty", 0)).toBe("ws://host/pty?since=0");
	});

	it("reads back only a sane watermark", () => {
		expect(parseSinceParam("12")).toBe(12);
		expect(parseSinceParam("0")).toBe(0);
		expect(parseSinceParam(null)).toBeNull();
		expect(parseSinceParam("")).toBeNull();
		expect(parseSinceParam("-3")).toBeNull();
		expect(parseSinceParam("1.5")).toBeNull();
		expect(parseSinceParam("nope")).toBeNull();
	});
});
