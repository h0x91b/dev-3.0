import { describe, expect, it, vi } from "vitest";
import { BUNDLED_MAIN_VIEW_URL, resolveMainViewUrl } from "../main-view-url";
import { viteDevPort, viteDevServerUrl } from "../../shared/vite-dev-server";

const log = { info: vi.fn(), warn: vi.fn() };

describe("viteDevPort", () => {
	it("reads only the task-allocated DEV3_PORT1, never a fixed fallback, and rejects unusable values", () => {
		expect(viteDevPort({ DEV3_PORT1: "19461" })).toBe(19461);
		expect(viteDevServerUrl({ DEV3_PORT1: " 19461 " })).toBe("http://localhost:19461");
		expect(viteDevPort({})).toBeNull();
		expect(viteDevPort({ DEV3_PORT0: "19460" })).toBeNull();
		expect(viteDevServerUrl({})).toBeNull();
		for (const raw of ["", "abc", "0", "65536", "-1", "5173.5"]) {
			expect(viteDevPort({ DEV3_PORT1: raw }), raw).toBeNull();
		}
	});
});

describe("resolveMainViewUrl", () => {
	it("does not probe without a task port (so a server on 5173 cannot hijack the window) or outside the dev channel", async () => {
		const probe = vi.fn().mockResolvedValue({});
		expect(await resolveMainViewUrl({ channel: "dev", env: {}, probe, log })).toBe(BUNDLED_MAIN_VIEW_URL);
		expect(await resolveMainViewUrl({ channel: "stable", env: { DEV3_PORT1: "19461" }, probe, log })).toBe(BUNDLED_MAIN_VIEW_URL);
		expect(probe).not.toHaveBeenCalled();
	});

	it("uses the dev server on the task port when it answers, and bundled assets when it does not", async () => {
		const probe = vi.fn().mockResolvedValue({});
		expect(await resolveMainViewUrl({ channel: "dev", env: { DEV3_PORT1: "19461" }, probe, log })).toBe("http://localhost:19461");
		expect(probe).toHaveBeenCalledWith("http://localhost:19461");

		const refused = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
		expect(await resolveMainViewUrl({ channel: "dev", env: { DEV3_PORT1: "19461" }, probe: refused, log })).toBe(BUNDLED_MAIN_VIEW_URL);
	});
});
