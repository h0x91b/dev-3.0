import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	filterLibraryItems,
	isLibraryItemDeletable,
	libraryDeleteGroups,
	libraryDayBucket,
	libraryDiskGroups,
	libraryViewerSiblings,
	replaceTaskLibraryItems,
	sortLibraryItems,
	summarizeLibrary,
	taskLibraryItems,
	type LibraryDayBucket,
	type LibraryItem,
	type LibraryKind,
	type LibrarySort,
} from "../../../shared/library";
import type { Task } from "../../../shared/types";
import { useAgents } from "../../hooks/useAgents";
import { useNarrowViewport } from "../../hooks/useNarrowViewport";
import { statusKey, useT, type TranslationKey } from "../../i18n";
import { api, isElectrobun } from "../../rpc";
import { confirmDeleteSharedMediaGroups } from "../../shared-media-delete";
import { toast } from "../../toast";
import ControlMenu, { type ControlMenuEntry } from "../ControlMenu";
import { useProjectPrivacy } from "../../sensitive-projects";
import { formatBytes } from "../../utils/formatBytes";
import { CAROUSEL_MAX_WIDTH } from "../MobileBoardCarousel";
import Select from "../Select";
import { ArtifactsIcon, ImagesIcon } from "../TaskIcons";
import LibraryKindSwitch from "./LibraryKindSwitch";

const ALL_PROJECTS = "__all__";
/** Rows rendered before "Show more": the whole list is one RPC, the DOM need not be. */
const PAGE_SIZE = 150;
const DISK_GROUPS_SHOWN = 5;

const DAY_LABEL: Record<LibraryDayBucket, TranslationKey> = {
	today: "library.day.today",
	yesterday: "library.day.yesterday",
	week: "library.day.week",
	month: "library.day.month",
	older: "library.day.older",
};

const SORTS: { value: LibrarySort; label: TranslationKey }[] = [
	{ value: "newest", label: "library.sort.newest" },
	{ value: "oldest", label: "library.sort.oldest" },
	{ value: "largest", label: "library.sort.largest" },
];

export interface LibraryScreenProps {
	/** The project the user came from; the initial scope. Null starts on all projects. */
	projectId: string | null;
	onOpenTask: (taskId: string, projectId: string, opts?: { archived?: boolean }) => void;
}

type LoadState = { phase: "loading" } | { phase: "error" } | { phase: "ready"; items: LibraryItem[] };

interface LibraryHandle {
	state: LoadState;
	reload: () => void;
	markSeen: (keys: string[]) => void;
	/** Rebuild one task's items from a task record (a push, or a mutation's own reply). */
	patchTask: (projectId: string, task: Task) => void;
}

function useLibrary(): LibraryHandle {
	const [state, setState] = useState<LoadState>({ phase: "loading" });
	const alive = useRef(true);
	const reload = useCallback(() => {
		api.request
			.getLibrary()
			.then((report) => { if (alive.current) setState({ phase: "ready", items: report.items }); })
			.catch(() => { if (alive.current) setState((prev) => (prev.phase === "ready" ? prev : { phase: "error" })); });
	}, []);
	// A push carries the whole task, so only that task's items are rebuilt here: the full
	// archive is megabytes, and `taskUpdated` fires for every status and activity change.
	const patchTask = useCallback((projectId: string, task: Task) => {
		let unknownProject = false;
		setState((prev) => {
			if (prev.phase !== "ready") return prev;
			const projectName = prev.items.find((item) => item.projectId === projectId)?.projectName;
			let fresh: LibraryItem[] = [];
			try {
				fresh = projectName == null ? [] : taskLibraryItems({ id: projectId, name: projectName }, task);
			} catch {
				return prev;
			}
			if (projectName == null) {
				// Its first output in a project this list has never seen: the name comes from the host.
				unknownProject = taskLibraryItems({ id: projectId, name: "" }, task).length > 0;
				return prev;
			}
			const hadAny = prev.items.some((item) => item.taskId === task.id && item.projectId === projectId);
			if (!hadAny && fresh.length === 0) return prev;
			return { phase: "ready", items: replaceTaskLibraryItems(prev.items, projectId, task.id, fresh) };
		});
		if (unknownProject) reload();
	}, [reload]);
	const patchTaskRef = useRef(patchTask);
	patchTaskRef.current = patchTask;
	useEffect(() => {
		alive.current = true;
		reload();
		const onTaskUpdated = (e: Event) => {
			const { projectId, task } = (e as CustomEvent<{ projectId: string; task: Task }>).detail ?? {};
			if (projectId && task) patchTaskRef.current(projectId, task);
		};
		const onTaskRemoved = (e: Event) => {
			const { projectId, taskId } = (e as CustomEvent<{ projectId: string; taskId: string }>).detail ?? {};
			if (!projectId || !taskId) return;
			setState((prev) => (prev.phase === "ready" ? { phase: "ready", items: replaceTaskLibraryItems(prev.items, projectId, taskId, []) } : prev));
		};
		window.addEventListener("rpc:taskUpdated", onTaskUpdated);
		window.addEventListener("rpc:taskRemoved", onTaskRemoved);
		return () => {
			alive.current = false;
			window.removeEventListener("rpc:taskUpdated", onTaskUpdated);
			window.removeEventListener("rpc:taskRemoved", onTaskRemoved);
		};
	}, [reload]);
	const markSeen = useCallback((keys: string[]) => {
		const seen = new Set(keys);
		setState((prev) =>
			prev.phase === "ready" ? { phase: "ready", items: prev.items.map((item) => (seen.has(item.key) && item.unread ? { ...item, unread: false } : item)) } : prev,
		);
	}, []);
	return { state, reload, markSeen, patchTask };
}

