import { renderHook, waitFor } from "@testing-library/react";
import type { GlobalSettings } from "../../../shared/types";
import { useToggleFavorite } from "../useToggleFavorite";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			toggleFavoriteAgent: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";

const mockedApi = vi.mocked(api, true);

const SETTINGS = { updateChannel: "stable", favorites: [] } as unknown as GlobalSettings;

describe("useToggleFavorite", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("toggles server-side and bubbles the fresh settings to applySettings", async () => {
		mockedApi.request.toggleFavoriteAgent.mockResolvedValue(SETTINGS);
		const applySettings = vi.fn();

		const { result } = renderHook(() => useToggleFavorite(applySettings));
		await result.current("builtin-codex", "codex-default");

		expect(mockedApi.request.toggleFavoriteAgent).toHaveBeenCalledWith({
			agentId: "builtin-codex",
			configId: "codex-default",
		});
		await waitFor(() => expect(applySettings).toHaveBeenCalledWith(SETTINGS));
	});

	it("swallows a toggle failure without calling applySettings or throwing", async () => {
		mockedApi.request.toggleFavoriteAgent.mockRejectedValue(new Error("boom"));
		const applySettings = vi.fn();

		const { result } = renderHook(() => useToggleFavorite(applySettings));
		await expect(result.current("a", "c")).resolves.toBeUndefined();

		expect(applySettings).not.toHaveBeenCalled();
	});

	it("no-ops applySettings when none is provided", async () => {
		mockedApi.request.toggleFavoriteAgent.mockResolvedValue(SETTINGS);

		const { result } = renderHook(() => useToggleFavorite(undefined));
		await expect(result.current("a", "c")).resolves.toBeUndefined();

		expect(mockedApi.request.toggleFavoriteAgent).toHaveBeenCalledTimes(1);
	});
});
