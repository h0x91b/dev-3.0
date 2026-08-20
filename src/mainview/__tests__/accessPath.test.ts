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

	// `location.hostname` keeps the brackets, so the bare `::1` form never arrives
	// from a browser — without the bracketed spelling this was labelled a tunnel.
	it("names IPv6 loopback in the spelling a browser actually reports", () => {
		expect(describeAccessPath(new URL("http://[::1]:3000/").hostname).kind).toBe("local");
	});

	it("carries the host through for display", () => {
		expect(describeAccessPath("192.168.1.42").host).toBe("192.168.1.42");
	});

	it("does not claim to be local when it has no hostname at all", () => {
		expect(describeAccessPath("").host).toBe("unknown");
	});

	// A custom domain, a bare LAN name, a Tailscale host: routed, but we cannot say
	// by what. Claiming "direct" would say the tunnel is out of the picture when it
	// may not be; claiming "Cloudflare" accuses a carrier that may not be involved.
	it("admits it does not know the route instead of naming Cloudflare", () => {
		expect(describeAccessPath("dev3.example.com").kind).toBe("other");
		expect(describeAccessPath("mac-studio").kind).toBe("other");
		expect(describeAccessPath("mac-studio.tail1234.ts.net").kind).toBe("other");
		expect(describeAccessPath("dev3.example.com").labelKey).toBe("connQuality.pathOther");
	});
});
