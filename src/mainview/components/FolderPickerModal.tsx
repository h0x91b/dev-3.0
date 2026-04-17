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

function buildBreadcrumbs(path: string): Array<{ label: string; path: string; isRoot: boolean }> {
	if (!path) return [];
	const root = { label: "/", path: "/", isRoot: true };
	if (path === "/") return [root];
	const parts = path.split("/").filter(Boolean);
	const crumbs = [root];
	let acc = "";
	for (const part of parts) {
		acc += "/" + part;
		crumbs.push({ label: part, path: acc, isRoot: false });
	}
	return crumbs;
}

// ── Nerd Font glyphs ───────────────────────────────────────────────
// The app bundles JetBrainsMono Nerd Font Mono (see index.css @font-face).
// Codepoints come from https://www.nerdfonts.com/cheat-sheet — always use
// ES6 `\u{XXXXX}` for anything above U+FFFF (see CLAUDE.md font note).
const NF = {
	chevronRight: "\u{F0142}",   // nf-md-chevron_right
	chevronDown: "\u{F0140}",    // nf-md-chevron_down
	folderClosed: "\u{F024B}",   // nf-md-folder
	folderOpen: "\u{F0770}",     // nf-md-folder_open
	home: "\u{F02DC}",           // nf-md-home
	hardDisk: "\u{F02C9}",       // nf-md-harddisk
	loading: "\u{F0772}",        // nf-md-loading (spinner arc)
} as const;

const NF_FONT = "'JetBrainsMono Nerd Font Mono'";

interface GlyphProps {
	glyph: string;
	size?: string;          // e.g. "1rem", "1.125rem"
	color?: string;         // CSS color; falls back to currentColor
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
	return <Glyph glyph={expanded ? NF.chevronDown : NF.chevronRight} size="0.95rem" className="text-fg-muted" />;
}

function ChevronPlaceholder() {
	return <span aria-hidden="true" className="inline-block flex-shrink-0" style={{ width: "0.95rem", height: "0.95rem" }} />;
}

function FolderGlyph({ open }: { open: boolean }) {
	return <Glyph glyph={open ? NF.folderOpen : NF.folderClosed} size="1.05rem" color="#f6c653" />;
}

/**
 * Host component that listens for `openFolderPicker` requests and renders the
 * modal when one is active. Mounted once at the App root.
 */