function formatStamp(ms: number, withDate: boolean): string {
	try {
		return new Date(ms).toLocaleString(undefined, withDate
			? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
			: { hour: "2-digit", minute: "2-digit" });
	} catch {
		return "";
	}
}

const CLIP_GLYPH = "'JetBrainsMono Nerd Font Mono'";

function KindGlyph({ kind }: { kind: LibraryKind }) {
	const box = "flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent";
	if (kind === "report") return <span className={box}><ArtifactsIcon className="h-[1.125rem] w-[1.125rem]" /></span>;
	if (kind === "image") return <span className={box}><ImagesIcon className="h-[1.125rem] w-[1.125rem]" /></span>;
	return <span className={`${box} text-base`} style={{ fontFamily: CLIP_GLYPH }} aria-hidden="true">{kind === "video" ? "" : ""}</span>;
}

/** Opens an item in the App-hosted viewer it already has, with its task's other outputs as history. */
function openInViewer(all: readonly LibraryItem[], item: LibraryItem) {
	if (item.kind === "report") {
		const siblings = libraryViewerSiblings(all, item);
		const artifacts = siblings.map((s) => s.artifact!).filter(Boolean);
		window.dispatchEvent(new CustomEvent("dev3:openArtifactViewer", {
			detail: {
				taskId: item.taskId,
				taskStatus: item.taskStatus,
				projectId: item.projectId,
				artifacts,
				// The live page rides after the shared list, the same order the viewer lists it in.
				index: item.live ? artifacts.length : Math.max(0, siblings.findIndex((s) => s.key === item.key)),
				paneless: true,
				live: all.find((s) => s.taskId === item.taskId && s.live)?.liveArtifact,
			},
		}));
		return;
	}
	const siblings = libraryViewerSiblings(all, item);
	window.dispatchEvent(new CustomEvent("dev3:openImageViewer", {
		detail: {
			taskId: item.taskId,
			projectId: item.projectId,
			images: siblings.map((s) => s.image!).filter(Boolean),
			index: Math.max(0, siblings.findIndex((s) => s.key === item.key)),
		},
	}));
}

/**
 * Every artifact and shown media record across projects and task statuses, in one list:
 * find "that report" without remembering the task, see what arrived today, and see what
 * takes the disk. Read-only — opening an item reuses the task viewers, and the task
 * link opens even a finished task.
 */
