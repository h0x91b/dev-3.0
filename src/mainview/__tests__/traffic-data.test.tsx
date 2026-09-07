import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessageLogPage, AgentMessageLogRow } from "../../shared/agent-message-log";
import type { Project, Task } from "../../shared/types";
import { resetTrafficStore } from "../agent-traffic";
import { useTrafficData } from "../components/agent-traffic/useTrafficData";
import { api } from "../rpc";
import { setSensitiveProjectIds } from "../sensitive-projects";
import { setStreamerMode } from "../streamer-mode";

vi.mock("../rpc", () => ({ api: { request: { getProjects: vi.fn(), getTasks: vi.fn(), readAgentMessageLog: vi.fn() } } }));
const projects = [{ id: "a", name: "A" }, { id: "b", name: "B" }] as Project[];
const task = (projectId: string): Task => ({ id: "same", projectId, seq: 1, title: projectId } as Task);
const page = { rows: [], oldestDay: null, retentionDays: 30, hasMore: false };

afterEach(() => {
	act(() => { setStreamerMode(false); setSensitiveProjectIds([]); });
	resetTrafficStore();
	vi.resetAllMocks();
});

describe("traffic snapshot loading", () => {
	it("publishes the first project without waiting for a slow unrelated project", async () => {
		vi.mocked(api.request.getProjects).mockResolvedValue(projects);
		vi.mocked(api.request.readAgentMessageLog).mockImplementation(({ projectId }) => projectId === "a" ? Promise.resolve(page) : new Promise(() => {}));
		vi.mocked(api.request.getTasks).mockImplementation(({ projectId }) => projectId === "a" ? Promise.resolve([task("a")]) : new Promise(() => {}));
		const { result } = renderHook(() => useTrafficData());
		await waitFor(() => expect(result.current.tasks).toHaveLength(1));
		expect(result.current.loading).toBe(false);
	});

	it("expands a busy first page to cover 24 hours, stopping at that boundary", async () => {
		vi.mocked(api.request.getProjects).mockResolvedValue([projects[0]]);
		vi.mocked(api.request.getTasks).mockResolvedValue([]);
		const recent = { at: new Date().toISOString(), toProjectId: "a", fromProjectId: "a" } as AgentMessageLogRow;
		const older = { ...recent, at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() };
		vi.mocked(api.request.readAgentMessageLog)
			.mockResolvedValueOnce({ ...page, rows: Array(500).fill(recent), hasMore: true })
			.mockResolvedValueOnce({ ...page, rows: [...Array(999).fill(recent), older], hasMore: true })
			.mockResolvedValueOnce({ ...page, rows: [...Array(1499).fill(recent), older] });
		const { result } = renderHook(() => useTrafficData());
		await waitFor(() => expect(result.current.rows).toHaveLength(1000));
		expect(api.request.readAgentMessageLog).toHaveBeenCalledTimes(2);
		expect(api.request.readAgentMessageLog).toHaveBeenLastCalledWith({ projectId: "a", limit: 1000 });
		expect(result.current.hasMore).toBe(true);
		act(() => result.current.loadMore());
		await waitFor(() => expect(result.current.rows).toHaveLength(1500));
		expect(api.request.readAgentMessageLog).toHaveBeenLastCalledWith({ projectId: "a", limit: 1500 });
	});

	it("loads through the selected day's start and stops exactly at its boundary", async () => {
		vi.mocked(api.request.getProjects).mockResolvedValue([projects[0]]);
		vi.mocked(api.request.getTasks).mockResolvedValue([]);
		const cutoff = new Date(2026, 8, 4).getTime();
		const rowAt = (at: number) => ({ at: new Date(at).toISOString(), toProjectId: "a", fromProjectId: "a" }) as AgentMessageLogRow;
		const recent = rowAt(cutoff + 3 * 24 * 60 * 60 * 1000);
		const yesterday = rowAt(cutoff + 24 * 60 * 60 * 1000);
		const boundary = rowAt(cutoff);
		vi.mocked(api.request.readAgentMessageLog)
			.mockResolvedValueOnce({ ...page, rows: [recent], hasMore: true })
			.mockResolvedValueOnce({ ...page, rows: [recent, yesterday], hasMore: true })
			.mockResolvedValueOnce({ ...page, rows: [recent, yesterday, boundary], hasMore: true });
		const { result, rerender } = renderHook(({ cutoff }: { cutoff: number | undefined }) => useTrafficData(cutoff), { initialProps: { cutoff } });
		await waitFor(() => expect(result.current.rows).toHaveLength(3));
		expect(api.request.readAgentMessageLog).toHaveBeenCalledTimes(3);
		expect(api.request.readAgentMessageLog).toHaveBeenLastCalledWith({ projectId: "a", limit: 2000 });
		rerender({ cutoff });
		expect(api.request.getProjects).toHaveBeenCalledTimes(1);
	});

	it("stops expanding when a server repeats a page without reaching the selected date", async () => {
		vi.mocked(api.request.getProjects).mockResolvedValue([projects[0]]);
		vi.mocked(api.request.getTasks).mockResolvedValue([]);
		const recent = { at: new Date().toISOString(), toProjectId: "a" } as AgentMessageLogRow;
		vi.mocked(api.request.readAgentMessageLog).mockResolvedValue({ ...page, rows: [recent], hasMore: true });
		const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
		const { result } = renderHook(() => useTrafficData(cutoff));
		await waitFor(() => expect(api.request.readAgentMessageLog).toHaveBeenCalledTimes(2));
		expect(result.current.rows).toEqual([recent]);
		expect(result.current.error).toBe(false);
	});

	it("cancels the old date's expansion when switching back to the last 24 hours", async () => {
		vi.mocked(api.request.getProjects).mockResolvedValue([projects[0]]);
		vi.mocked(api.request.getTasks).mockResolvedValue([]);
		const recent = { at: new Date().toISOString(), toProjectId: "a" } as AgentMessageLogRow;
		const yesterday = { ...recent, at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() };
		let resolveOld!: (value: AgentMessageLogPage) => void;
		vi.mocked(api.request.readAgentMessageLog)
			.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
			.mockResolvedValue({ ...page, rows: [recent, yesterday], hasMore: true });
		const { result, rerender } = renderHook(({ cutoff }: { cutoff: number | undefined }) => useTrafficData(cutoff), {
			initialProps: { cutoff: (Date.now() - 7 * 24 * 60 * 60 * 1000) as number | undefined },
		});
		await waitFor(() => expect(api.request.readAgentMessageLog).toHaveBeenCalledTimes(1));
		rerender({ cutoff: undefined });
		await waitFor(() => expect(result.current.rows).toHaveLength(2));
		await act(async () => resolveOld({ ...page, rows: [recent], hasMore: true }));
		expect(api.request.readAgentMessageLog).toHaveBeenCalledTimes(2);
		expect(result.current.rows).toEqual([recent, yesterday]);
	});

	it("does not continue historical loading after unmount or a project becomes private", async () => {
		setStreamerMode(true);
		vi.mocked(api.request.getProjects).mockResolvedValue([projects[0]]);
		vi.mocked(api.request.getTasks).mockResolvedValue([]);
		let resolvePage!: (value: AgentMessageLogPage) => void;
		vi.mocked(api.request.readAgentMessageLog).mockImplementation(() => new Promise(resolve => { resolvePage = resolve; }));
		const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
		const { result, unmount } = renderHook(() => useTrafficData(cutoff));
		await waitFor(() => expect(api.request.readAgentMessageLog).toHaveBeenCalledTimes(1));
		act(() => setSensitiveProjectIds(["a"]));
		const recent = { at: new Date().toISOString(), toProjectId: "a" } as AgentMessageLogRow;
		await act(async () => resolvePage({ ...page, rows: [recent], hasMore: true }));
		expect(result.current.rows).toEqual([]);
		expect(result.current.projects).toEqual([]);
		expect(api.request.readAgentMessageLog).toHaveBeenCalledTimes(1);
		act(() => setSensitiveProjectIds([]));
		await waitFor(() => expect(api.request.readAgentMessageLog).toHaveBeenCalledTimes(2));
		unmount();
		await act(async () => resolvePage({ ...page, rows: [recent], hasMore: true }));
		expect(api.request.readAgentMessageLog).toHaveBeenCalledTimes(2);
	});

	it("hides a newly sensitive cached project immediately even when refreshing fails", async () => {
		setStreamerMode(true);
		vi.mocked(api.request.getProjects).mockResolvedValue(projects);
		vi.mocked(api.request.getTasks).mockImplementation(({ projectId }) => Promise.resolve([task(projectId)]));
		vi.mocked(api.request.readAgentMessageLog).mockImplementation(({ projectId }) => Promise.resolve({
			...page,
			rows: [{ at: new Date().toISOString(), toProjectId: projectId, fromProjectId: projectId }] as AgentMessageLogRow[],
		}));
		const { result } = renderHook(() => useTrafficData());
		await waitFor(() => expect(result.current.tasks).toHaveLength(2));
		expect(result.current.projects.map(project => project.id)).toEqual(["a", "b"]);
		vi.mocked(api.request.getProjects).mockRejectedValue(new Error("offline"));
		act(() => setSensitiveProjectIds(["a"]));
		expect(result.current.projects.map(project => project.id)).toEqual(["b"]);
		expect(result.current.tasks.map(task => task.projectId)).toEqual(["b"]);
		expect(result.current.rows.map(row => row.toProjectId)).toEqual(["b"]);
		await waitFor(() => expect(result.current.error).toBe(true));
		expect(result.current.projects.map(project => project.id)).toEqual(["b"]);
		expect(result.current.tasks.map(task => task.projectId)).toEqual(["b"]);
	});

	it("keeps pushed updates and removals when an older task snapshot arrives", async () => {
		vi.mocked(api.request.getProjects).mockResolvedValue(projects);
		vi.mocked(api.request.readAgentMessageLog).mockResolvedValue(page);
		let resolveA!: (tasks: Task[]) => void;
		vi.mocked(api.request.getTasks).mockImplementation(({ projectId }) => projectId === "a" ? new Promise(resolve => { resolveA = resolve; }) : Promise.resolve([task("b")]));
		const { result } = renderHook(() => useTrafficData());
		await waitFor(() => expect(result.current.tasks).toHaveLength(1));
		act(() => {
			window.dispatchEvent(new CustomEvent("rpc:taskRemoved", { detail: { projectId: "a", taskId: "same" } }));
			window.dispatchEvent(new CustomEvent("rpc:taskUpdated", { detail: { projectId: "a", task: { ...task("a"), id: "new", title: "Pushed" } } }));
			resolveA([task("a")]);
		});
		await waitFor(() => expect(result.current.tasks.map(item => item.title).sort()).toEqual(["Pushed", "b"]));
	});
});
