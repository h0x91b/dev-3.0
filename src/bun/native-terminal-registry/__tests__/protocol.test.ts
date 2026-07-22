import { describe, expect, it } from "vitest";
import {
	decodeControl,
	encodeControl,
	NATIVE_SESSION_PROTOCOL_VERSION,
	resizeMessage,
	statusRequest,
	stopRequest,
} from "../protocol";

describe("native-session protocol", () => {
	it("round-trips control messages", () => {
		for (const msg of [resizeMessage(120, 40), statusRequest(), stopRequest()]) {
			expect(decodeControl(encodeControl(msg))).toEqual(msg);
		}
	});

	it("rejects non-JSON, wrong version, and unknown types", () => {
		expect(decodeControl("{not json")).toBeNull();
		expect(decodeControl(JSON.stringify({ v: NATIVE_SESSION_PROTOCOL_VERSION + 1, type: "status" }))).toBeNull();
		expect(decodeControl(JSON.stringify({ v: NATIVE_SESSION_PROTOCOL_VERSION, type: "nope" }))).toBeNull();
		expect(decodeControl(JSON.stringify({ v: NATIVE_SESSION_PROTOCOL_VERSION, type: "resize", cols: "x", rows: 1 }))).toBeNull();
	});
});
