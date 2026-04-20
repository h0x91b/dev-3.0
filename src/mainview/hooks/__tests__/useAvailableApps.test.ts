import { renderHook, waitFor } from "@testing-library/react";
import { invalidateAvailableApps, useAvailableApps } from "../useAvailableApps";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAvailableApps: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";

const mockedApi = vi.mocked(api, true);

describe("useAvailableApps", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		invalidateAvailableApps();
	});

	afterEach(() => {
		invalidateAvailableApps();
	});

	it("refetches after an initial failure instead of caching an empty result forever", async () => {
		const availableApps = [{ id: "vscode", name: "VS Code", macAppName: "Visual Studio Code" }];

		mockedApi.request.getAvailableApps
			.mockRejectedValueOnce(new Error("temporary failure"))
			.mockResolvedValueOnce(availableApps);

		const firstHook = renderHook(() => useAvailableApps());

		await waitFor(() => {
			expect(mockedApi.request.getAvailableApps).toHaveBeenCalledTimes(1);
		});
		expect(firstHook.result.current).toEqual([]);

		firstHook.unmount();

		const secondHook = renderHook(() => useAvailableApps());

		await waitFor(() => {
			expect(mockedApi.request.getAvailableApps).toHaveBeenCalledTimes(2);
		});
		await waitFor(() => {
			expect(secondHook.result.current).toEqual(availableApps);
		});
	});
});
