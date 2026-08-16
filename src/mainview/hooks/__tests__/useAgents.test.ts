import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CodingAgent } from "../../../shared/types";
import { useAgents } from "../useAgents";

vi.mock("../../rpc", () => ({
	api: { request: { getAgents: vi.fn() } },
}));

import { api } from "../../rpc";

function agent(presetName: string): CodingAgent {
	return {
		id: "builtin-claude",
		name: "Claude",
		baseCommand: "claude",
		configurations: [{ id: "c1", name: presetName }],
	} as CodingAgent;
}

describe("useAgents", () => {
	it("loads the presets once on mount", async () => {
		vi.mocked(api.request.getAgents).mockResolvedValue([agent("Auto - luna")]);
		const { result } = renderHook(() => useAgents());
		await waitFor(() => expect(result.current).toHaveLength(1));
		expect(result.current[0].configurations[0].name).toBe("Auto - luna");
	});

	it("follows a preset saved elsewhere, instead of offering the old list", async () => {
		vi.mocked(api.request.getAgents).mockResolvedValue([agent("Auto - luna")]);
		const { result } = renderHook(() => useAgents());
		await waitFor(() => expect(result.current).toHaveLength(1));

		act(() => {
			window.dispatchEvent(new CustomEvent("rpc:agentsUpdated", { detail: [agent("OpenRouter")] }));
		});
		expect(result.current[0].configurations[0].name).toBe("OpenRouter");
	});

	it("stops listening once the surface is gone", async () => {
		vi.mocked(api.request.getAgents).mockResolvedValue([agent("Auto - luna")]);
		const { result, unmount } = renderHook(() => useAgents());
		await waitFor(() => expect(result.current).toHaveLength(1));
		unmount();
		act(() => {
			window.dispatchEvent(new CustomEvent("rpc:agentsUpdated", { detail: [agent("OpenRouter")] }));
		});
		expect(result.current[0].configurations[0].name).toBe("Auto - luna");
	});

	it("keeps an empty list when the fetch fails, rather than throwing", async () => {
		vi.mocked(api.request.getAgents).mockRejectedValue(new Error("transport down"));
		const { result } = renderHook(() => useAgents());
		await waitFor(() => expect(result.current).toEqual([]));
	});
});
