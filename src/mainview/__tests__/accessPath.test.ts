import { describe, it, expect } from "vitest";
import { describeAccessPath } from "../utils/accessPath";

describe("describeAccessPath", () => {
	it("names a Cloudflare quick tunnel", () => {
		expect(describeAccessPath("brave-tiger-hums.trycloudflare.com").kind).toBe("tunnel");
	});

	it("names a named-tunnel host", () => {
		expect(describeAccessPath("abc123.cfargotunnel.com").kind).toBe("tunnel");
	});

	it("names the interface picker's direct LAN address", () => {
		expect(describeAccessPath("192.168.1.42").kind).toBe("lan");
		expect(describeAccessPath("mac-studio.local").kind).toBe("lan");
	});

	it("names the same machine", () => {
		expect(describeAccessPath("localhost").kind).toBe("local");
		expect(describeAccessPath("127.0.0.1").kind).toBe("local");
	});

	it("carries the host through for display", () => {
		expect(describeAccessPath("192.168.1.42").host).toBe("192.168.1.42");
	});

	it("does not claim to be local when it has no hostname at all", () => {
		expect(describeAccessPath("").host).toBe("unknown");
	});

	// A custom domain in front of a named tunnel is indistinguishable from a plain
	// reverse proxy from the renderer. Claiming "direct" would be the wrong error:
	// it would tell the reader the tunnel is out of the picture when it may not be.
	it("treats an unknown domain as routed, not as direct", () => {
		expect(describeAccessPath("dev3.example.com").kind).toBe("tunnel");
	});
});