export default function LibraryScreen({ projectId, onOpenTask }: LibraryScreenProps) {
	const t = useT();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const agents = useAgents();
	const privacy = useProjectPrivacy();
	const { state, reload, markSeen, patchTask } = useLibrary();
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
	const [menu, setMenu] = useState<{ item: LibraryItem; pos: { top: number; left: number }; opener: HTMLElement } | null>(null);
	const [scope, setScope] = useState<string>(projectId ?? ALL_PROJECTS);
	const [taskScope, setTaskScope] = useState<{ id: string; title: string } | null>(null);
	const [kind, setKind] = useState<LibraryKind | "all">("all");
	const [sort, setSort] = useState<LibrarySort>("newest");
	const [query, setQuery] = useState("");
	const [unseenOnly, setUnseenOnly] = useState(false);
	const [limit, setLimit] = useState(PAGE_SIZE);

	const items = useMemo(() => (state.phase === "ready" ? state.items : []), [state]);
	const agentName = useCallback((id: string | null) => (id ? agents.find((a) => a.id === id)?.name ?? id : null), [agents]);
	const projectScope = scope === ALL_PROJECTS ? null : scope;

	const scoped = useMemo(
		() => items.filter((item) => (!projectScope || item.projectId === projectScope) && (!taskScope || item.taskId === taskScope.id)),
		[items, projectScope, taskScope],
	);
	const rows = useMemo(
		() => sortLibraryItems(filterLibraryItems(scoped, { query, kind, projectId: null, unseenOnly, isLocked: privacy.isLocked, agentName }), sort),
		[scoped, query, kind, unseenOnly, privacy.isLocked, agentName, sort],
	);
	const summary = summarizeLibrary(scoped);
	const projectCount = new Set(scoped.map((item) => item.projectId)).size;
	const diskBy = projectScope ? "task" : "project";
	const diskGroups = useMemo(() => libraryDiskGroups(scoped, diskBy).slice(0, DISK_GROUPS_SHOWN), [scoped, diskBy]);
	const diskMax = diskGroups[0]?.bytes ?? 0;

	const projectOptions = useMemo(() => {
		const names = new Map<string, string>();
		for (const item of items) if (!names.has(item.projectId)) names.set(item.projectId, item.projectName);
		if (projectId && !names.has(projectId)) names.set(projectId, projectId);
		const options = [...names]
			.map(([id, name]) => ({ value: id, label: privacy.isLocked(id) ? t("streamer.privateTitle") : name }))
			.sort((a, b) => a.label.localeCompare(b.label));
		return [{ value: ALL_PROJECTS, label: t("library.scopeAll") }, ...options];
	}, [items, projectId, privacy, t]);

	const filtered = query.trim() !== "" || kind !== "all" || unseenOnly || taskScope != null;
	const clearFilters = () => {
		setQuery("");
		setKind("all");
		setUnseenOnly(false);
		setTaskScope(null);
		setScope(ALL_PROJECTS);
	};
	const pickScope = (next: string) => {
		setScope(next);
		setTaskScope(null);
		setLimit(PAGE_SIZE);
	};

	const open = (item: LibraryItem) => {
		openInViewer(items, item);
		// The viewer marks the records read on the host; reflect it now, the refetch confirms it.
		if (item.kind === "report") markSeen(libraryViewerSiblings(items, item).map((s) => s.key));
		else markSeen([item.key]);
	};

	// A selection only ever holds clips that can still be deleted: a push that tombstones one drops it.
	const selectedItems = useMemo(() => items.filter((item) => selected.has(item.key) && isLibraryItemDeletable(item)), [items, selected]);
	const selectedBytes = selectedItems.reduce((sum, item) => sum + item.bytes, 0);
	const deletableShown = useMemo(() => rows.filter(isLibraryItemDeletable), [rows]);
	const selecting = selectedItems.length > 0;
	const toggleSelected = (key: string) => setSelected((prev) => {
		const next = new Set(prev);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		return next;
	});
	const deleting = useRef(false);
	const deleteItems = async (targets: LibraryItem[], scope: "one" | "many") => {
		if (deleting.current) return;
		deleting.current = true;
		try {
			const updated = await confirmDeleteSharedMediaGroups({ groups: libraryDeleteGroups(targets), t, scope });
			for (const { projectId: pid, task } of updated) patchTask(pid, task);
			if (updated.length > 0) setSelected((prev) => {
				const next = new Set(prev);
				for (const item of targets) next.delete(item.key);
				return next;
			});
		} finally {
			deleting.current = false;
		}
	};
	const copyPath = async (item: LibraryItem) => {
		const path = item.image?.storedPath ?? item.artifact?.storedPath;
		if (!path) return;
		try {
			await navigator.clipboard.writeText(path);
			toast.success(t("library.copied"));
		} catch {
			toast.error(t("imageViewer.copyFailed"));
		}
	};
	const menuEntries = (item: LibraryItem): ControlMenuEntry[] => {
		const path = item.image?.storedPath ?? item.artifact?.storedPath;
		const present = !item.missing && !item.removedAt && !item.live && path != null;
		const entries: ControlMenuEntry[] = [];
		if (present) entries.push({ key: "copy", label: t("library.copyPath"), onSelect: () => void copyPath(item) });
		if (present && isElectrobun) {
			entries.push({
				key: "reveal",
				label: t(navigator.userAgent.includes("Mac") ? "library.revealMac" : "library.revealOther"),
				onSelect: () => { api.request.openTerminalPath({ path: path!, mode: "reveal" }).catch(() => toast.error(t("library.missing"))); },
			});
		}
		if (isLibraryItemDeletable(item)) entries.push({ key: "delete", label: t("library.deleteFile"), danger: true, separated: entries.length > 0, onSelect: () => void deleteItems([item], "one") });
		return entries;
	};

	const grouped = sort !== "largest";
	const now = Date.now();
	const shown = rows.slice(0, limit);

	return (
		<div className="h-full overflow-y-auto" data-testid="library-screen">
			<div className={`mx-auto max-w-6xl space-y-5 ${narrow ? "p-4" : "p-7"}`}>
				<header className="space-y-1">
					<h1 className="text-fg text-2xl font-bold leading-tight">{t("library.title")}</h1>
					<p className="text-fg-3 text-sm text-pretty">{t("library.subtitle")}</p>
				</header>

				{state.phase === "loading" && <p className="px-1 text-fg-muted text-sm" role="status">{t("library.loading")}</p>}

				{state.phase === "error" && (
					<div className="rounded-2xl border border-edge border-dashed bg-raised px-4 py-8 text-center" role="alert">
						<p className="text-fg-2 text-sm font-semibold">{t("library.error")}</p>
						<button type="button" onClick={reload} className="mt-1 rounded text-accent text-xs hover:text-accent-emphasis hover:underline">
							{t("library.retry")}
						</button>
					</div>
				)}

				{state.phase === "ready" && items.length === 0 && (
					<div className="rounded-2xl border border-edge border-dashed bg-raised px-4 py-8 text-center" data-testid="library-empty">
						<p className="text-fg-2 text-sm font-semibold">{t("library.empty")}</p>
						<p className="mt-1 text-fg-muted text-xs">{t("library.emptyHint")}</p>
					</div>
				)}

				{state.phase === "ready" && items.length > 0 && (
					<>
						<div className="grid grid-cols-3 gap-2 sm:gap-3">
							<div className="min-w-0 rounded-2xl border border-edge bg-raised px-3 py-2.5 sm:px-4 sm:py-3">
								<div className="text-xs text-fg-3">{t("library.kpi.items")}</div>
								<div className="mt-1 text-2xl font-semibold leading-tight tabular-nums text-fg">{summary.count}</div>
								<div className="mt-0.5 hidden truncate text-xs text-fg-muted sm:block">{t.plural("library.kpi.projects", projectCount)}</div>
							</div>
							<div className="min-w-0 rounded-2xl border border-edge bg-raised px-3 py-2.5 sm:px-4 sm:py-3">
								<div className="text-xs text-fg-3">{t("library.kpi.size")}</div>
								<div className="mt-1 text-2xl font-semibold leading-tight tabular-nums text-fg" data-testid="library-total-bytes">{formatBytes(summary.bytes)}</div>
								{/* What is already gone is not counted above, and the reader must learn that on a phone too. */}
								{summary.missing > 0 ? (
									<div className="mt-0.5 text-xs text-fg-muted text-pretty sm:truncate" data-testid="library-missing-note">
										{t.plural("library.kpi.missing", summary.missing, { size: formatBytes(summary.goneBytes) })}
									</div>
								) : (
									<div className="mt-0.5 hidden truncate text-xs text-fg-muted sm:block">{t("library.kpi.sizeHint")}</div>
								)}
							</div>
							<button
								type="button"
								aria-pressed={unseenOnly}
								disabled={summary.unseen === 0 && !unseenOnly}
								onClick={() => setUnseenOnly((v) => !v)}
								data-testid="library-unseen-toggle"
								className={`min-w-0 rounded-2xl border px-3 py-2.5 text-left sm:px-4 sm:py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default ${unseenOnly ? "border-accent/50 bg-accent/10" : "border-edge bg-raised enabled:hover:bg-raised-hover enabled:hover:border-edge-active"}`}
							>
								<div className="text-xs text-fg-3">{t("library.kpi.unseen")}</div>
								<div className={`mt-1 text-2xl font-semibold leading-tight tabular-nums ${summary.unseen > 0 ? "text-accent" : "text-fg"}`}>{summary.unseen}</div>
								<div className="mt-0.5 hidden truncate text-xs text-fg-muted sm:block">{t(unseenOnly ? "library.kpi.unseenOn" : "library.kpi.unseenHint")}</div>
							</button>
						</div>

						{diskGroups.length > 1 && (
							<section aria-labelledby="library-disk-heading" className="rounded-2xl border border-edge bg-raised px-4 py-3">
								<h2 id="library-disk-heading" className="text-xs text-fg-3">{t(diskBy === "project" ? "library.disk.byProject" : "library.disk.byTask")}</h2>
								<ul className="mt-2 space-y-1.5">
									{diskGroups.map((group) => {
										const locked = privacy.isLocked(diskBy === "project" ? group.id : projectScope);
										const label = locked ? t("streamer.privateTitle") : group.label;
										const active = taskScope?.id === group.id;
										return (
											<li key={group.id}>
												<button
													type="button"
													onClick={() => (diskBy === "project" ? pickScope(group.id) : setTaskScope(active ? null : { id: group.id, title: group.label }))}
													aria-label={t("library.disk.narrow", { name: label })}
													aria-pressed={diskBy === "task" ? active : undefined}
													className="group flex w-full items-center gap-3 rounded-lg px-1 py-0.5 text-left hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
												>
													<span className={`w-40 flex-shrink-0 truncate text-xs ${active ? "text-accent" : "text-fg-2 group-hover:text-fg"} ${privacy.maskClass(diskBy === "project" ? group.id : projectScope)}`}>{label}</span>
													<span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-base">
														<span className="block h-full rounded-full bg-accent/60" style={{ width: `${diskMax > 0 ? Math.max(2, (group.bytes / diskMax) * 100) : 0}%` }} />
													</span>
													<span className="w-16 flex-shrink-0 text-right text-xs tabular-nums text-fg-muted">{formatBytes(group.bytes)}</span>
												</button>
											</li>
										);
									})}
								</ul>
							</section>
						)}

						<div className="flex flex-wrap items-center gap-2">
							<input
								type="search"
								value={query}
								onChange={(event) => { setQuery(event.target.value); setLimit(PAGE_SIZE); }}
								placeholder={t("library.search")}
								aria-label={t("library.search")}
								data-testid="library-search"
								className={`${narrow ? "w-full" : "min-w-[12rem] flex-1"} rounded-xl border border-edge bg-elevated px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-muted focus:border-accent/50 transition-colors`}
							/>
							<LibraryKindSwitch value={kind} onChange={(next) => { setKind(next); setLimit(PAGE_SIZE); }} />
							{projectOptions.length > 2 && (
								<div className={narrow ? "min-w-[40%] flex-1" : "w-48"}>
									<Select value={scope} onChange={pickScope} options={projectOptions} ariaLabel={t("library.scopeLabel")} />
								</div>
							)}
							<div className={narrow ? "min-w-[40%] flex-1" : "w-40"}>
								<Select
									value={sort}
									onChange={(next) => setSort(next as LibrarySort)}
									options={SORTS.map((s) => ({ value: s.value, label: t(s.label) }))}
									ariaLabel={t("library.sortLabel")}
								/>
							</div>
						</div>

						{taskScope && (
							<div className="flex items-center gap-2 text-xs text-fg-3">
								<span className={`truncate ${privacy.maskClass(projectScope)}`}>
									{t("library.taskScope", { title: privacy.isLocked(projectScope) ? t("streamer.privateTitle") : taskScope.title })}
								</span>
								<button type="button" onClick={() => setTaskScope(null)} className="rounded text-accent hover:text-accent-emphasis hover:underline">
									{t("library.clearTask")}
								</button>
							</div>
						)}

						{selecting && (
							<div
								role="toolbar"
								aria-label={t.plural("library.selected", selectedItems.length)}
								data-testid="library-selection-bar"
								className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-accent/40 bg-raised px-3 py-2 shadow-lg shadow-black/20"
							>
								<span className="text-sm font-medium text-fg" aria-live="polite">{t.plural("library.selected", selectedItems.length)}</span>
								<span className="text-xs tabular-nums text-fg-muted">{formatBytes(selectedBytes)}</span>
								{deletableShown.some((item) => !selected.has(item.key)) && (
									<button type="button" onClick={() => setSelected(new Set([...selected, ...deletableShown.map((item) => item.key)]))} className="rounded text-xs text-accent hover:text-accent-emphasis hover:underline">
										{t.plural("library.selectAll", deletableShown.length)}
									</button>
								)}
								<span className="flex-1" />
								<button type="button" onClick={() => setSelected(new Set())} className="rounded-lg px-2.5 py-1.5 text-xs text-fg-2 hover:bg-raised-hover hover:text-fg">
									{t("library.clearSelection")}
								</button>
								<button
									type="button"
									data-testid="library-delete-selected"
									onClick={() => void deleteItems(selectedItems, "many")}
									className="rounded-lg bg-danger/15 px-3 py-1.5 text-xs font-semibold text-danger hover:bg-danger/25 active:scale-[0.96] transition-[background-color,transform]"
								>
									{t("library.deleteSelected")}
								</button>
							</div>
						)}

						{rows.length === 0 ? (
							<div className="rounded-2xl border border-edge border-dashed bg-raised px-4 py-8 text-center">
								<p className="text-fg-2 text-sm font-semibold">{t("library.noMatch")}</p>
								{(filtered || projectScope) && (
									<button type="button" onClick={clearFilters} className="mt-1 rounded text-accent text-xs hover:text-accent-emphasis hover:underline">
										{t("library.clearFilters")}
									</button>
								)}
							</div>
						) : (
							<ul className="space-y-1.5" data-testid="library-list">
								{shown.map((item, i) => {
									const bucket = libraryDayBucket(item.createdAt, now);
									const header = grouped && (i === 0 || libraryDayBucket(shown[i - 1].createdAt, now) !== bucket);
									return (
										<Fragment key={item.key}>
											{header && (
												<li className="px-1 pt-3 text-micro font-semibold uppercase tracking-wider text-fg-3" aria-hidden="true">
													{t(DAY_LABEL[bucket])}
												</li>
											)}
											<LibraryRow
												item={item}
												showProject={!projectScope}
												agentName={agentName(item.agentId)}
												stamp={formatStamp(item.createdAt, !grouped || (bucket !== "today" && bucket !== "yesterday"))}
												maskClass={privacy.maskClass(item.projectId)}
												locked={privacy.isLocked(item.projectId)}
												onOpen={() => open(item)}
												selectable={deletableShown.length > 0}
												deletable={isLibraryItemDeletable(item)}
												selected={selected.has(item.key)}
												alwaysShowCheckbox={narrow || selecting}
												onToggleSelected={() => toggleSelected(item.key)}
												hasMenu={menuEntries(item).length > 0}
												onMenu={(opener) => {
													const rect = opener.getBoundingClientRect();
													setMenu({ item, opener, pos: { top: rect.bottom + 4, left: rect.right - 176 } });
												}}
												onOpenTask={() => onOpenTask(item.taskId, item.projectId, { archived: item.taskStatus === "completed" || item.taskStatus === "cancelled" })}
											/>
										</Fragment>
									);
								})}
							</ul>
						)}

						{rows.length > shown.length && (
							<button
								type="button"
								onClick={() => setLimit((n) => n + PAGE_SIZE)}
								className="w-full rounded-xl border border-edge bg-raised px-3 py-2 text-sm text-fg-2 hover:bg-raised-hover hover:text-fg transition-colors"
							>
								{t.plural("library.showMore", rows.length - shown.length)}
							</button>
						)}
					</>
				)}
			</div>
			{menu && (
				<ControlMenu
					pos={menu.pos}
					label={t("library.rowMenu", { title: privacy.isLocked(menu.item.projectId) ? t("streamer.privateTitle") : menu.item.title })}
					entries={menuEntries(menu.item)}
					onClose={() => { menu.opener.focus(); setMenu(null); }}
				/>
			)}
		</div>
	);
}

