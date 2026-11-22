import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { EXPLORER_MAX_ENTRIES, type ExplorerEntry, type ExplorerListing, type ProjectFolder } from "../../shared/types";
import { api, isElectrobun } from "../rpc";
import { useT } from "../i18n";
import { toast } from "../toast";
import { openFilePreview } from "../terminal-path-open";
import { writeClipboardText } from "../utils/clipboard-write";
import Tooltip from "./Tooltip";
import { groupMenuRows, runMenuItem } from "../plugins/menu-rows";
import { SlotErrorBoundary } from "../plugins/SlotHost";
import { FILE_MENU_GROUPS, getFileMenuRegistry, type FileMenuScope } from "../file-menu/registry";
import { fileManagerKeys, PathGlyph, RevealGlyph } from "../file-menu/builtins";
import {
	clearRevealRequest,
	folderSourceLabel,
	reloadProjectFolders,
	setFolderHidden,
	showAllFolders,
	useHiddenFolders,
	useProjectFolders,
	useProjectFoldersLoaded,
	useRevealRequest,
} from "../project-folders";

const POLL_INTERVAL_MS = 10_000;

type DirState =
	| { status: "loading"; entries?: ExplorerEntry[] }
	| { status: "ready"; entries: ExplorerEntry[]; truncated?: boolean }
	| { status: "error"; message: string };

interface MenuItem {
	id: string;
	label: string;
	icon: ReactNode;
	run: () => void;
}

/** One top-level folder of the tree: the worktree or checkout (`id` ""), or an extra folder keyed by its path. */
interface ExplorerRootDef {
	id: string;
	/** Absolute path of an extra folder; null for the worktree or checkout. */
	folder: string | null;
	label: string;
	hint: string;
	missing?: boolean;
}

type VisibleRow =
	| { kind: "root"; key: string; root: ExplorerRootDef; open: boolean }
	| {
		kind: "entry";
		key: string;
		rootId: string;
		entry: ExplorerEntry;
		depth: number;
		/** Git reports only the outermost ignored folder, so its whole subtree inherits the flag. */
		ignored: boolean;
	};

/**
 * Tree keys pair a root with a root-relative path, so two roots never collide on `src`.
 * U+001F, not NUL: `CSS.escape` turns NUL into U+FFFD, so a `[data-key]` selector would never match.
 */
const KEY_SEP = "\u001f";
const keyOf = (rootId: string, relPath: string) => `${rootId}${KEY_SEP}${relPath}`;
function splitKey(key: string): [rootId: string, relPath: string] {
	const i = key.indexOf(KEY_SEP);
	return [key.slice(0, i), key.slice(i + 1)];
}

/** An expanded folder is only on screen while every folder above it is expanded too. */
function isReachable(key: string, expanded: Set<string>): boolean {
	const [rootId, relPath] = splitKey(key);
	for (let i = relPath.indexOf("/"); i !== -1; i = relPath.indexOf("/", i + 1)) {
		if (!expanded.has(keyOf(rootId, relPath.slice(0, i)))) return false;
	}
	return true;
}

