import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import {
	asyncDataLoaderFeature,
	hotkeysCoreFeature,
	selectionFeature,
	type ItemInstance,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import type { FolderListing } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";
import {
	subscribeFolderPicker,
	type FolderPickerRequest,
} from "../folder-picker";

interface FolderNode {
	path: string;
	name: string;
	isDir: boolean;
	isRoot: boolean;
}

function basename(p: string): string {
	if (p === "/") return "/";
	const idx = p.lastIndexOf("/");
	if (idx === -1) return p;
	const tail = p.slice(idx + 1);
	return tail || p;
}

/** Build crumbs. The root "/" crumb has no text label — rendered with a drive
 *  icon instead, so we never get a "/ / Users" double-slash artefact. */
interface Crumb { label: string | null; path: string; isRoot: boolean }
function buildBreadcrumbs(path: string): Crumb[] {
	if (!path) return [];
	const root: Crumb = { label: null, path: "/", isRoot: true };
	if (path === "/") return [root];
	const parts = path.split("/").filter(Boolean);
	const crumbs: Crumb[] = [root];
	let acc = "";
	for (const part of parts) {
		acc += "/" + part;
		crumbs.push({ label: part, path: acc, isRoot: false });
	}
	return crumbs;
}

// ── Nerd Font glyphs ───────────────────────────────────────────────
// Using nf-fa-* (FontAwesome) codepoints across the board — they are 4-hex
// U+F0xx values present in every Nerd Font bundle. Earlier we tried some
// nf-md-* codepoints (harddisk U+F02C9 in particular) that rendered as the
// wrong glyph in the bundled JetBrainsMono NF build; sticking to nf-fa
// avoids that kind of surprise.
const NF = {
	chevronRight: "\uF054",   // nf-fa-chevron_right
	chevronDown: "\uF078",    // nf-fa-chevron_down
	folderClosed: "\uF07B",   // nf-fa-folder
	folderOpen: "\uF07C",     // nf-fa-folder_open
	home: "\uF015",           // nf-fa-home
	desktop: "\uF108",        // nf-fa-desktop
	documents: "\uF0F6",      // nf-fa-file_text_o
	downloads: "\uF019",      // nf-fa-download
	hardDrive: "\uF0A0",      // nf-fa-hdd_o
	clock: "\uF017",          // nf-fa-clock_o
	filter: "\uF0B0",         // nf-fa-filter
	close: "\uF00D",          // nf-fa-times
	loading: "\uF1CE",        // nf-fa-circle_o_notch (spinning)
} as const;

const NF_FONT = "'JetBrainsMono Nerd Font Mono'";

interface GlyphProps {
	glyph: string;
	size?: string;
	color?: string;
	className?: string;
	title?: string;
	spin?: boolean;
}

function Glyph({ glyph, size = "1rem", color, className = "", title, spin }: GlyphProps) {
	return (
		<span
			className={`inline-flex items-center justify-center leading-none flex-shrink-0 ${spin ? "animate-spin" : ""} ${className}`}
			style={{ fontFamily: NF_FONT, fontSize: size, width: size, height: size, color }}
			aria-hidden={title ? undefined : true}
			title={title}
		>
			{glyph}
		</span>
	);
}

function ChevronGlyph({ expanded }: { expanded: boolean }) {
	return <Glyph glyph={expanded ? NF.chevronDown : NF.chevronRight} size="0.75rem" className="text-fg-muted" />;
}

function ChevronPlaceholder() {
	return <span aria-hidden="true" className="inline-block flex-shrink-0" style={{ width: "0.75rem", height: "0.75rem" }} />;
}

function FolderGlyph({ open }: { open: boolean }) {
	return <Glyph glyph={open ? NF.folderOpen : NF.folderClosed} size="1rem" color="#f6c653" />;
}

// ── Recent paths (localStorage) ────────────────────────────────────
const RECENT_KEY = "dev3-folder-picker-recent";
const RECENT_LIMIT = 5;

function loadRecent(): string[] {
	try {
		const raw = localStorage.getItem(RECENT_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((x): x is string => typeof x === "string").slice(0, RECENT_LIMIT);
	} catch {
		return [];
	}
}

function pushRecent(path: string): string[] {
	try {
		const current = loadRecent();
		const next = [path, ...current.filter((p) => p !== path)].slice(0, RECENT_LIMIT);
		localStorage.setItem(RECENT_KEY, JSON.stringify(next));
		return next;
	} catch {
		return loadRecent();
	}
}

/** Collapse $HOME prefix to ~ for display. */
function displayPath(full: string, home: string): string {
	if (home && full === home) return "~";
	if (home && full.startsWith(home + "/")) return "~" + full.slice(home.length);
	return full;
}

// ──────────────────────────────────────────────────────────────────────
// Host — listens for picker requests, mounts the modal, persists recents
// ──────────────────────────────────────────────────────────────────────

export default function FolderPickerHost() {
	const [request, setRequest] = useState<FolderPickerRequest | null>(null);

	useEffect(() => {
		return subscribeFolderPicker(setRequest);
	}, []);

	const handleClose = useCallback((result: string | null) => {
		if (!request) return;
		if (result) pushRecent(result);
		request.resolve(result);
		setRequest(null);
	}, [request]);

	if (!request) return null;

	return (
		<FolderPickerModal
			key={request.options.initialPath ?? "__root__"}
			options={request.options}
			onClose={handleClose}
		/>
	);
}

interface ModalProps {
	options: FolderPickerRequest["options"];
	onClose: (path: string | null) => void;
}

function FolderPickerModal({ options, onClose }: ModalProps) {
	const t = useT();
	const [currentRoot, setCurrentRoot] = useState<string | null>(null);
	const [manualPath, setManualPath] = useState("");
	const [listingError, setListingError] = useState<string | null>(null);
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [filterText, setFilterText] = useState("");
	const [recentPaths, setRecentPaths] = useState<string[]>(() => loadRecent());
	const [home, setHome] = useState<string>("");
	const [homeEntries, setHomeEntries] = useState<Set<string>>(new Set());
	const [treeKey, setTreeKey] = useState(0);

	const listingsRef = useRef<Map<string, FolderListing>>(new Map());

	// Initial load: open the picker at `initialPath` (or home) AND fetch the
	// home listing in parallel so we can populate sidebar shortcuts.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const initial = await api.request.listDirectory({ path: options.initialPath ?? null });
				if (cancelled) return;
				listingsRef.current.set(initial.path, initial);
				setCurrentRoot(initial.path);
				setSelectedPath(initial.path);
				setManualPath(initial.path);
				setListingError(initial.error ?? null);
				setHome(initial.home);
				setTreeKey((k) => k + 1);

				// If the initial path IS home, reuse it; otherwise fetch home too.
				if (initial.path === initial.home) {
					setHomeEntries(new Set(initial.entries.filter((e) => e.isDir).map((e) => e.name)));
				} else {
					const homeListing = await api.request.listDirectory({ path: initial.home });
					if (cancelled) return;
					listingsRef.current.set(homeListing.path, homeListing);
					setHomeEntries(new Set(homeListing.entries.filter((e) => e.isDir).map((e) => e.name)));
				}
			} catch (err) {
				if (cancelled) return;
				setListingError(String(err));
			}
		})();
		return () => { cancelled = true; };
	}, [options.initialPath]);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose(null);
			}
		}
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);

	const navigateTo = useCallback(async (path: string) => {
		setListingError(null);
		try {
			const listing = await api.request.listDirectory({ path });
			listingsRef.current.set(listing.path, listing);
			setCurrentRoot(listing.path);
			setSelectedPath(listing.path);
			setManualPath(listing.path);
			setListingError(listing.error ?? null);
			setFilterText("");
			setTreeKey((k) => k + 1);
		} catch (err) {
			setListingError(String(err));
		}
	}, []);

	const handleManualSubmit = useCallback((e: FormEvent) => {
		e.preventDefault();
		if (!manualPath.trim()) return;
		void navigateTo(manualPath.trim());
	}, [manualPath, navigateTo]);

	const handleManualKeyDown = useCallback((e: ReactKeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			if (!manualPath.trim()) return;
			void navigateTo(manualPath.trim());
		}
	}, [manualPath, navigateTo]);

	const breadcrumbs = useMemo(() => buildBreadcrumbs(currentRoot ?? ""), [currentRoot]);

	const handleSelect = useCallback(() => {
		if (!selectedPath) return;
		setRecentPaths(pushRecent(selectedPath));
		onClose(selectedPath);
	}, [selectedPath, onClose]);

	// Build sidebar shortcuts — only those that actually exist under $HOME.
	const quickPlaces = useMemo(() => {
		const items: Array<{ label: string; path: string; glyph: string }> = [];
		if (home) {
			items.push({ label: t("folderPicker.home"), path: home, glyph: NF.home });
			if (homeEntries.has("Desktop")) items.push({ label: "Desktop", path: `${home}/Desktop`, glyph: NF.desktop });
			if (homeEntries.has("Documents")) items.push({ label: "Documents", path: `${home}/Documents`, glyph: NF.documents });
			if (homeEntries.has("Downloads")) items.push({ label: "Downloads", path: `${home}/Downloads`, glyph: NF.downloads });
		}
		items.push({ label: t("folderPicker.rootLabel"), path: "/", glyph: NF.hardDrive });
		return items;
	}, [home, homeEntries, t]);

	return (
		<div
			className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose(null);
			}}
			data-testid="folder-picker-backdrop"
		>
			<div className="bg-overlay border border-edge rounded-2xl shadow-[0_20px_60px_-15px_rgba(0,0,0,0.55)] w-[56rem] max-w-[94vw] flex flex-col overflow-hidden">
				{/* Header */}
				<div className="px-5 py-3 border-b border-edge flex items-center justify-between gap-3">
					<h2 className="text-fg text-base font-semibold truncate">
						{options.title ?? t("folderPicker.title")}
					</h2>
					<button
						type="button"
						onClick={() => onClose(null)}
						aria-label={t("folderPicker.cancel")}
						className="inline-flex items-center justify-center w-7 h-7 rounded-md text-fg-3 hover:text-fg hover:bg-elevated transition-colors"
					>
						<Glyph glyph={NF.close} size="0.95rem" />
					</button>
				</div>

				{/* Body: sidebar + main */}
				<div className="flex flex-1 min-h-[24rem] max-h-[min(36rem,80vh)]">
					{/* Sidebar */}
					<aside data-testid="folder-picker-sidebar" className="w-[11.5rem] flex-shrink-0 border-r border-edge bg-raised/40 py-2 overflow-y-auto flex flex-col gap-3">
						<SidebarSection title={t("folderPicker.sectionPlaces")}>
							{quickPlaces.map((place) => (
								<SidebarItem
									key={place.path}
									glyph={place.glyph}
									label={place.label}
									path={place.path}
									active={currentRoot === place.path}
									onClick={() => void navigateTo(place.path)}
								/>
							))}
						</SidebarSection>
						{recentPaths.length > 0 && (
							<SidebarSection title={t("folderPicker.sectionRecent")}>
								{recentPaths.map((p) => (
									<SidebarItem
										key={p}
										glyph={NF.clock}
										label={basename(p)}
										subLabel={displayPath(p, home)}
										path={p}
										active={currentRoot === p}
										onClick={() => void navigateTo(p)}
									/>
								))}
							</SidebarSection>
						)}
					</aside>

					{/* Main */}
					<main className="flex-1 min-w-0 flex flex-col">
						{/* Breadcrumbs */}
						<div className="px-4 py-2 border-b border-edge flex items-center gap-0.5 overflow-x-auto text-xs flex-shrink-0">
							{breadcrumbs.map((crumb, idx) => (
								<div key={crumb.path} className="flex items-center gap-0.5 flex-shrink-0">
									{idx > 0 && <span className="text-fg-muted px-0.5 select-none">/</span>}
									<button
										type="button"
										onClick={() => void navigateTo(crumb.path)}
										title={crumb.path}
										className={`px-1.5 py-0.5 rounded inline-flex items-center gap-1 hover:bg-elevated transition-colors ${
											idx === breadcrumbs.length - 1 ? "text-fg font-medium" : "text-fg-3 hover:text-fg"
										}`}
									>
										{crumb.isRoot ? <Glyph glyph={NF.hardDrive} size="0.85rem" /> : crumb.label}
									</button>
								</div>
							))}
						</div>

						{/* Path input + filter */}
						<div className="px-4 py-2 border-b border-edge grid grid-cols-[1fr_14rem] gap-2 flex-shrink-0">
							<form onSubmit={handleManualSubmit}>
								<input
									type="text"
									value={manualPath}
									onChange={(e) => setManualPath(e.target.value)}
									onKeyDown={handleManualKeyDown}
									placeholder={t("folderPicker.pathPlaceholder")}
									spellCheck={false}
									autoCorrect="off"
									autoCapitalize="off"
									className="w-full px-3 py-1.5 bg-raised border border-edge rounded-lg text-fg text-[13px] font-mono outline-none focus:border-accent/50 transition-colors"
								/>
							</form>
							<label className="relative flex items-center">
								<span className="absolute left-2.5 pointer-events-none">
									<Glyph glyph={NF.filter} size="0.8rem" className="text-fg-muted" />
								</span>
								<input
									type="text"
									value={filterText}
									onChange={(e) => setFilterText(e.target.value)}
									placeholder={t("folderPicker.filterPlaceholder")}
									spellCheck={false}
									autoCorrect="off"
									autoCapitalize="off"
									className="w-full pl-7 pr-2 py-1.5 bg-raised border border-edge rounded-lg text-fg text-[13px] outline-none focus:border-accent/50 transition-colors"
								/>
							</label>
						</div>

						{/* Tree */}
						<div className="flex-1 overflow-auto px-1 py-1 bg-raised/30">
							{currentRoot ? (
								<FolderTree
									key={treeKey}
									rootPath={currentRoot}
									listingsRef={listingsRef}
									filterText={filterText}
									onSelect={setSelectedPath}
									onNavigate={(p) => void navigateTo(p)}
								/>
							) : (
								<div className="text-fg-3 text-sm px-3 py-2">{t("folderPicker.loading")}</div>
							)}
						</div>

						{listingError && (
							<div className="px-4 py-1.5 bg-danger/10 text-danger text-xs border-t border-edge flex-shrink-0">
								{listingError}
							</div>
						)}
					</main>
				</div>

				{/* Footer */}
				<div className="px-5 py-3 border-t border-edge flex items-center gap-3">
					<div className="flex-1 min-w-0">
						<div className="text-fg-muted text-[10px] uppercase tracking-wide mb-0.5">
							{t("folderPicker.selected")}
						</div>
						<div className="text-fg text-xs font-mono truncate" title={selectedPath ?? ""}>
							{selectedPath ? displayPath(selectedPath, home) : <span className="text-fg-muted">—</span>}
						</div>
					</div>
					<button
						type="button"
						onClick={() => onClose(null)}
						className="px-4 py-1.5 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-elevated transition-colors flex-shrink-0"
					>
						{t("folderPicker.cancel")}
					</button>
					<button
						type="button"
						onClick={handleSelect}
						disabled={!selectedPath}
						className="px-4 py-1.5 text-sm font-semibold rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
					>
						{t("folderPicker.select")}
					</button>
				</div>
			</div>
		</div>
	);
}

