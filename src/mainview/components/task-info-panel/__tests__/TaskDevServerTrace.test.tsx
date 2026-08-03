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

	it("traces a real Stop click, and calls its paint optimistic rather than settled", async () => {
		vi.mocked(api.request.checkDevServer).mockResolvedValue({ running: true });
		renderDevServer();
		// Running state: the button opens the menu instead of starting.
		const button = await waitFor(() => screen.getByLabelText(/Dev server running/i));
		await userEvent.click(button);
		await userEvent.click(await waitFor(() => screen.getByText("Stop")));

		await waitFor(() => expect(api.request.stopDevServer).toHaveBeenCalledTimes(1));
		const [params] = vi.mocked(api.request.stopDevServer).mock.calls[0]!;
		expect(params).toMatchObject({ taskId: TASK.id, projectId: PROJECT.id });
		expect(params.opId).toMatch(/^[0-9a-f]{8}$/);

		const tracedMessages = () =>
			new Set(
				vi
					.mocked(api.request.logRendererDiagnostic)
					.mock.calls.map(([p]) => p)
					.filter((p) => p.extra?.opId === params.opId)
					.map((p) => String(p.message)),
			);
		// A Set, and one boundary per wait: the four arrive across separate ticks, so a
		// single sample of all four is a race under load.
		for (const boundary of ["gesture", "sent", "optimistic-rendered", "settled"]) {
			await waitFor(() => expect(tracedMessages()).toContain(`stopDevServer ${boundary}`), {
				timeout: 3_000,
			});
		}
		// Stop paints "stopped" before the backend agrees, so a settle-relative render
		// number would be a fiction.
		expect(tracedMessages()).not.toContain("stopDevServer rendered");
		const optimistic = vi
			.mocked(api.request.logRendererDiagnostic)
			.mock.calls.map(([p]) => p)
			.find((p) => p.message === "stopDevServer optimistic-rendered")!;
		expect(optimistic.extra).toHaveProperty("gestureToRenderMs");
		expect(optimistic.extra).not.toHaveProperty("settleToRenderMs");
	});

	it("reports a poll that never settles once it crosses the stall threshold", async () => {
		vi.useFakeTimers();
		try {
			// A request that simply never comes back — the incident's own signature.
			vi.mocked(api.request.checkDevServer).mockReturnValue(new Promise(() => {}) as never);
			renderDevServer();
			await vi.advanceTimersByTimeAsync(200);
			const stalledBefore = vi
				.mocked(api.request.logRendererDiagnostic)
				.mock.calls.map(([p]) => p)
				.filter((p) => p.message === "checkDevServer stalled");
			expect(stalledBefore).toEqual([]);

			await vi.advanceTimersByTimeAsync(9_000);
			const stalled = vi
				.mocked(api.request.logRendererDiagnostic)
				.mock.calls.map(([p]) => p)
				.filter((p) => p.message === "checkDevServer stalled");
			expect(stalled.length).toBeGreaterThan(0);
			expect(stalled[0]!.level).toBe("warn");
			expect(stalled[0]!.extra?.opId).toMatch(/^[0-9a-f]{8}$/);
		} finally {
			vi.useRealTimers();
		}
	});

	it("emits BOTH render boundaries for a deferred start, in order", async () => {
		let resolveStart: ((v: unknown) => void) | null = null;
		vi.mocked(api.request.runDevServer).mockReturnValue(
			new Promise((resolve) => {
				resolveStart = resolve;
			}) as never,
		);
		renderDevServer();
		await userEvent.click(await waitFor(() => screen.getByLabelText(/Dev server stopped/i)));

		await waitFor(() => expect(api.request.runDevServer).toHaveBeenCalledTimes(1));
		const opId = vi.mocked(api.request.runDevServer).mock.calls[0]![0].opId;
		const lines = () =>
			vi
				.mocked(api.request.logRendererDiagnostic)
				.mock.calls.map(([p]) => p)
				.filter((p) => p.extra?.opId === opId);

		// While the request is still in flight, only the optimistic paint exists.
		await waitFor(() =>
			expect(lines().map((p) => p.message)).toContain("runDevServer optimistic-rendered"),
		);
		expect(lines().map((p) => p.message)).not.toContain("runDevServer rendered");

		resolveStart!({ running: true });
		await waitFor(() => expect(lines().map((p) => p.message)).toContain("runDevServer rendered"));

		const messages = lines().map((p) => String(p.message));
		// Order matters: the optimistic paint happened first and must be reported first.
		expect(messages.indexOf("runDevServer optimistic-rendered")).toBeLessThan(
			messages.indexOf("runDevServer rendered"),
		);
		const optimistic = lines().find((p) => p.message === "runDevServer optimistic-rendered")!;
		const settled = lines().find((p) => p.message === "runDevServer rendered")!;
		expect(optimistic.extra).toHaveProperty("gestureToRenderMs");
		expect(optimistic.extra).not.toHaveProperty("settleToRenderMs");
		expect(settled.extra).toHaveProperty("settleToRenderMs");
		expect(settled.extra).not.toHaveProperty("gestureToRenderMs");
	});

	it("keeps one poll in flight and stops emitting once unmounted", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(api.request.checkDevServer).mockReturnValue(new Promise(() => {}) as never);
			const view = renderDevServer();
			await vi.advanceTimersByTimeAsync(30_000);
			// The interval keeps firing, but a hung request must not stack more.
			expect(vi.mocked(api.request.checkDevServer).mock.calls).toHaveLength(1);

			view.unmount();
			const before = vi.mocked(api.request.logRendererDiagnostic).mock.calls.length;
			await vi.advanceTimersByTimeAsync(60_000);
			// The armed stall timer belongs to a component that is gone.
			expect(vi.mocked(api.request.logRendererDiagnostic).mock.calls.length).toBe(before);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports how long a stalled request really took, not the threshold", async () => {
		vi.useFakeTimers();
		const realNow = performance.now.bind(performance);
		try {
			vi.mocked(api.request.checkDevServer).mockReturnValue(new Promise(() => {}) as never);
			renderDevServer();
			await vi.advanceTimersByTimeAsync(100);
			// Fake timers run a callback at its DUE time, so they cannot model a blocked
			// event loop. Move the clock the timer reads instead: the callback now runs
			// 49 s after it was armed, which is what a jammed loop looks like.
			const offset = 49_000;
			vi.spyOn(performance, "now").mockImplementation(() => realNow() + offset);
			await vi.advanceTimersByTimeAsync(8_100);

			const stalled = vi
				.mocked(api.request.logRendererDiagnostic)
				.mock.calls.map(([p]) => p)
				.find((p) => p.message === "checkDevServer stalled")!;
			expect(stalled).toBeDefined();
			// The lateness IS the finding — a hardcoded threshold would hide it.
			expect(Number(stalled.extra?.unsettledForMs)).toBeGreaterThanOrEqual(40_000);
			expect(stalled.extra?.thresholdMs).toBe(8_000);
		} finally {
			vi.mocked(performance.now).mockRestore?.();
			vi.useRealTimers();
		}
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