function baseName(path: string): string {
	return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/** Parent directory of a display path, for the muted hint beside a folder name. */
function parentOf(displayPath: string): string {
	const i = Math.max(displayPath.lastIndexOf("/"), displayPath.lastIndexOf("\\"));
	return i > 0 ? displayPath.slice(0, i) : displayPath;
}

export interface FileExplorerProps {
	projectId: string;
	/** Task scope lists the task worktree; without it the project checkout is listed. */
	taskId?: string | null;
	/** Shown in the header: the task branch or the project name. */
	rootLabel: string;
	pinned: boolean;
	onTogglePin: () => void;
	onHide: () => void;
	/** A file was opened or its path sent to the terminal; an auto-hidden panel slides away. */
	onHandOff?: () => void;
	/** The legacy yazi pane, offered from the header menu. */
	onOpenYazi?: () => void;
	/** Opens the project settings where `extraFolders` is edited. */
	onEditFolders?: () => void;
	/** Names the worktree's own section once extra folders appear; a task without a branch falls back to the folder name. */
	rootSectionLabel?: string;
	/** Bumped by the frame when the tree should take keyboard focus. */
	focusSignal?: number;
}

function errorMessage(listing: ExplorerListing, t: ReturnType<typeof useT>): string {
	switch (listing.error) {
		case "no-root": return t("fileExplorer.noRoot");
		case "not-found": return t("fileExplorer.notFound");
		default: return t("fileExplorer.unreadable");
	}
}

interface RememberedTree {
	expanded: Set<string>;
	openRoots: Set<string>;
}

/** Folders and roots the user opened, per tree, for the app session: switching tasks and back keeps the tree. */
const rememberedByTree = new Map<string, RememberedTree>();
const PRIMARY = "";

export default function FileExplorer({
	projectId,
	taskId,
	rootLabel,
	pinned,
	onTogglePin,
	onHide,
	onHandOff,
	onOpenYazi,
	onEditFolders,
	rootSectionLabel,
	focusSignal = 0,
}: FileExplorerProps) {
	const t = useT();
	const treeKey = `${projectId}:${taskId ?? ""}`;
	const remembered = rememberedByTree.get(treeKey);
	const [dirs, setDirs] = useState<Map<string, DirState>>(() => new Map());
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set(remembered?.expanded ?? []));
	const [openRoots, setOpenRoots] = useState<Set<string>>(() => new Set(remembered?.openRoots ?? [PRIMARY]));
	const [activeKey, setActiveKey] = useState<string | null>(null);
	const [rootPath, setRootPath] = useState("");
	const [menu, setMenu] = useState<{ entry: ExplorerEntry; rootId: string; top: number; left: number } | null>(null);
	const [moreMenu, setMoreMenu] = useState<{ top: number; left: number } | null>(null);
	const [foldersMenu, setFoldersMenu] = useState<{ top: number; left: number } | null>(null);
	const treeRef = useRef<HTMLDivElement>(null);
	const ignoredDirsRef = useRef<Set<string>>(new Set());
	const treeKeyRef = useRef(treeKey);
	treeKeyRef.current = treeKey;

	const folders = useProjectFolders(projectId);
	// Until the list answers, the header and tree wait: drawing the single-root layout first flashes it.
	const foldersLoaded = useProjectFoldersLoaded(projectId);
	const hiddenFolders = useHiddenFolders(projectId);
	const revealPath = useRevealRequest(projectId, taskId ?? null);
	const multiRoot = folders.length > 0;
	const roots = useMemo<ExplorerRootDef[]>(() => [
		{ id: PRIMARY, folder: null, label: rootSectionLabel ?? (taskId && rootPath ? baseName(rootPath) : rootLabel), hint: taskId ? t("fileExplorer.rootHintTask") : t("fileExplorer.rootHintProject") },
		...folders
			.filter((f) => !hiddenFolders.includes(f.path))
			.map((f) => ({ id: f.path, folder: f.path, label: f.name, hint: parentOf(f.displayPath), missing: !f.exists })),
	], [folders, hiddenFolders, rootLabel, rootSectionLabel, rootPath, taskId, t]);
	const rootsRef = useRef(roots);
	rootsRef.current = roots;
	const openRootsRef = useRef(openRoots);
	openRootsRef.current = openRoots;

	const loadDir = useCallback(async (rootId: string, relPath: string, quiet = false, insideIgnored = false) => {
		const requestedFor = treeKeyRef.current;
		const key = keyOf(rootId, relPath);
		if (!quiet) {
			setDirs((prev) => {
				const next = new Map(prev);
				const old = prev.get(key);
				next.set(key, { status: "loading", entries: old?.status === "ready" ? old.entries : undefined });
				return next;
			});
		}
		let state: DirState;
		let listing: ExplorerListing | null = null;
		try {
			listing = await api.request.listExplorerDirectory({ projectId, taskId: taskId ?? null, relPath, insideIgnored, ...(rootId ? { folder: rootId } : {}) });
			state = listing.error
				? { status: "error", message: errorMessage(listing, t) }
				: { status: "ready", entries: listing.entries, truncated: listing.truncated };
		} catch (err) {
			state = { status: "error", message: t("fileExplorer.failed", { error: String(err) }) };
		}
		if (treeKeyRef.current !== requestedFor) return;
		if (rootId === PRIMARY && relPath === "" && listing?.root) setRootPath(listing.root);
		// A folder deleted under an expanded row stops being polled.
		if (relPath !== "" && listing?.error === "not-found") {
			setExpanded((prev) => {
				if (!prev.has(key)) return prev;
				const next = new Set(prev);
				next.delete(key);
				return next;
			});
		}
		setDirs((prev) => new Map(prev).set(key, state));
	}, [projectId, taskId, t]);

	const loadRoot = useCallback((rootId: string, open: Set<string>, quiet = false) => {
		void loadDir(rootId, "", quiet);
		for (const key of open) {
			if (key.startsWith(rootId + KEY_SEP) && isReachable(key, open)) {
				void loadDir(rootId, splitKey(key)[1], quiet, ignoredDirsRef.current.has(key));
			}
		}
	}, [loadDir]);

	// A new tree starts from its own remembered folders.
	useEffect(() => {
		const saved = rememberedByTree.get(treeKey);
		const nextExpanded = new Set(saved?.expanded ?? []);
		const nextOpenRoots = new Set(saved?.openRoots ?? [PRIMARY]);
		setExpanded(nextExpanded);
		setOpenRoots(nextOpenRoots);
		setDirs(new Map());
		setActiveKey(null);
		setRootPath("");
		ignoredDirsRef.current = new Set();
		loadRoot(PRIMARY, nextExpanded);
	}, [treeKey, loadRoot]);

	useEffect(() => {
		rememberedByTree.set(treeKey, { expanded, openRoots });
	}, [treeKey, expanded, openRoots]);

	// An extra folder that is open but was never listed (it just appeared, or was unhidden) loads now.
	const extraRootIds = roots.slice(1).map((r) => r.id).join("\n");
	useEffect(() => {
		for (const root of rootsRef.current.slice(1)) {
			if (!root.missing && openRootsRef.current.has(root.id) && !dirs.has(keyOf(root.id, ""))) loadRoot(root.id, expanded);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [extraRootIds, openRoots]);

	const toggleRoot = useCallback((rootId: string, open?: boolean) => {
		const isOpen = openRoots.has(rootId);
		const want = open ?? !isOpen;
		if (want === isOpen) return;
		const next = new Set(openRoots);
		if (want) next.add(rootId);
		else next.delete(rootId);
		setOpenRoots(next);
		if (want && !rootsRef.current.find((r) => r.id === rootId)?.missing) loadRoot(rootId, expanded);
	}, [openRoots, expanded, loadRoot]);

	// The dashboard asked to show this folder: open its section and bring it into view.
	useEffect(() => {
		if (!revealPath || !folders.some((f) => f.path === revealPath)) return;
		// Unhide first; the section exists on the next render and the request is consumed then.
		if (hiddenFolders.includes(revealPath)) {
			setFolderHidden(projectId, revealPath, false);
			return;
		}
		clearRevealRequest();
		toggleRoot(revealPath, true);
		setActiveKey(keyOf(revealPath, ""));
		requestAnimationFrame(() => {
			treeRef.current
				?.querySelector<HTMLElement>(`[data-key="${CSS.escape(keyOf(revealPath, ""))}"]`)
				?.scrollIntoView({ block: "start" });
		});
	}, [revealPath, folders, hiddenFolders, projectId, toggleRoot]);

	const refreshAll = useCallback((quiet: boolean) => {
		const open = rememberedByTree.get(treeKeyRef.current)?.expanded ?? new Set<string>();
		const multi = rootsRef.current.length > 1;
		for (const root of rootsRef.current) {
			if (root.missing) continue;
			if ((!multi && root.id === PRIMARY) || openRootsRef.current.has(root.id)) loadRoot(root.id, open, quiet);
		}
	}, [loadRoot]);

	// No file watcher: agents create files continuously, so the tree re-lists what
	// is open on a slow timer and whenever the window regains focus.
	useEffect(() => {
		const tick = () => {
			if (document.visibilityState === "visible") refreshAll(true);
		};
		const id = window.setInterval(tick, POLL_INTERVAL_MS);
		window.addEventListener("focus", tick);
		return () => {
			window.clearInterval(id);
			window.removeEventListener("focus", tick);
		};
	}, [refreshAll]);

	useEffect(() => {
		if (focusSignal > 0) treeRef.current?.focus({ preventScroll: true });
	}, [focusSignal]);

	const rows = useMemo(() => {
		const out: VisibleRow[] = [];
		const walk = (rootId: string, relPath: string, depth: number, insideIgnored: boolean) => {
			const state = dirs.get(keyOf(rootId, relPath));
			const entries = state && state.status !== "error" ? state.entries ?? [] : [];
			for (const entry of entries) {
				const ignored = insideIgnored || entry.ignored;
				const key = keyOf(rootId, entry.relPath);
				out.push({ kind: "entry", key, rootId, entry, depth, ignored });
				if (entry.kind === "directory" && expanded.has(key)) walk(rootId, entry.relPath, depth + 1, ignored);
			}
		};
		if (!multiRoot) {
			walk(PRIMARY, "", 0, false);
			return out;
		}
		for (const root of roots) {
			const open = openRoots.has(root.id);
			out.push({ kind: "root", key: keyOf(root.id, ""), root, open });
			if (open) walk(root.id, "", 1, false);
		}
		return out;
	}, [dirs, expanded, openRoots, roots, multiRoot]);

	useEffect(() => {
		ignoredDirsRef.current = new Set(
			rows.flatMap((row) => (row.kind === "entry" && row.ignored && row.entry.kind === "directory" ? [row.key] : [])),
		);
	}, [rows]);

	const toggleDir = useCallback((rootId: string, relPath: string, open?: boolean) => {
		const key = keyOf(rootId, relPath);
		const isOpen = expanded.has(key);
		const want = open ?? !isOpen;
		if (want === isOpen) return;
		const next = new Set(expanded);
		if (want) next.add(key);
		else next.delete(key);
		setExpanded(next);
		if (want) void loadDir(rootId, relPath, false, ignoredDirsRef.current.has(key));
	}, [expanded, loadDir]);

	const openFile = useCallback((entry: ExplorerEntry) => {
		openFilePreview(entry.path, undefined, taskId ?? undefined);
		onHandOff?.();
	}, [taskId, onHandOff]);

	const activate = useCallback((row: VisibleRow) => {
		setActiveKey(row.key);
		if (row.kind === "root") toggleRoot(row.root.id);
		else if (row.entry.kind === "directory") toggleDir(row.rootId, row.entry.relPath);
		else openFile(row.entry);
	}, [toggleRoot, toggleDir, openFile]);

	const copyText = useCallback(async (text: string) => {
		const method = await writeClipboardText(text);
		if (method === "failed") toast.error(t("fileExplorer.copyFailed"));
		else toast.success(t("fileExplorer.copied"));
	}, [t]);

	const openWithSystem = useCallback(async (path: string, mode: "system" | "reveal") => {
		try {
			await api.request.openTerminalPath({ path, mode });
		} catch (err) {
			toast.error(t("fileExplorer.openFailed", { error: String(err) }));
		}
	}, [t]);

	function onTreeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
		// Escape leaves the tree; it must not also step the app's route back.
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			treeRef.current?.blur();
			return;
		}
		if (rows.length === 0) return;
		const index = Math.max(0, rows.findIndex((row) => row.key === activeKey));
		const row = rows[index];
		const move = (to: number) => {
			const target = rows[Math.min(rows.length - 1, Math.max(0, to))];
			setActiveKey(target.key);
			treeRef.current
				?.querySelector<HTMLElement>(`[data-key="${CSS.escape(target.key)}"]`)
				?.scrollIntoView({ block: "nearest", inline: "nearest" });
		};
		switch (event.key) {
			case "ArrowDown": move(activeKey === null ? 0 : index + 1); break;
			case "ArrowUp": move(index - 1); break;
			case "Home": move(0); break;
			case "End": move(rows.length - 1); break;
			case "ArrowRight":
				if (row.kind === "root") {
					if (!row.open) toggleRoot(row.root.id, true);
					else move(index + 1);
					break;
				}
				if (row.entry.kind !== "directory") return;
				if (!expanded.has(row.key)) toggleDir(row.rootId, row.entry.relPath, true);
				else move(index + 1);
				break;
			case "ArrowLeft": {
				if (row.kind === "root") {
					toggleRoot(row.root.id, false);
					break;
				}
				if (row.entry.kind === "directory" && expanded.has(row.key)) {
					toggleDir(row.rootId, row.entry.relPath, false);
					break;
				}
				const rel = row.entry.relPath;
				const parent = rel.includes("/") ? keyOf(row.rootId, rel.slice(0, rel.lastIndexOf("/"))) : multiRoot ? keyOf(row.rootId, "") : null;
				if (parent) move(rows.findIndex((r) => r.key === parent));
				break;
			}
			case "Enter":
			case " ":
				activate(row);
				break;
			default:
				return;
		}
		event.preventDefault();
		event.stopPropagation();
	}

	function openContextMenu(event: ReactMouseEvent, row: Extract<VisibleRow, { kind: "entry" }>) {
		event.preventDefault();
		setActiveKey(row.key);
		setMenu({ entry: row.entry, rootId: row.rootId, top: event.clientY, left: event.clientX });
	}

	const rootState = dirs.get(keyOf(PRIMARY, ""));
	const fileManager = fileManagerKeys();
	const fileMenuRegistry = getFileMenuRegistry();
	const fileMenuEntries = useSyncExternalStore(fileMenuRegistry.subscribe, fileMenuRegistry.list);

	/** The row menu comes from the `fileMenu` slot; only resolved while it is open. */
	function contextMenuSections(entry: ExplorerEntry, rootId: string): MenuItem[][] {
		const scope: FileMenuScope = {
			entry,
			inPrimaryRoot: rootId === PRIMARY,
			projectId,
			taskId: taskId ?? null,
			t,
			openFile: () => openFile(entry),
			handOff: () => onHandOff?.(),
			copyText: (text) => void copyText(text),
			openWithSystem: (path, mode) => void openWithSystem(path, mode),
		};
		return groupMenuRows("fileMenu", fileMenuEntries, scope, FILE_MENU_GROUPS).map((group) =>
			group.map(({ item, key, label }) => ({
				id: key,
				label,
				icon: item.icon ? <MenuIcon id={item.id} icon={item.icon} /> : null,
				run: () => runMenuItem("fileMenu", item.id, item.run, scope),
			})),
		);
	}

	const rootItems: MenuItem[] = [];
	if (isElectrobun && rootPath) rootItems.push({ id: "open-root", label: t(fileManager.openRoot), icon: <RevealGlyph />, run: () => void openWithSystem(rootPath, "system") });
	if (rootPath) rootItems.push({ id: "copy-root", label: t("fileExplorer.copyRootPath"), icon: <PathGlyph />, run: () => void copyText(rootPath) });
	if (onOpenYazi) rootItems.push({ id: "yazi", label: t("fileExplorer.openInYazi"), icon: <TuiGlyph />, run: onOpenYazi });
	const moreSections: MenuItem[][] = [
		...(rootItems.length ? [rootItems] : []),
		[{ id: "hide", label: t("fileExplorer.hide"), icon: <HideGlyph />, run: onHide }],
	];

	const headerButtonBase = "inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-raised-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";
	const headerButton = `${headerButtonBase} text-fg-3 hover:text-fg`;
	const hiddenNames = folders.filter((f) => hiddenFolders.includes(f.path)).map((f) => f.name);
	const nestedNote = (depth: number, text: string) => (
		<div className="h-6 flex items-center text-xs text-fg-muted" style={{ paddingLeft: 8 + depth * 12 + 18 }}>{text}</div>
	);

	function renderRootRow(row: Extract<VisibleRow, { kind: "root" }>) {
		const state = dirs.get(row.key);
		const isActive = row.key === activeKey;
		return (
			<div key={row.key}>
				<div
					role="treeitem"
					aria-level={1}
					aria-expanded={row.open}
					aria-selected={isActive}
					data-key={row.key}
					data-root={row.root.id || "primary"}
					onClick={() => activate(row)}
					title={row.root.folder ?? (rootPath || undefined)}
					className={`sticky top-0 z-[1] flex h-6 cursor-pointer select-none items-center gap-1 pl-1 pr-2 border-t border-edge first:border-t-0 ${
						isActive ? "bg-accent/15 text-fg" : "bg-raised hover:bg-raised-hover"
					}`}
				>
					<span className="inline-flex w-3.5 flex-shrink-0 justify-center text-fg-3" aria-hidden="true">
						<ChevronGlyph open={row.open} />
					</span>
					<span className="max-w-[14rem] truncate text-dense font-semibold uppercase tracking-[0.06em] text-fg-2">{row.root.label}</span>
					<span className="whitespace-nowrap text-dense text-fg-muted streamer-private">{row.root.hint}</span>
					{row.root.missing && <span className="whitespace-nowrap text-dense text-danger">{t("fileExplorer.folderMissing")}</span>}
				</div>
				{row.open && row.root.missing && nestedNote(0, t("fileExplorer.folderMissingNote"))}
				{row.open && state && state.status !== "ready" && !(state.status === "loading" && state.entries) &&
					nestedNote(0, state.status === "error" ? state.message : t("fileExplorer.loading"))}
				{row.open && state?.status === "ready" && state.entries.length === 0 && nestedNote(0, t("fileExplorer.empty"))}
				{row.open && state?.status === "ready" && state.truncated && nestedNote(0, t("fileExplorer.truncated", { limit: String(EXPLORER_MAX_ENTRIES) }))}
			</div>
		);
	}

	function renderEntryRow(row: Extract<VisibleRow, { kind: "entry" }>) {
		const { entry, depth, ignored } = row;
		const isDir = entry.kind === "directory";
		const isOpen = isDir && expanded.has(row.key);
		const dirState = isOpen ? dirs.get(row.key) : undefined;
		const isActive = row.key === activeKey;
		return (
			<div key={row.key}>
				<div
					role="treeitem"
					aria-level={depth + 1}
					aria-expanded={isDir ? isOpen : undefined}
					aria-selected={isActive}
					data-rel={entry.relPath}
					data-key={row.key}
					onClick={() => activate(row)}
					onContextMenu={(event) => openContextMenu(event, row)}
					title={entry.relPath}
					className={`flex h-6 cursor-pointer select-none items-center gap-1 pr-2 text-xs ${
						isActive ? "bg-accent/15 text-fg" : "hover:bg-raised-hover"
					} ${ignored ? "text-fg-muted" : ""}`}
					style={{ paddingLeft: 8 + depth * 12 }}
				>
					<span className="inline-flex w-3.5 flex-shrink-0 justify-center text-fg-muted" aria-hidden="true">
						{isDir && <ChevronGlyph open={isOpen} />}
					</span>
					<span className={`flex-shrink-0 ${isDir ? "text-accent" : "text-fg-3"}`} aria-hidden="true">
						{isDir ? <FolderGlyph open={isOpen} /> : <FileGlyph />}
					</span>
					<span className="whitespace-nowrap">{entry.name}</span>
				</div>
				{isOpen && dirState && dirState.status !== "ready" && !(dirState.status === "loading" && dirState.entries) &&
					nestedNote(depth + 1, dirState.status === "error" ? dirState.message : t("fileExplorer.loading"))}
				{isOpen && dirState?.status === "ready" && dirState.entries.length === 0 && nestedNote(depth + 1, t("fileExplorer.empty"))}
				{isOpen && dirState?.status === "ready" && dirState.truncated &&
					nestedNote(depth + 1, t("fileExplorer.truncated", { limit: String(EXPLORER_MAX_ENTRIES) }))}
			</div>
		);
	}

	const singleRootStatus = !foldersLoaded
		? t("fileExplorer.loading")
		: !multiRoot
		? !rootState || (rootState.status === "loading" && !rootState.entries)
			? t("fileExplorer.loading")
			: rootState.status === "error"
				? rootState.message
				: rows.length === 0 ? t("fileExplorer.empty") : null
		: null;

	return (
		<div className="h-full w-full flex flex-col bg-raised text-fg-2 min-w-0" data-testid="file-explorer">
			<div className="flex items-center gap-1 pl-3 pr-1.5 h-9 flex-shrink-0 border-b border-edge">
				{!foldersLoaded ? (
					<div className="min-w-0 flex-1" />
				) : multiRoot ? (
					// The task title or project name moves into the first section, so the narrow header keeps only the picker.
					<div className="min-w-0 flex-1">
						<button
							type="button"
							data-testid="file-explorer-folders"
							aria-haspopup="menu"
							aria-expanded={foldersMenu !== null}
							onClick={(event) => {
								const rect = event.currentTarget.getBoundingClientRect();
								setFoldersMenu({ top: rect.bottom + 4, left: rect.left });
							}}
							className="-ml-1.5 inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 h-7 text-xs font-semibold text-fg-2 hover:bg-raised-hover hover:text-fg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
						>
							<span className="truncate">{t("fileExplorer.folders")}</span>
							<span className="flex-shrink-0 font-medium tabular-nums text-fg-muted">{roots.length}/{folders.length + 1}</span>
							<span className="flex-shrink-0 text-fg-muted" aria-hidden="true"><DownGlyph /></span>
						</button>
					</div>
				) : (
					// The label names the branch or project; hovering shows where it lives on disk.
					<Tooltip
						content={rootLabel}
						detail={rootPath ? <span className="font-mono break-all streamer-private" data-testid="file-explorer-root-path">{rootPath}</span> : undefined}
						wide
						placement="bottom"
					>
						<div className="min-w-0 flex-1 truncate text-xs font-semibold text-fg-2">
							{rootLabel}
						</div>
					</Tooltip>
				)}
				<Tooltip content={t("fileExplorer.refresh")}>
					<button type="button" className={headerButton} aria-label={t("fileExplorer.refresh")} onClick={() => { reloadProjectFolders(projectId, { fresh: true }); refreshAll(false); }}>
						<RefreshGlyph />
					</button>
				</Tooltip>
				<Tooltip content={t("fileExplorer.collapseAll")}>
					<button
						type="button"
						className={headerButton}
						aria-label={t("fileExplorer.collapseAll")}
						onClick={() => {
							setExpanded(new Set());
							if (multiRoot) setOpenRoots(new Set());
						}}
					>
						<CollapseGlyph />
					</button>
				</Tooltip>
				<Tooltip content={pinned ? t("fileExplorer.autohide") : t("fileExplorer.pin")}>
					<button
						type="button"
						className={`${headerButtonBase} ${pinned ? "text-accent hover:text-accent-emphasis" : "text-fg-3 hover:text-fg"}`}
						aria-label={t("fileExplorer.pin")}
						aria-pressed={pinned}
						onClick={onTogglePin}
					>
						<PinGlyph />
					</button>
				</Tooltip>
				<Tooltip content={t("fileExplorer.more")}>
					<button
						type="button"
						className={headerButton}
						aria-label={t("fileExplorer.more")}
						aria-haspopup="menu"
						onClick={(event) => {
							const rect = event.currentTarget.getBoundingClientRect();
							setMoreMenu({ top: rect.bottom + 4, left: rect.right });
						}}
					>
						<MoreGlyph />
					</button>
				</Tooltip>
			</div>

			<div
				ref={treeRef}
				role="tree"
				aria-label={t("fileExplorer.treeLabel", { name: rootLabel })}
				tabIndex={0}
				onKeyDown={onTreeKeyDown}
				className={`flex-1 min-h-0 overflow-auto focus-visible:outline-none ${multiRoot ? "pb-1" : "py-1"}`}
			>
				{singleRootStatus !== null ? (
					<div className="px-3 py-1 text-xs text-fg-muted">{singleRootStatus}</div>
				) : (
					// Rows size to their longest name so the tree scrolls sideways instead of truncating.
					<div className="min-w-full w-max">
						{rows.map((row) => (row.kind === "root" ? renderRootRow(row) : renderEntryRow(row)))}
					</div>
				)}
				{!multiRoot && rootState?.status === "ready" && rootState.truncated && (
					<div className="px-3 py-1 text-xs text-fg-muted">{t("fileExplorer.truncated", { limit: String(EXPLORER_MAX_ENTRIES) })}</div>
				)}
				{hiddenNames.length > 0 && (
					<button
						type="button"
						onClick={(event) => {
							const rect = event.currentTarget.getBoundingClientRect();
							setFoldersMenu({ top: rect.bottom + 4, left: rect.left + 8 });
						}}
						className="block w-full truncate px-2 h-6 text-left text-micro italic text-fg-muted hover:text-fg-3"
						data-testid="file-explorer-hidden-folders"
					>
						{t.plural("fileExplorer.hiddenFolders", hiddenNames.length)} · {hiddenNames.join(", ")}
					</button>
				)}
			</div>

			{menu && (
				<ExplorerMenu
					top={menu.top}
					left={menu.left}
					title={{ name: menu.entry.name, icon: menu.entry.kind === "directory" ? <FolderGlyph open={false} /> : <FileGlyph /> }}
					sections={contextMenuSections(menu.entry, menu.rootId)}
					onClose={() => setMenu(null)}
				/>
			)}
			{moreMenu && (
				<ExplorerMenu
					top={moreMenu.top}
					left={moreMenu.left}
					alignEnd
					sections={moreSections}
					onClose={() => setMoreMenu(null)}
				/>
			)}
			{foldersMenu && (
				<FolderPickerMenu
					top={foldersMenu.top}
					left={foldersMenu.left}
					primary={{ label: rootLabel, path: rootPath }}
					folders={folders}
					hidden={hiddenFolders}
					onToggle={(path, show) => setFolderHidden(projectId, path, !show)}
					onShowAll={() => showAllFolders(projectId)}
					onEdit={onEditFolders}
					onClose={() => setFoldersMenu(null)}
				/>
			)}
		</div>
	);
}

