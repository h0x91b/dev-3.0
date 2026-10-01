import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

vi.mock("qrcode", () => ({
	default: { toString: vi.fn(async (url: string) => `<QR ${url}>`) },
}));
vi.mock("../cloudflare-tunnel", () => ({
	tunnelManager: { list: () => [] },
}));

import { renderHeadlessBanner, startQrAutoRefresh, stopQrAutoRefresh } from "../remote-console";

const LOCAL_URL = "http://localhost:8090/?token=abc";
const TUNNEL_URL = "https://x.trycloudflare.com/?token=abc";

let output: string[];

beforeEach(() => {
	output = [];
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		output.push(args.join(" "));
	});
});

afterEach(() => {
	stopQrAutoRefresh();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

async function banner(accessUrl: string, tunnelUrl: string | null = null): Promise<string> {
	await renderHeadlessBanner({ port: 8090, tunnelUrl, tunnelRequested: !!tunnelUrl, accessUrl });
	return output.join("\n");
}

describe("headless banner QR", () => {
	it("prints the QR on the default all-interfaces bind", async () => {
		vi.stubEnv("DEV3_REMOTE_HOST", "");
		const text = await banner("http://192.168.1.5:8090/?token=abc");
		expect(text).toContain("<QR http://192.168.1.5:8090/?token=abc>");
	});

	it("skips the QR but keeps the URL on a loopback bind", async () => {
		vi.stubEnv("DEV3_REMOTE_HOST", "127.0.0.1");
		const text = await banner(LOCAL_URL);
		expect(text).not.toContain("<QR");
		expect(text).toContain(`  ${LOCAL_URL}`);
	});

	it("keeps the QR on a loopback bind when the URL is a tunnel", async () => {
		vi.stubEnv("DEV3_REMOTE_HOST", "127.0.0.1");
		const text = await banner(TUNNEL_URL, "https://x.trycloudflare.com");
		expect(text).toContain(`<QR ${TUNNEL_URL}>`);
	});

	it("refreshes only the URL on a loopback bind", async () => {
		vi.stubEnv("DEV3_REMOTE_HOST", "127.0.0.1");
		vi.useFakeTimers();
		startQrAutoRefresh(async () => LOCAL_URL);
		await vi.advanceTimersByTimeAsync(60_000);
		const text = output.join("\n");
		expect(text).not.toContain("<QR");
		expect(text).toContain("Access URL refreshed");
		expect(text).toContain(`URL: ${LOCAL_URL}`);
	});

	it("refreshes the QR on the default bind", async () => {
		vi.stubEnv("DEV3_REMOTE_HOST", "");
		vi.useFakeTimers();
		startQrAutoRefresh(async () => "http://192.168.1.5:8090/?token=new");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(output.join("\n")).toContain("<QR http://192.168.1.5:8090/?token=new>");
	});
});
