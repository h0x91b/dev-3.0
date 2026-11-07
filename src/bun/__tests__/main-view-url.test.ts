import { describe, expect, it, vi } from "vitest";
import { BUNDLED_MAIN_VIEW_URL, resolveMainViewUrl } from "../main-view-url";
import { viteDevPort, viteDevServerUrl } from "../../shared/vite-dev-server";

const log = { info: vi.fn(), warn: vi.fn() };

describe("viteDevPort", () => {
	it("reads the task-allocated DEV3_PORT1", () => {
		expect(viteDevPort({ DEV3_PORT1: "19461" })).toBe(19461);
		expect(viteDevServerUrl({ DEV3_PORT1: " 19461 " })).toBe("http://localhost:19461");
	});

	it("never falls back to a fixed port", () => {
		expect(viteDevPort({})).toBeNull();
		expect(viteDevPort({ DEV3_PORT0: "19460" })).toBeNull();
		expect(viteDevServerUrl({})).toBeNull();
	});

	it("rejects values that are not a usable port", () => {
		for (const raw of ["", "abc", "0", "65536", "-1", "5173.5"]) {
			expect(viteDevPort({ DEV3_PORT1: raw })).toBeNull();
		}
	});
});

describe("resolveMainViewUrl", () => {
	it("does not probe at all without a task port, so a server on 5173 cannot hijack the window", async () => {
		const probe = vi.fn().mockResolvedValue({});
		const url = await resolveMainViewUrl({ channel: "dev", env: {}, probe, log });
		expect(url).toBe(BUNDLED_MAIN_VIEW_URL);
		expect(probe).not.toHaveBeenCalled();
	});

	it("does not probe outside the dev channel even with a task port", async () => {
		const probe = vi.fn().mockResolvedValue({});
		const url = await resolveMainViewUrl({ channel: "stable", env: { DEV3_PORT1: "19461" }, probe, log });
		expect(url).toBe(BUNDLED_MAIN_VIEW_URL);
		expect(probe).not.toHaveBeenCalled();
	});

	it("uses the dev server on the task port when it answers", async () => {
		const probe = vi.fn().mockResolvedValue({});
		const url = await resolveMainViewUrl({ channel: "dev", env: { DEV3_PORT1: "19461" }, probe, log });
		expect(probe).toHaveBeenCalledWith("http://localhost:19461");
		expect(url).toBe("http://localhost:19461");
	});

	it("falls back to bundled assets when the task port does not answer", async () => {
		const probe = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
		const url = await resolveMainViewUrl({ channel: "dev", env: { DEV3_PORT1: "19461" }, probe, log });
		expect(url).toBe(BUNDLED_MAIN_VIEW_URL);
	});
});