const MENU_ITEMS = "[role=menuitemcheckbox]:not([aria-disabled=true]), [role=menuitem]";

/**
 * The one popup frame every explorer menu uses: a portal over a click-away backdrop,
 * measured invisible first and clamped into the window, focus on the first item,
 * Escape to close, arrow keys, Home and End between items.
 */
function MenuShell({ top, left, alignEnd = false, label, testId, className, onClose, children }: {
	top: number;
	left: number;
	/** `left` is the menu's right edge: a header button's menu opens under it, flush right. */
	alignEnd?: boolean;
	label?: string;
	testId?: string;
	className: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const menuRef = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
	// The parent re-renders on every toggle and poll; a fresh onClose must not re-run the focus below.
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		const el = menuRef.current;
		if (el) {
			const rect = el.getBoundingClientRect();
			setPosition({
				top: Math.max(8, Math.min(top, window.innerHeight - rect.height - 8)),
				left: Math.max(8, Math.min(alignEnd ? left - rect.width : left, window.innerWidth - rect.width - 8)),
			});
		}
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onCloseRef.current();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [top, left, alignEnd]);

	// A browser refuses focus while the menu is still measured invisible, so focus waits for the first placement.
	const placed = position !== null;
	useEffect(() => {
		if (placed) menuRef.current?.querySelector<HTMLElement>(MENU_ITEMS)?.focus();
	}, [placed]);

	function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
		const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? []);
		const index = items.indexOf(document.activeElement as HTMLElement);
		let next: number;
		if (event.key === "ArrowDown") next = (index + 1) % items.length;
		else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = items.length - 1;
		else return;
		event.preventDefault();
		items[next]?.focus();
	}

	return createPortal(
		<>
			<div
				className="fixed inset-0 z-[200]"
				onClick={onClose}
				onContextMenu={(event) => {
					event.preventDefault();
					onClose();
				}}
			/>
			<div
				ref={menuRef}
				role="menu"
				aria-label={label}
				onKeyDown={onMenuKeyDown}
				data-testid={testId}
				className={`fixed z-[201] rounded-xl bg-overlay p-1 ring-1 ring-edge-active shadow-2xl shadow-black/40 ${className} ${position ? "" : "invisible"}`}
				style={{ top: position?.top ?? top, left: position?.left ?? left }}
			>
				{children}
			</div>
		</>,
		document.body,
	);
}