interface LibraryRowProps {
	item: LibraryItem;
	showProject: boolean;
	agentName: string | null;
	stamp: string;
	maskClass: string;
	locked: boolean;
	onOpen: () => void;
	onOpenTask: () => void;
	/** Some visible row can be selected, so every row keeps the checkbox column aligned. */
	selectable: boolean;
	deletable: boolean;
	selected: boolean;
	alwaysShowCheckbox: boolean;
	onToggleSelected: () => void;
	hasMenu: boolean;
	onMenu: (opener: HTMLElement) => void;
}

function LibraryRow({ item, showProject, agentName, stamp, maskClass, locked, onOpen, onOpenTask, selectable, deletable, selected, alwaysShowCheckbox, onToggleSelected, hasMenu, onMenu }: LibraryRowProps) {
	const t = useT();
	const finished = item.taskStatus === "completed" || item.taskStatus === "cancelled";
	const meta: string[] = [];
	if (item.versions > 1) meta.push(t("library.version", { version: item.versions }));
	if (!item.missing && !item.removedAt) meta.push(formatBytes(item.bytes));
	const title = locked ? t("streamer.privateTitle") : item.title;
	return (
		<li className={`group flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2.5 transition-colors ${selected ? "border-accent/50 bg-accent/10" : "border-edge bg-elevated hover:border-edge-active hover:bg-elevated-hover"}`} data-testid="library-row">
			{selectable && (
				<span className="flex w-4 flex-shrink-0 items-center justify-center">
					{deletable && (
						<input
							type="checkbox"
							checked={selected}
							onChange={onToggleSelected}
							aria-label={t("library.select", { title })}
							title={t("library.selectHint")}
							data-testid="library-row-select"
							className={`h-4 w-4 cursor-pointer accent-accent transition-opacity ${alwaysShowCheckbox || selected ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
						/>
					)}
				</span>
			)}
			<button
				type="button"
				onClick={onOpen}
				aria-label={t("library.openItem", { title })}
				className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
			>
				<KindGlyph kind={item.kind} />
				<span className="min-w-0 flex-1">
					<span className="flex min-w-0 items-center gap-2">
						{item.unread && <span className="h-2 w-2 flex-shrink-0 rounded-full bg-accent" title={t("library.unseen")} aria-label={t("library.unseen")} />}
						{item.live && <span className="flex-shrink-0 rounded-full bg-success/15 px-1.5 text-micro font-semibold uppercase text-success">{t("artifactViewer.liveBadge")}</span>}
						<span className={`truncate text-sm font-medium text-fg-2 group-hover:text-fg ${maskClass}`}>{title}</span>
					</span>
					<span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-micro text-fg-muted">
						{meta.length > 0 && <span className="flex-shrink-0 tabular-nums">{meta.join(" · ")}</span>}
						{item.missing && <span className="flex-shrink-0 text-warning-strong">· {t("library.missing")}</span>}
						{item.removedAt && <span className="flex-shrink-0">{meta.length > 0 ? "· " : ""}{t("sharedMedia.removed")}</span>}
					</span>
				</span>
			</button>
			<button
				type="button"
				onClick={onOpenTask}
				title={t("library.openTask")}
				className="order-last flex w-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-micro text-fg-muted hover:bg-elevated-hover hover:text-accent-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:order-none sm:w-auto sm:max-w-[45%] sm:flex-shrink"
			>
				{showProject && <span className={`flex-shrink-0 truncate max-w-[8rem] ${maskClass}`}>{item.projectName}</span>}
				{showProject && <span aria-hidden="true">·</span>}
				<span className="flex-shrink-0 tabular-nums">#{item.taskSeq}</span>
				<span className={`min-w-0 truncate ${maskClass}`}>{locked ? t("streamer.privateTitle") : item.taskTitle}</span>
				{finished && <span className="flex-shrink-0 rounded bg-base px-1">{t(statusKey(item.taskStatus))}</span>}
				{agentName && <span className="flex-shrink-0">· {agentName}</span>}
			</button>
			<span className="w-24 flex-shrink-0 text-right text-micro tabular-nums text-fg-muted">{stamp}</span>
			{hasMenu ? (
				<button
					type="button"
					onClick={(event) => onMenu(event.currentTarget)}
					aria-label={t("library.rowMenu", { title })}
					aria-haspopup="menu"
					data-testid="library-row-menu"
					className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-elevated-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
				>
					<span aria-hidden="true" className="text-base leading-none">⋯</span>
				</button>
			) : (
				<span className="w-7 flex-shrink-0" aria-hidden="true" />
			)}
		</li>
	);
}
