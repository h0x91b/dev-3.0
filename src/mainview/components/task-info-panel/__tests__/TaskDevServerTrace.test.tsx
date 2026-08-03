/**
 * The Dev Server buttons must correlate with their handlers (seq 1407).
 *
 * A Stop Dev Server click froze the whole UI while the backend finished cleanly, and
 * a later reproduction produced a "starting…" button with no handler run at all. The
 * only way to tell those two apart in a log is a correlation id the renderer mints
 * and the handler echoes — so the wiring that puts `opId` into the request params is
 * a real contract, not decoration.
 *
 * Scope: the RPC layer and the sink are both mocked here, so these tests prove what
 * the component SENDS. They prove nothing about delivery, about the backend, or about
 * a bridge that has stopped carrying traffic.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task, Project } from "../../../../shared/types";
import { I18nProvider } from "../../../i18n";
import { api } from "../../../rpc";
import TaskDevServer from "../TaskDevServer";

vi.mock("../../../rpc", () => ({
	api: {
		request: {
			checkDevServer: vi.fn(),
			runDevServer: vi.fn(),
			stopDevServer: vi.fn(),
			logRendererDiagnostic: vi.fn(),
		},
	},
	isElectrobun: false,
}));

const TASK = { id: "af011a56-da9a-4197-856e-d3da040f3293", projectId: "p1" } as unknown as Task;
const PROJECT = { id: "p1", name: "P", path: "/p", devScript: "bun run dev" } as unknown as Project;

/** Every `opId` the component has put into a request for `method`. */
function opIdsFor(method: "checkDevServer" | "runDevServer" | "stopDevServer"): string[] {
	return vi
		.mocked(api.request[method] as (p: { opId?: string }) => unknown)
		.mock.calls.map(([params]) => params?.opId ?? "");
}

beforeEach(() => {
	vi.mocked(api.request.checkDevServer).mockReset().mockResolvedValue({ running: false });
	vi.mocked(api.request.runDevServer).mockReset().mockResolvedValue({ running: true } as never);
	vi.mocked(api.request.stopDevServer).mockReset().mockResolvedValue({ running: false } as never);
	vi.mocked(api.request.logRendererDiagnostic).mockReset().mockResolvedValue(undefined as never);
});

function renderDevServer() {
	return render(
		<I18nProvider>
			<TaskDevServer task={TASK} project={PROJECT} isTaskActive />
		</I18nProvider>,
	);
}

describe("Dev Server action correlation", () => {
	it("sends an opId with the state poll", async () => {
		renderDevServer();
		await waitFor(() => expect(api.request.checkDevServer).toHaveBeenCalled());
		expect(opIdsFor("checkDevServer").every((id) => /^[0-9a-f]{8}$/.test(id))).toBe(true);
	});

	it("keeps a healthy poll out of the sink so gestures stay readable", async () => {
		renderDevServer();
		await waitFor(() => expect(api.request.checkDevServer).toHaveBeenCalled());
		// The poll runs every few seconds for every open task. Only a FAILING poll is
		// worth a line; a successful one must be silent.
		const polled = vi
			.mocked(api.request.logRendererDiagnostic)
			.mock.calls.map(([p]) => p)
			.filter((p) => p.tag === "dev-server" && String(p.message).startsWith("checkDevServer"));
		expect(polled).toEqual([]);
	});

	it("sends an opId when starting, and passes the same id to the sink call", async () => {
		renderDevServer();
		const button = await waitFor(() => screen.getByLabelText(/Dev server stopped/i));
		await userEvent.click(button);

		await waitFor(() => expect(api.request.runDevServer).toHaveBeenCalledTimes(1));
		const [params] = vi.mocked(api.request.runDevServer).mock.calls[0]!;
		expect(params).toMatchObject({ taskId: TASK.id, projectId: PROJECT.id });
		expect(params.opId).toMatch(/^[0-9a-f]{8}$/);

		// The sink is mocked, so this proves the component ASKS for those lines with the
		// matching id — not that anything was written to a log.
		await waitFor(() => {
			const traced = vi
				.mocked(api.request.logRendererDiagnostic)
				.mock.calls.map(([p]) => p)
				.filter((p) => p.tag === "dev-server" && p.extra?.opId === params.opId);
			expect(traced.map((p) => p.message)).toEqual(
				expect.arrayContaining([
					"runDevServer gesture",
					"runDevServer sent",
					"runDevServer settled",
				]),
			);
		});
	});

	it("asks the sink to record a rejected start instead of swallowing it", async () => {
		vi.mocked(api.request.runDevServer).mockRejectedValue(new Error("bridge gone"));
		renderDevServer();
		const button = await waitFor(() => screen.getByLabelText(/Dev server stopped/i));
		await userEvent.click(button);

		await waitFor(() => {
			const rejected = vi
				.mocked(api.request.logRendererDiagnostic)
				.mock.calls.map(([p]) => p)
				.filter((p) => p.tag === "dev-server" && p.message === "runDevServer rejected");
			expect(rejected).toHaveLength(1);
			expect(String(rejected[0]!.extra?.error)).toContain("bridge gone");
		});
	});

	it("gives every start a distinct opId across repeated clicks", async () => {
		renderDevServer();
		const button = await waitFor(() => screen.getByLabelText(/Dev server stopped/i));
		for (let i = 0; i < 3; i++) {
			vi.mocked(api.request.runDevServer).mockResolvedValueOnce({ running: false } as never);
			await userEvent.click(button);
			await waitFor(() => expect(api.request.runDevServer).toHaveBeenCalledTimes(i + 1));
		}
		const ids = opIdsFor("runDevServer");
		expect(new Set(ids).size).toBe(ids.length);
	});
});
