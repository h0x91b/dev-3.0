import { describe, it, expect } from "vitest";
import { rankInterface, prioritizeInterfaces } from "../network-interfaces";

describe("rankInterface", () => {
	it("ranks physical LAN (en*/eth*) highest", () => {
		expect(rankInterface({ name: "en0", address: "192.168.1.48" })).toBe(3);
		expect(rankInterface({ name: "en8", address: "192.168.1.18" })).toBe(3);
		expect(rankInterface({ name: "eth0", address: "10.0.0.5" })).toBe(3);
	});

	it("ranks VPN tunnels as non-routable", () => {
		expect(rankInterface({ name: "utun4", address: "192.168.19.228" })).toBe(1);
		expect(rankInterface({ name: "ipsec0", address: "10.8.0.2" })).toBe(1);
		expect(rankInterface({ name: "ppp0", address: "10.9.0.2" })).toBe(1);
		expect(rankInterface({ name: "wg0", address: "10.7.0.2" })).toBe(1);
	});

	it("ranks VM / Internet-Sharing bridges as non-routable", () => {
		expect(rankInterface({ name: "bridge100", address: "192.168.64.1" })).toBe(1);
		expect(rankInterface({ name: "vmenet0", address: "192.168.66.1" })).toBe(1);
	});

	it("ranks Apple peer-to-peer and hotspot links as non-routable", () => {
		expect(rankInterface({ name: "awdl0", address: "169.254.10.1" })).toBe(1);
		expect(rankInterface({ name: "llw0", address: "169.254.11.1" })).toBe(1);
		expect(rankInterface({ name: "ap1", address: "192.168.99.1" })).toBe(1);
	});

	it("ranks link-local 169.254.* as non-routable regardless of name", () => {
		expect(rankInterface({ name: "en5", address: "169.254.1.2" })).toBe(1);
	});

	it("ranks loopback / internal last", () => {
		expect(rankInterface({ name: "loopback", address: "127.0.0.1", internal: true })).toBe(0);
	});

	it("keeps unknown adapters below real LAN but above non-routable", () => {
		expect(rankInterface({ name: "tailscale0", address: "100.64.0.1" })).toBe(2);
	});
});

describe("prioritizeInterfaces", () => {
	it("floats en0 above VPN and bridge that the OS enumerated first", () => {
		// Real macOS ordering from the incident: utun4, bridge100, en0, en8.
		const raw = [
			{ name: "utun4", address: "192.168.19.228", internal: false },
			{ name: "bridge100", address: "192.168.64.1", internal: false },
			{ name: "en0", address: "192.168.1.48", internal: false },
			{ name: "en8", address: "192.168.1.18", internal: false },
		];
		const ordered = prioritizeInterfaces(raw).map((i) => i.address);
		expect(ordered[0]).toBe("192.168.1.48"); // en0 — the reachable LAN address
		expect(ordered[1]).toBe("192.168.1.18"); // en8 — also physical LAN
		expect(ordered.slice(2)).toEqual(["192.168.19.228", "192.168.64.1"]);
	});

	it("keeps loopback last", () => {
		const raw = [
			{ name: "loopback", address: "127.0.0.1", internal: true },
			{ name: "en0", address: "192.168.1.48", internal: false },
			{ name: "utun4", address: "192.168.19.228", internal: false },
		];
		const ordered = prioritizeInterfaces(raw).map((i) => i.address);
		expect(ordered[0]).toBe("192.168.1.48");
		expect(ordered[ordered.length - 1]).toBe("127.0.0.1");
	});

	it("preserves OS order within the same rank (stable)", () => {
		const raw = [
			{ name: "en8", address: "192.168.1.18", internal: false },
			{ name: "en0", address: "192.168.1.48", internal: false },
		];
		const ordered = prioritizeInterfaces(raw).map((i) => i.address);
		expect(ordered).toEqual(["192.168.1.18", "192.168.1.48"]);
	});

	it("does not mutate its input", () => {
		const raw = [
			{ name: "utun4", address: "192.168.19.228", internal: false },
			{ name: "en0", address: "192.168.1.48", internal: false },
		];
		const before = raw.map((i) => i.address);
		prioritizeInterfaces(raw);
		expect(raw.map((i) => i.address)).toEqual(before);
	});

	it("returns 'localhost'-safe empty result when no interfaces", () => {
		expect(prioritizeInterfaces([])).toEqual([]);
	});
});