// ── Sidebar ────────────────────────────────────────────────────────

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div>
			<div className="px-3 pb-1 text-fg-muted text-[10px] uppercase tracking-wider font-medium">
				{title}
			</div>
			<div className="flex flex-col">{children}</div>
		</div>
	);
}

interface SidebarItemProps {
	glyph: string;
	label: string;
	subLabel?: string;
	path: string;
	active: boolean;
	onClick: () => void;
}

function SidebarItem({ glyph, label, subLabel, path, active, onClick }: SidebarItemProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={subLabel ?? path}
			className={`w-full flex items-center gap-2 pl-3 pr-2 py-1.5 text-left text-[13px] transition-colors border-l-2 ${
				active
					? "bg-accent/15 text-fg border-accent font-medium"
					: "text-fg-2 hover:bg-elevated hover:text-fg border-transparent"
			}`}
		>
			<Glyph glyph={glyph} size="0.9rem" className={active ? "text-accent" : "text-fg-3"} />
			<span className="truncate flex-1 min-w-0">{label}</span>
		</button>
	);
}

// ── Tree ───────────────────────────────────────────────────────────

interface FolderTreeProps {
	rootPath: string;
	listingsRef: React.MutableRefObject<Map<string, FolderListing>>;
	filterText: string;
	onSelect: (path: string) => void;
	onNavigate: (path: string) => void;
}

