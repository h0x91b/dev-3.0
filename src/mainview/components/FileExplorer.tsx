import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { EXPLORER_MAX_ENTRIES, type ExplorerEntry, type ExplorerListing } from "../../shared/types";
import { api, isElectrobun } from "../rpc";
import { useT } from "../i18n";
import { toast } from "../toast";
import { openFilePreview } from "../terminal-path-open";
import { requestTerminalPaste, terminalPasteTarget } from "../terminal-paste-request";
import { writeClipboardText } from "../utils/clipboard-write";
import Tooltip from "./Tooltip";
import { isMac, isWindows } from "../utils/platform";

/** Folders the user expanded, per root, for the app session: switching tasks and back keeps the tree. */
const expandedByRoot = new Map<string, Set<string>>();
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

type RevealKey = "fileExplorer.revealFinder" | "fileExplorer.revealExplorer" | "fileExplorer.reveal";
type OpenRootKey = "fileExplorer.openRootFinder" | "fileExplorer.openRootExplorer" | "fileExplorer.openRoot";

/** The host's file manager by name: these items only exist in the desktop shell, whose OS is the host's. */
function fileManagerKeys(): { reveal: RevealKey; openRoot: OpenRootKey } {
	if (isMac()) return { reveal: "fileExplorer.revealFinder", openRoot: "fileExplorer.openRootFinder" };
	if (isWindows()) return { reveal: "fileExplorer.revealExplorer", openRoot: "fileExplorer.openRootExplorer" };
	return { reveal: "fileExplorer.reveal", openRoot: "fileExplorer.openRoot" };
}

interface VisibleRow {
	entry: ExplorerEntry;
	depth: number;
	/** Git reports only the outermost ignored folder, so its whole subtree inherits the flag. */
	ignored: boolean;
}

