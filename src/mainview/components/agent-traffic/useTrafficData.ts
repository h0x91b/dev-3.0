import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project, Task } from "../../../shared/types";
import { getTrafficState, loadTraffic, subscribeTraffic } from "../../agent-traffic";
import { api } from "../../rpc";
import { useProjectPrivacy } from "../../sensitive-projects";
import { endpointKey } from "./traffic-model";

export function useTrafficData() {
	const { isLocked } = useProjectPrivacy();
	const [projects, setProjects] = useState<Project[]>([]);
	const [tasks, setTasks] = useState<Task[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(false);
	const [revision, setRevision] = useState(0);
	const [limit, setLimit] = useState(500);
	const reload = useCallback(() => setRevision(value => value + 1), []);
	const [tick, setTick] = useState(0);
	useEffect(() => subscribeTraffic(() => setTick(value => value + 1)), []);
	useEffect(() => {
		let cancelled = false;
		const updated = new Map<string, Task | null>();
		function onUpdate(event: Event) {
			const { task } = (event as CustomEvent<{ task: Task }>).detail;
			const key = endpointKey(task.projectId, task.id);
			updated.set(key, task);
			setTasks(current => [...current.filter(item => endpointKey(item.projectId, item.id) !== key), task]);
		}
		function onRemove(event: Event) {
			const { projectId, taskId } = (event as CustomEvent<{ projectId: string; taskId: string }>).detail;
			const key = endpointKey(projectId, taskId);
			updated.set(key, null);
			setTasks(current => current.filter(task => endpointKey(task.projectId, task.id) !== key));
		}
		window.addEventListener("rpc:taskUpdated", onUpdate);
		window.addEventListener("rpc:taskRemoved", onRemove);
		window.addEventListener("rpc:projectUpdated", reload);
		setLoading(true);
		setError(false);
		async function loadRecentTraffic(projectId: string) {
			const cutoff = Date.now() - 24 * 60 * 60 * 1000;
			let pageLimit = limit;
			let previousCount = -1;
			while (!cancelled) {
				await loadTraffic(projectId, pageLimit);
				if (cancelled) return;
				setLoading(false);
				const page = getTrafficState(projectId);
				const oldest = page.rows.reduce((minimum, row) => {
					const at = Date.parse(row.at);
					return Number.isFinite(at) ? Math.min(minimum, at) : minimum;
				}, Infinity);
				if (page.error || !page.hasMore || oldest <= cutoff || page.rows.length <= previousCount) return;
				previousCount = page.rows.length;
				pageLimit = Math.max(pageLimit * 2, page.rows.length + 500);
			}
		}
		void (async () => {
			try {
				const allProjects = await api.request.getProjects();
				const visible = allProjects.filter(project => !isLocked(project.id) && !isLocked(project));
				if (cancelled) return;
				setProjects(visible);
				await Promise.allSettled(visible.flatMap(project => [
					loadRecentTraffic(project.id),
					api.request.getTasks({ projectId: project.id }).then(loaded => {
						if (cancelled) return;
						const snapshot = loaded.filter(task => !updated.has(endpointKey(task.projectId, task.id)));
						const pushed = [...updated.values()].filter((task): task is Task => task !== null && task.projectId === project.id);
						setTasks(current => [...current.filter(task => task.projectId !== project.id), ...snapshot, ...pushed]);
						setLoading(false);
					}).catch(() => { if (!cancelled) setError(true); }),
				]));
			} catch { if (!cancelled) setError(true); }
			finally { if (!cancelled) setLoading(false); }
		})();
		return () => {
			cancelled = true;
			window.removeEventListener("rpc:taskUpdated", onUpdate);
			window.removeEventListener("rpc:taskRemoved", onRemove);
			window.removeEventListener("rpc:projectUpdated", reload);
		};
	}, [revision, limit, isLocked, reload]);
	const visibleProjects = useMemo(() => projects.filter(project => !isLocked(project.id) && !isLocked(project)), [projects, isLocked]);
	const pages = useMemo(() => visibleProjects.map(project => getTrafficState(project.id)), [visibleProjects, tick]);
	const rows = useMemo(() => pages.flatMap(page => page.rows).filter(row => !isLocked(row.fromProjectId) && !isLocked(row.toProjectId)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)), [pages, isLocked]);
	const projectIds = new Set(visibleProjects.map(project => project.id));
	return { projects: visibleProjects, tasks: tasks.filter(task => projectIds.has(task.projectId)), rows, loading,
		error: error || pages.some(page => page.error), hasMore: pages.some(page => page.hasMore), limit,
		oldestDay: pages.map(page => page.oldestDay).filter((day): day is string => !!day).sort()[0],
		retentionDays: pages[0]?.retentionDays ?? 30,
		reload, loadMore: () => setLimit(value => pages.reduce((maximum, page) => Math.max(maximum, page.rows.length), value) + 500) };
}