/** Checkboxes choosing which extra folders the tree shows; stays open while toggling. */
function FolderPickerMenu({ top, left, primary, folders, hidden, onToggle, onShowAll, onEdit, onClose }: {
	top: number;
	left: number;
	primary: { label: string; path: string };
	folders: ProjectFolder[];
	hidden: string[];
	onToggle: (path: string, show: boolean) => void;
	onShowAll: () => void;
	onEdit?: () => void;
	onClose: () => void;
}) {
	const t = useT();
	const item = "group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-overlay-hover focus-visible:bg-overlay-hover focus-visible:outline-none";
	const check = (checked: boolean) => (
		<span
			aria-hidden="true"
			className={`inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded ${checked ? "bg-accent-fill text-white" : "ring-1 ring-inset ring-edge-active"}`}
		>
			{checked && <CheckGlyph />}
		</span>
	);
	const action = "flex w-full items-center rounded-lg px-2 py-1.5 text-left text-xs text-fg-2 transition-colors hover:bg-overlay-hover hover:text-fg focus-visible:bg-overlay-hover focus-visible:text-fg focus-visible:outline-none";

	return (
		<MenuShell top={top} left={left} label={t("fileExplorer.showFolders")} testId="file-explorer-folder-picker" className="w-[17rem]" onClose={onClose}>
			<div className="px-2 pb-1 pt-1.5 text-dense font-semibold uppercase tracking-[0.06em] text-fg-muted">{t("fileExplorer.showFolders")}</div>
			<div className="max-h-[15rem] overflow-y-auto">
				<div role="menuitemcheckbox" aria-checked="true" aria-disabled="true" className={`${item} opacity-60 cursor-default hover:bg-transparent`}>
					{check(true)}
					<span className="min-w-0 flex-1">
						<span className="block truncate text-xs text-fg-2">{primary.label}</span>
						{primary.path && <span className="block truncate font-mono text-dense text-fg-muted streamer-private">{primary.path}</span>}
					</span>
				</div>
				{folders.map((folder) => {
					const shown = !hidden.includes(folder.path);
					return (
						<button
							key={folder.path}
							type="button"
							role="menuitemcheckbox"
							aria-checked={shown}
							onClick={() => onToggle(folder.path, !shown)}
							title={folder.path}
							className={item}
						>
							{check(shown)}
							<span className="min-w-0 flex-1">
								<span className="block truncate text-xs text-fg-2 group-hover:text-fg">{folder.name}</span>
								<span className="block truncate font-mono text-dense text-fg-muted streamer-private">{folder.displayPath}</span>
							</span>
							<span className={`flex-shrink-0 rounded px-1 text-dense ring-1 ring-inset ${folder.exists ? "text-fg-3 ring-edge" : "text-danger ring-danger/40"}`}>
								{folder.exists ? folderSourceLabel(folder, t) : t("fileExplorer.folderMissing")}
							</span>
						</button>
					);
				})}
			</div>
			<div role="group" className="mt-1 border-t border-edge pt-1">
				{folders.some((f) => hidden.includes(f.path)) && (
					<button type="button" role="menuitem" className={action} onClick={onShowAll}>{t("fileExplorer.showAllFolders")}</button>
				)}
				{onEdit && (
					<button
						type="button"
						role="menuitem"
						className={action}
						onClick={() => {
							onClose();
							onEdit();
						}}
					>
						{t("fileExplorer.editFolders")}
					</button>
				)}
			</div>
		</MenuShell>
	);
}

