import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nProvider } from "../../i18n";
import { useMixedOrder } from "../useMixedOrder";
import type { MixedEntry } from "../../utils/digitOrder";
import type { Project } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: { request: { reorderMixedOrder: vi.fn() } },
}));
vi.mock("../../toast", () => ({ toast: { error: vi.fn() } }));

import { api } from "../../rpc";
import { toast } from "../../toast";

const project = (id: string): Project => ({
	id,
	name: id,
	path: `/tmp/${id}`,
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "",
});
const entries: MixedEntry[] = ["a", "b", "c"].map((id) => ({ kind: "project", project: project(id) }));
const idsOf = (list: MixedEntry[]) => list.map((e) => (e.kind === "project" ? e.project.id : e.space.id));

const wrapper = ({ children }: { children: ReactNode }) => <I18nProvider>{children}</I18nProvider>;

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(api.request.reorderMixedOrder).mockResolvedValue({} as never);
});

describe("useMixedOrder", () => {
	it("shows a step at once and writes the full order", async () => {
		const { result } = renderHook(() => useMixedOrder(entries), { wrapper });
		await act(async () => result.current.step("a", 1));
		expect(idsOf(result.current.entries)).toEqual(["b", "a", "c"]);
		expect(api.request.reorderMixedOrder).toHaveBeenCalledWith({ ids: ["b", "a", "c"] });
	});

	it("drops the stand-in on the first spaces push after the write, whatever the file holds", async () => {
		const { result } = renderHook(() => useMixedOrder(entries), { wrapper });
		await act(async () => result.current.step("a", 1));
		expect(idsOf(result.current.entries)).toEqual(["b", "a", "c"]);
		act(() => {
			window.dispatchEvent(new CustomEvent("rpc:spacesUpdated", { detail: { file: { version: 1, spaces: [], order: [] } } }));
		});
		expect(idsOf(result.current.entries)).toEqual(["a", "b", "c"]);
	});

	it("puts the old order back and toasts when the write fails", async () => {
		vi.mocked(api.request.reorderMixedOrder).mockRejectedValue(new Error("boom"));
		const { result } = renderHook(() => useMixedOrder(entries), { wrapper });
		await act(async () => result.current.reorder("c", "a", "before"));
		expect(idsOf(result.current.entries)).toEqual(["a", "b", "c"]);
		expect(toast.error).toHaveBeenCalled();
	});

	it("ignores a step off either end", async () => {
		const { result } = renderHook(() => useMixedOrder(entries), { wrapper });
		await act(async () => result.current.step("a", -1));
		expect(api.request.reorderMixedOrder).not.toHaveBeenCalled();
	});
});