/** An expanded folder is only on screen while every folder above it is expanded too. */
function isReachable(relPath: string, expanded: Set<string>): boolean {
	for (let i = relPath.indexOf("/"); i !== -1; i = relPath.indexOf("/", i + 1)) {
		if (!expanded.has(relPath.slice(0, i))) return false;
	}
	return true;
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
	/** The legacy yazi pane, offered from the header menu on tmux-backed tasks. */
	onOpenYazi?: () => void;
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

/**
 * Anything outside a conservative safe set gets single quotes, which mean the
 * same to POSIX shells and PowerShell; only an embedded quote is escaped the
 * POSIX way, so a name with `'` still needs care in PowerShell.
 */
export function quoteForShell(relPath: string): string {
	return /^[\w./@%+=:,-]+$/.test(relPath) ? relPath : `'${relPath.replace(/'/g, "'\\''")}'`;
}

export default function FileExplorer({
	projectId,
	taskId,
	rootLabel,
	pinned,
	onTogglePin,
	onHide,
	onHandOff,
	onOpenYazi,
	focusSignal = 0,
}: FileExplorerProps) {
	const t = useT();
	const rootKey = `${projectId}:${taskId ?? ""}`;
	const [dirs, setDirs] = useState<Map<string, DirState>>(() => new Map());
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set(expandedByRoot.get(rootKey) ?? []));
	const [activeRel, setActiveRel] = useState<string | null>(null);
	const [rootPath, setRootPath] = useState("");
	const [menu, setMenu] = useState<{ entry: ExplorerEntry; top: number; left: number } | null>(null);
	const [moreMenu, setMoreMenu] = useState<{ top: number; left: number } | null>(null);
	const treeRef = useRef<HTMLDivElement>(null);
	const ignoredDirsRef = useRef<Set<string>>(new Set());
	const rootKeyRef = useRef(rootKey);
	rootKeyRef.current = rootKey;

	const loadDir = useCallback(async (relPath: string, quiet = false, insideIgnored = false) => {
		const requestedFor = rootKeyRef.current;
		if (!quiet) {
			setDirs((prev) => {
				const next = new Map(prev);
				const old = prev.get(relPath);
				next.set(relPath, { status: "loading", entries: old?.status === "ready" ? old.entries : undefined });
				return next;
			});
		}
		let state: DirState;
		let listing: ExplorerListing | null = null;
		try {
			listing = await api.request.listExplorerDirectory({ projectId, taskId: taskId ?? null, relPath, insideIgnored });
			state = listing.error
				? { status: "error", message: errorMessage(listing, t) }
				: { status: "ready", entries: listing.entries, truncated: listing.truncated };
		} catch (err) {
			state = { status: "error", message: t("fileExplorer.failed", { error: String(err) }) };
		}
		if (rootKeyRef.current !== requestedFor) return;
		if (relPath === "" && listing?.root) setRootPath(listing.root);
		// A folder deleted under an expanded row stops being polled.
		if (relPath !== "" && listing?.error === "not-found") {
			setExpanded((prev) => {
				if (!prev.has(relPath)) return prev;
				const next = new Set(prev);
				next.delete(relPath);
				return next;
			});
		}
		setDirs((prev) => new Map(prev).set(relPath, state));
	}, [projectId, taskId, t]);

	// A new root starts from its own remembered folders.
	useEffect(() => {
		const remembered = new Set(expandedByRoot.get(rootKey) ?? []);
		setExpanded(remembered);
		setDirs(new Map());
		setActiveRel(null);
		setRootPath("");
		ignoredDirsRef.current = new Set();
		void loadDir("");
		for (const rel of remembered) if (isReachable(rel, remembered)) void loadDir(rel);
	}, [rootKey, loadDir]);

	useEffect(() => {
		expandedByRoot.set(rootKey, expanded);
	}, [rootKey, expanded]);

	const refreshAll = useCallback((quiet: boolean) => {
		void loadDir("", quiet);
		const open = expandedByRoot.get(rootKeyRef.current) ?? new Set<string>();
		for (const rel of open) {
			if (isReachable(rel, open)) void loadDir(rel, quiet, ignoredDirsRef.current.has(rel));
		}
	}, [loadDir]);

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
		const walk = (relPath: string, depth: number, insideIgnored: boolean) => {
			const state = dirs.get(relPath);
			const entries = state && state.status !== "error" ? state.entries ?? [] : [];
			for (const entry of entries) {
				const ignored = insideIgnored || entry.ignored;
				out.push({ entry, depth, ignored });
				if (entry.kind === "directory" && expanded.has(entry.relPath)) walk(entry.relPath, depth + 1, ignored);
			}
		};
		walk("", 0, false);
		return out;
	}, [dirs, expanded]);

	useEffect(() => {
		ignoredDirsRef.current = new Set(rows.filter((row) => row.ignored && row.entry.kind === "directory").map((row) => row.entry.relPath));
	}, [rows]);

	const toggleDir = useCallback((relPath: string, open?: boolean) => {
		const isOpen = expanded.has(relPath);
		const want = open ?? !isOpen;
		if (want === isOpen) return;
		const next = new Set(expanded);
		if (want) next.add(relPath);
		else next.delete(relPath);
		setExpanded(next);
		if (want) void loadDir(relPath, false, ignoredDirsRef.current.has(relPath));
	}, [expanded, loadDir]);

	const openFile = useCallback((entry: ExplorerEntry) => {
		openFilePreview(entry.path, undefined, taskId ?? undefined);
		onHandOff?.();
	}, [taskId, onHandOff]);

	const activate = useCallback((entry: ExplorerEntry) => {
		setActiveRel(entry.relPath);
		if (entry.kind === "directory") toggleDir(entry.relPath);
		else openFile(entry);
	}, [toggleDir, openFile]);

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
		const index = Math.max(0, rows.findIndex((row) => row.entry.relPath === activeRel));
		const row = rows[index];
		const move = (to: number) => {
			const target = rows[Math.min(rows.length - 1, Math.max(0, to))];
			setActiveRel(target.entry.relPath);
			treeRef.current
				?.querySelector<HTMLElement>(`[data-rel="${CSS.escape(target.entry.relPath)}"]`)
				?.scrollIntoView({ block: "nearest", inline: "nearest" });
		};
		switch (event.key) {
			case "ArrowDown": move(activeRel === null ? 0 : index + 1); break;
			case "ArrowUp": move(index - 1); break;
			case "Home": move(0); break;
			case "End": move(rows.length - 1); break;
			case "ArrowRight":
				if (row.entry.kind !== "directory") return;
				if (!expanded.has(row.entry.relPath)) toggleDir(row.entry.relPath, true);
				else move(index + 1);
				break;
			case "ArrowLeft": {
				if (row.entry.kind === "directory" && expanded.has(row.entry.relPath)) {
					toggleDir(row.entry.relPath, false);
					break;
				}
				const parent = row.entry.relPath.includes("/") ? row.entry.relPath.slice(0, row.entry.relPath.lastIndexOf("/")) : null;
				if (parent) move(rows.findIndex((r) => r.entry.relPath === parent));
				break;
			}
			case "Enter":
			case " ":
				activate(row.entry);
				break;
			default:
				return;
		}
		event.preventDefault();
		event.stopPropagation();
	}

	function openContextMenu(event: ReactMouseEvent, entry: ExplorerEntry) {
		event.preventDefault();
		setActiveRel(entry.relPath);
		setMenu({ entry, top: event.clientY, left: event.clientX });
	}

	const rootState = dirs.get("");
	const fileManager = fileManagerKeys();

	function contextMenuSections(entry: ExplorerEntry): MenuItem[][] {
		const sections: MenuItem[][] = [];
		if (entry.kind === "file") sections.push([{ id: "open", label: t("fileExplorer.open"), icon: <EyeGlyph />, run: () => openFile(entry) }]);
		sections.push([
			{
				id: "insert",
				label: t("fileExplorer.insertPath"),
				icon: <InsertGlyph />,
				run: () => {
					requestTerminalPaste(terminalPasteTarget(projectId, taskId), `${quoteForShell(entry.relPath)} `);
					onHandOff?.();
				},
			},
			{ id: "copy-relative", label: t("fileExplorer.copyRelativePath"), icon: <CopyGlyph />, run: () => void copyText(entry.relPath) },
			{ id: "copy-path", label: t("fileExplorer.copyPath"), icon: <PathGlyph />, run: () => void copyText(entry.path) },
		]);
		// Desktop only: in a browser tab these would open the file on the host machine.
		if (isElectrobun) {
			const host: MenuItem[] = [];
			if (entry.kind === "file") host.push({ id: "open-system", label: t("fileExplorer.openSystem"), icon: <ExternalGlyph />, run: () => void openWithSystem(entry.path, "system") });
			host.push({ id: "reveal", label: t(fileManager.reveal), icon: <RevealGlyph />, run: () => void openWithSystem(entry.path, "reveal") });
			sections.push(host);
		}
		return sections;
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

	return (
		<div className="h-full w-full flex flex-col bg-raised text-fg-2 min-w-0" data-testid="file-explorer">
			<div className="flex items-center gap-1 pl-3 pr-1.5 h-9 flex-shrink-0 border-b border-edge">
				{/* The label names the branch or project; hovering shows where it lives on disk. */}
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
				<Tooltip content={t("fileExplorer.refresh")}>
					<button type="button" className={headerButton} aria-label={t("fileExplorer.refresh")} onClick={() => refreshAll(false)}>
						<RefreshGlyph />
					</button>
				</Tooltip>
				<Tooltip content={t("fileExplorer.collapseAll")}>
					<button type="button" className={headerButton} aria-label={t("fileExplorer.collapseAll")} onClick={() => setExpanded(new Set())}>
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
				className="flex-1 min-h-0 overflow-auto py-1 focus-visible:outline-none"
			>
				{!rootState || (rootState.status === "loading" && !rootState.entries) ? (
					<div className="px-3 py-1 text-xs text-fg-muted">{t("fileExplorer.loading")}</div>
				) : rootState.status === "error" ? (
					<div className="px-3 py-1 text-xs text-fg-muted">{rootState.message}</div>
				) : rows.length === 0 ? (
					<div className="px-3 py-1 text-xs text-fg-muted">{t("fileExplorer.empty")}</div>
				) : (
					// Rows size to their longest name so the tree scrolls sideways instead of truncating.
					<div className="min-w-full w-max">
					{rows.map(({ entry, depth, ignored }) => {
						const isDir = entry.kind === "directory";
						const isOpen = isDir && expanded.has(entry.relPath);
						const dirState = isOpen ? dirs.get(entry.relPath) : undefined;
						const isActive = entry.relPath === activeRel;
						return (
							<div key={entry.relPath}>
								<div
									role="treeitem"
									aria-level={depth + 1}
									aria-expanded={isDir ? isOpen : undefined}
									aria-selected={isActive}
									data-rel={entry.relPath}
									onClick={() => activate(entry)}
									onContextMenu={(event) => openContextMenu(event, entry)}
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
								{isOpen && dirState && dirState.status !== "ready" && !(dirState.status === "loading" && dirState.entries) && (
									<div className="h-6 flex items-center text-xs text-fg-muted" style={{ paddingLeft: 8 + (depth + 1) * 12 + 18 }}>
										{dirState.status === "error" ? dirState.message : t("fileExplorer.loading")}
									</div>
								)}
								{isOpen && dirState?.status === "ready" && dirState.entries.length === 0 && (
									<div className="h-6 flex items-center text-xs text-fg-muted" style={{ paddingLeft: 8 + (depth + 1) * 12 + 18 }}>
										{t("fileExplorer.empty")}
									</div>
								)}
								{isOpen && dirState?.status === "ready" && dirState.truncated && (
									<div className="h-6 flex items-center text-xs text-fg-muted" style={{ paddingLeft: 8 + (depth + 1) * 12 + 18 }}>
										{t("fileExplorer.truncated", { limit: String(EXPLORER_MAX_ENTRIES) })}
									</div>
								)}
							</div>
						);
					})}
					</div>
				)}
				{rootState?.status === "ready" && rootState.truncated && (
					<div className="px-3 py-1 text-xs text-fg-muted">{t("fileExplorer.truncated", { limit: String(EXPLORER_MAX_ENTRIES) })}</div>
				)}
			</div>

			{menu && (
				<ExplorerMenu
					top={menu.top}
					left={menu.left}
					title={{ name: menu.entry.name, icon: menu.entry.kind === "directory" ? <FolderGlyph open={false} /> : <FileGlyph /> }}
					sections={contextMenuSections(menu.entry)}
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
		</div>
	);
}

function ExplorerMenu({ top, left, alignEnd = false, title, sections, onClose }: {
	top: number;
	left: number;
	/** `left` is the menu's right edge: a header button's menu opens under it, flush right. */
	alignEnd?: boolean;
	/** The entry the menu acts on, so a right-click in a long list is never ambiguous. */
	title?: { name: string; icon: ReactNode };
	sections: MenuItem[][];
	onClose: () => void;
}) {
	const menuRef = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

	useEffect(() => {
		const el = menuRef.current;
		if (el) {
			const rect = el.getBoundingClientRect();
			setPosition({
				top: Math.max(8, Math.min(top, window.innerHeight - rect.height - 8)),
				left: Math.max(8, Math.min(alignEnd ? left - rect.width : left, window.innerWidth - rect.width - 8)),
			});
			el.querySelector<HTMLElement>("[role=menuitem]")?.focus();
		}
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [top, left, alignEnd, onClose]);

	function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
		const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
		const index = buttons.indexOf(document.activeElement as HTMLElement);
		let next: number;
		if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
		else if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = buttons.length - 1;
		else return;
		event.preventDefault();
		buttons[next]?.focus();
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
			{/* Measured invisible first, so clamping into the window never shows a jump. */}
			<div
				ref={menuRef}
				role="menu"
				aria-label={title?.name}
				onKeyDown={onMenuKeyDown}
				className={`fixed z-[201] w-max min-w-[12.5rem] max-w-[20rem] rounded-xl bg-overlay p-1 ring-1 ring-edge-active shadow-2xl shadow-black/40 ${position ? "" : "invisible"}`}
				style={{ top: position?.top ?? top, left: position?.left ?? left }}
			>
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
			</div>
		</>,
		document.body,
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

function EyeGlyph() {
	return (
		<svg {...menuGlyph}>
			<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
			<circle cx="12" cy="12" r="2.75" />
		</svg>
	);
}

function InsertGlyph() {
	return (
		<svg {...menuGlyph}>
			<rect x="3" y="4.5" width="18" height="15" rx="2.5" />
			<path d="m7.5 10 2.5 2-2.5 2" />
			<path d="M12.5 14.5h4" />
		</svg>
	);
}

function CopyGlyph() {
	return (
		<svg {...menuGlyph}>
			<rect x="8.5" y="8.5" width="12" height="12" rx="2" />
			<path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
		</svg>
	);
}

function PathGlyph() {
	return (
		<svg {...menuGlyph}>
			<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
			<path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
		</svg>
	);
}

function ExternalGlyph() {
	return (
		<svg {...menuGlyph}>
			<path d="M14 4h6v6" />
			<path d="M20 4 11 13" />
			<path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
		</svg>
	);
}

function RevealGlyph() {
	return (
		<svg {...menuGlyph}>
			<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v3" />
			<path d="M3 6v12a2 2 0 0 0 2 2h6" />
			<circle cx="16.5" cy="16.5" r="3" />
			<path d="m21 21-2.4-2.4" />
		</svg>
	);
}

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