/** A crashing glyph leaves its row without an icon, never the menu without rows. */
function MenuIcon({ id, icon: Icon }: { id: string; icon: ComponentType }) {
	return (
		<SlotErrorBoundary slot="fileMenu" resetKey={id} fallback={() => null}>
			<Icon />
		</SlotErrorBoundary>
	);
}

function ExplorerMenu({ top, left, alignEnd = false, title, sections, onClose }: {
	top: number;
	left: number;
	alignEnd?: boolean;
	/** The entry the menu acts on, so a right-click in a long list is never ambiguous. */
	title?: { name: string; icon: ReactNode };
	sections: MenuItem[][];
	onClose: () => void;
}) {
	return (
		<MenuShell top={top} left={left} alignEnd={alignEnd} label={title?.name} className="w-max min-w-[12.5rem] max-w-[20rem]" onClose={onClose}>
			{title && (
				<div className="flex min-w-0 items-center gap-2 px-2 pb-1.5 pt-1 text-xs text-fg-muted" data-testid="file-explorer-menu-title">
					<span className="flex w-4 flex-shrink-0 justify-center" aria-hidden="true">{title.icon}</span>
					<span className="min-w-0 truncate font-medium text-fg-3">{title.name}</span>
				</div>
			)}
			{sections.map((section, sectionIndex) => (
				<div key={section[0]?.id ?? sectionIndex} role="group" className={sectionIndex > 0 || title ? "mt-1 border-t border-edge pt-1" : ""}>
					{section.map((item) => (
						<button
							key={item.id}
							type="button"
							role="menuitem"
							onClick={() => {
								onClose();
								item.run();
							}}
							className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs text-fg-2 transition-colors hover:bg-overlay-hover hover:text-fg focus-visible:bg-overlay-hover focus-visible:text-fg focus-visible:outline-none"
						>
							<span className="flex w-4 flex-shrink-0 justify-center text-fg-3 transition-colors group-hover:text-accent group-focus-visible:text-accent" aria-hidden="true">
								{item.icon}
							</span>
							<span className="min-w-0 flex-1 truncate">{item.label}</span>
						</button>
					))}
				</div>
			))}
		</MenuShell>
	);
}