export default function FolderPickerHost() {
	const [request, setRequest] = useState<FolderPickerRequest | null>(null);

	useEffect(() => {
		return subscribeFolderPicker(setRequest);
	}, []);

	const handleClose = useCallback((result: string | null) => {
		if (!request) return;
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
	// Re-mount the tree whenever the root changes so the async loader
	// starts from a clean cache.
	const [treeKey, setTreeKey] = useState(0);

	// Listings cache keyed by absolute path. Used to resolve `getItem` quickly
	// and to populate the manual path input with the current folder.
	const listingsRef = useRef<Map<string, FolderListing>>(new Map());

	// Load initial folder (from options.initialPath or home)
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
				setTreeKey((k) => k + 1);
			} catch (err) {
				if (cancelled) return;
				setListingError(String(err));
			}
		})();
		return () => { cancelled = true; };
	}, [options.initialPath]);

	// Escape to cancel
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
	const initialListing = currentRoot ? listingsRef.current.get(currentRoot) : null;
	const home = initialListing?.home ?? "";

	return (
		<div
			className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose(null);
			}}
			data-testid="folder-picker-backdrop"
		>
			<div className="bg-overlay border border-edge rounded-2xl shadow-[0_20px_60px_-15px_rgba(0,0,0,0.5)] w-[40rem] max-w-[92vw] flex flex-col overflow-hidden">
				{/* Header */}
				<div className="px-5 py-3.5 border-b border-edge flex items-center justify-between gap-3">
					<h2 className="text-fg text-base font-semibold truncate">
						{options.title ?? t("folderPicker.title")}
					</h2>
					<div className="flex items-center gap-1 flex-shrink-0">
						<button
							type="button"
							onClick={() => home && void navigateTo(home)}
							disabled={!home}
							className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md text-fg-2 hover:text-fg hover:bg-elevated transition-colors disabled:opacity-40"
							title={home || undefined}
						>
							<Glyph glyph={NF.home} size="0.95rem" />
							{t("folderPicker.home")}
						</button>
						<button
							type="button"
							onClick={() => void navigateTo("/")}
							className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
							title="/"
						>
							<Glyph glyph={NF.hardDisk} size="0.95rem" />
							{t("folderPicker.rootFs")}
						</button>
					</div>
				</div>

				{/* Breadcrumbs — no "/" before the root crumb, separators only BETWEEN crumbs. */}
				<div className="px-5 py-2 border-b border-edge flex items-center gap-1 overflow-x-auto text-xs">
					{breadcrumbs.map((crumb, idx) => (
						<div key={crumb.path} className="flex items-center gap-1 flex-shrink-0">
							{idx > 0 && <span className="text-fg-muted select-none">/</span>}
							<button
								type="button"
								onClick={() => void navigateTo(crumb.path)}
								className={`px-1.5 py-0.5 rounded hover:bg-elevated transition-colors ${
									idx === breadcrumbs.length - 1 ? "text-fg font-medium" : "text-fg-3 hover:text-fg"
								}`}
							>
								{crumb.label}
							</button>
						</div>
					))}
				</div>

				{/* Manual path input */}
				<form onSubmit={handleManualSubmit} className="px-5 py-2.5 border-b border-edge">
					<input
						type="text"
						value={manualPath}
						onChange={(e) => setManualPath(e.target.value)}
						onKeyDown={handleManualKeyDown}
						placeholder={t("folderPicker.pathPlaceholder")}
						spellCheck={false}
						autoCorrect="off"
						autoCapitalize="off"
						className="w-full px-3 py-2 bg-raised border border-edge rounded-lg text-fg text-[13px] font-mono outline-none focus:border-accent/50 transition-colors"
					/>
				</form>

				{/* Tree */}
				<div className="flex-1 min-h-[16rem] max-h-[26rem] overflow-auto px-2 py-2 bg-raised/50">
					{currentRoot ? (
						<FolderTree
							key={treeKey}
							rootPath={currentRoot}
							listingsRef={listingsRef}
							onSelect={setSelectedPath}
							onNavigate={(p) => void navigateTo(p)}
						/>
					) : (
						<div className="text-fg-3 text-sm px-3 py-2">{t("folderPicker.loading")}</div>
					)}
				</div>

				{/* Error */}
				{listingError && (
					<div className="px-5 py-2 bg-danger/10 text-danger text-xs border-t border-edge">
						{listingError}
					</div>
				)}

				{/* Footer */}
				<div className="px-5 py-3 border-t border-edge flex items-center gap-3">
					<div className="flex-1 min-w-0">
						<div className="text-fg-muted text-[10px] uppercase tracking-wide mb-0.5">
							{t("folderPicker.selected")}
						</div>
						<div className="text-fg text-xs font-mono truncate" title={selectedPath ?? ""}>
							{selectedPath || <span className="text-fg-muted">—</span>}
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
						onClick={() => selectedPath && onClose(selectedPath)}
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

interface FolderTreeProps {
	rootPath: string;
	listingsRef: React.MutableRefObject<Map<string, FolderListing>>;
	onSelect: (path: string) => void;
	onNavigate: (path: string) => void;
}

function FolderTree({ rootPath, listingsRef, onSelect, onNavigate }: FolderTreeProps) {
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
		const data = item.getItemData();
		onNavigate(data.path);
	}, [onNavigate]);

	return (
		<div {...tree.getContainerProps()} className="outline-none flex flex-col gap-0.5" role="tree">
			{tree.getItems().map((item) => {
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
						style={{ paddingLeft: `${0.5 + level * 0.85}rem` }}
						className={`w-full flex items-center gap-2 text-left pr-2 py-1.5 rounded-md text-[13px] transition-colors ${
							selected
								? "bg-accent/20 text-fg ring-1 ring-inset ring-accent/30"
								: "text-fg-2 hover:bg-elevated hover:text-fg"
						}`}
					>
						{data.isDir ? <ChevronGlyph expanded={expanded} /> : <ChevronPlaceholder />}
						<FolderGlyph open={expanded && data.isDir} />
						<span className="truncate">{data.name}</span>
						{loading && <Glyph glyph={NF.loading} size="0.85rem" className="text-fg-muted ml-1" spin />}
					</button>
				);
			})}
		</div>
	);
}