function FolderTree({ rootPath, listingsRef, filterText, onSelect, onNavigate }: FolderTreeProps) {
	const dataLoader = useMemo(() => ({
		async getItem(itemId: string): Promise<FolderNode> {
			if (itemId === rootPath) {
				return { path: rootPath, name: basename(rootPath), isDir: true, isRoot: true };
			}
			return { path: itemId, name: basename(itemId), isDir: true, isRoot: false };
		},
		async getChildrenWithData(parentId: string): Promise<Array<{ id: string; data: FolderNode }>> {
			const cached = listingsRef.current.get(parentId);
			const listing = cached ?? await api.request.listDirectory({ path: parentId });
			if (!cached) listingsRef.current.set(listing.path, listing);
			return listing.entries
				.filter((e) => e.isDir)
				.map((e) => ({
					id: e.path,
					data: { path: e.path, name: e.name, isDir: true, isRoot: false },
				}));
		},
	}), [rootPath, listingsRef]);

	const tree = useTree<FolderNode>({
		rootItemId: rootPath,
		getItemName: (item) => item.getItemData().name,
		isItemFolder: (item) => item.getItemData().isDir,
		dataLoader,
		initialState: { expandedItems: [rootPath] },
		features: [asyncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
	});

	const handleDoubleClick = useCallback((item: ItemInstance<FolderNode>) => {
		onNavigate(item.getItemData().path);
	}, [onNavigate]);

	const allItems = tree.getItems();

	// Filter: keep items whose name matches, plus all their ancestors so the
	// hierarchy stays intact. Filtering only applies to already-loaded items
	// (we don't greedy-expand the whole tree — that would be a storm of IPC).
	const filter = filterText.trim().toLowerCase();
	const visibleItems = useMemo(() => {
		if (!filter) return allItems;
		const byId = new Map(allItems.map((it) => [it.getId(), it] as const));
		const keep = new Set<string>();
		for (const item of allItems) {
			if (item.getItemData().name.toLowerCase().includes(filter)) {
				keep.add(item.getId());
				let parentId: string | null = item.getItemMeta().parentId;
				while (parentId) {
					if (keep.has(parentId)) break;
					keep.add(parentId);
					const parent = byId.get(parentId);
					parentId = parent ? parent.getItemMeta().parentId : null;
				}
			}
		}
		return allItems.filter((it) => keep.has(it.getId()));
	}, [allItems, filter]);

	const empty = visibleItems.length === 0;

	return (
		<div {...tree.getContainerProps()} className="outline-none flex flex-col" role="tree">
			{empty && filter && (
				<div className="px-3 py-4 text-fg-muted text-xs text-center">
					No folders match &ldquo;{filterText}&rdquo; in the currently loaded tree.
				</div>
			)}
			{visibleItems.map((item) => {
				const data = item.getItemData();
				const level = item.getItemMeta().level;
				const expanded = item.isExpanded();
				const selected = item.isSelected();
				const loading = item.isLoading?.() ?? false;
				const itemProps = item.getProps();
				return (
					<button
						key={item.getId()}
						{...itemProps}
						type="button"
						onClick={(e) => {
							itemProps.onClick?.(e);
							onSelect(data.path);
						}}
						onDoubleClick={() => handleDoubleClick(item)}
						style={{ paddingLeft: `${0.25 + level * 0.9}rem` }}
						className={`w-full flex items-center gap-2 text-left pr-2 py-1 text-[13px] transition-colors border-l-2 ${
							selected
								? "bg-accent/10 border-accent text-fg font-medium"
								: "text-fg-2 border-transparent hover:bg-elevated hover:text-fg"
						}`}
					>
						{data.isDir ? <ChevronGlyph expanded={expanded} /> : <ChevronPlaceholder />}
						<FolderGlyph open={expanded && data.isDir} />
						<span className="truncate">{data.name}</span>
						{loading && <Glyph glyph={NF.loading} size="0.8rem" className="text-fg-muted ml-1" spin />}
					</button>
				);
			})}
		</div>
	);
}