const glyph = {
	width: 14,
	height: 14,
	viewBox: "0 0 24 24",
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 2,
	strokeLinecap: "round" as const,
	strokeLinejoin: "round" as const,
};

function ChevronGlyph({ open }: { open: boolean }) {
	return (
		<svg {...glyph} width={12} height={12} className={`transition-transform ${open ? "rotate-90" : ""}`}>
			<polyline points="9 6 15 12 9 18" />
		</svg>
	);
}

function DownGlyph() {
	return (
		<svg {...glyph} width={12} height={12}>
			<polyline points="6 9 12 15 18 9" />
		</svg>
	);
}

function CheckGlyph() {
	return (
		<svg {...glyph} width={11} height={11} strokeWidth={3}>
			<polyline points="5 12 10 17 19 7" />
		</svg>
	);
}

function FolderGlyph({ open }: { open: boolean }) {
	return open ? (
		<svg {...glyph}>
			<path d="M3 7.5V6a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1" />
			<path d="M3 19.5 5.5 10h16L19 19.5Z" />
		</svg>
	) : (
		<svg {...glyph}>
			<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
		</svg>
	);
}

function FileGlyph() {
	return (
		<svg {...glyph}>
			<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
			<polyline points="14 3 14 8 19 8" />
		</svg>
	);
}

function RefreshGlyph() {
	return (
		<svg {...glyph}>
			<path d="M20 11a8 8 0 1 0-2.3 5.7" />
			<polyline points="20 4 20 11 13 11" />
		</svg>
	);
}

function CollapseGlyph() {
	return (
		<svg {...glyph}>
			<polyline points="7 4 12 9 17 4" />
			<polyline points="7 20 12 15 17 20" />
		</svg>
	);
}

function PinGlyph() {
	return (
		<svg {...glyph}>
			<path d="M9 4h6l-1 5 3 3v2H7v-2l3-3Z" />
			<line x1="12" y1="14" x2="12" y2="20" />
		</svg>
	);
}

function MoreGlyph() {
	return (
		<svg {...glyph}>
			<circle cx="5" cy="12" r="1" />
			<circle cx="12" cy="12" r="1" />
			<circle cx="19" cy="12" r="1" />
		</svg>
	);
}

export function ExplorerRailGlyph() {
	return (
		<svg {...glyph} width={16} height={16}>
			<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
		</svg>
	);
}

// Menu glyphs: one outline set, a lighter stroke to sit beside 12px regular text.
const menuGlyph = { ...glyph, strokeWidth: 1.75 };

function TuiGlyph() {
	return (
		<svg {...menuGlyph}>
			<rect x="3" y="4.5" width="18" height="15" rx="2.5" />
			<path d="M3 9h18" />
			<path d="M9 9v10.5" />
		</svg>
	);
}

function HideGlyph() {
	return (
		<svg {...menuGlyph}>
			<path d="M3 3l18 18" />
			<path d="M10.6 5.6A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.6 6.6C3.9 8.4 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9.6 9.6 0 0 0 4.4-1.1" />
			<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
		</svg>
	);
}
