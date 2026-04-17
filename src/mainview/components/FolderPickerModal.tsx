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

// ── Inline SVG icons (Lucide-style, 20×20 viewBox). Using SVG instead of
//    Nerd Font glyphs so icons render consistently across all transports
//    (desktop + remote browser) without depending on custom font loading.
// ──────────────────────────────────────────────────────────────────────
function ChevronIcon({ expanded }: { expanded: boolean }) {
	return (
		<svg
			viewBox="0 0 20 20"
			width="14"
			height="14"
			className="flex-shrink-0 text-fg-muted"
			style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 120ms" }}
			aria-hidden="true"
		>
			<path d="M7 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function ChevronPlaceholder() {
	return <span aria-hidden="true" className="inline-block w-[14px] flex-shrink-0" />;
}

function FolderIcon({ open }: { open: boolean }) {
	return (
		<svg viewBox="0 0 20 20" width="16" height="16" className="flex-shrink-0" aria-hidden="true">
			{open ? (
				<path
					d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.6a1.5 1.5 0 0 1 1.06.44l.94.94a1.5 1.5 0 0 0 1.06.44H16a1.5 1.5 0 0 1 1.5 1.5v.37H4.6a1.5 1.5 0 0 0-1.45 1.1L2 14V5.5Zm1.6 3.87a.7.7 0 0 0-.68.51l-1.15 4.4A1 1 0 0 0 3.24 15.5h12.5a1 1 0 0 0 .97-.73l1.22-4.41a.7.7 0 0 0-.68-.89H4.1Z"
					fill="#f6c653"
					stroke="#c48f1d"
					strokeWidth="0.4"
				/>
			) : (
				<path
					d="M4 4a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 4 16h12a1.5 1.5 0 0 0 1.5-1.5V7.5A1.5 1.5 0 0 0 16 6H10.4a.5.5 0 0 1-.36-.15l-.98-.98A1.5 1.5 0 0 0 8 4.44L7.6 4H4Z"
					fill="#f6c653"
					stroke="#c48f1d"
					strokeWidth="0.4"
				/>
			)}
		</svg>
	);
}

function HomeIcon() {
	return (
		<svg viewBox="0 0 20 20" width="14" height="14" className="flex-shrink-0" aria-hidden="true">
			<path d="M10 3.2 3 8.5V16a1 1 0 0 0 1 1h3.5v-4.5h5V17H16a1 1 0 0 0 1-1V8.5L10 3.2Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
		</svg>
	);
}

function HardDriveIcon() {
	return (
		<svg viewBox="0 0 20 20" width="14" height="14" className="flex-shrink-0" aria-hidden="true">
			<path d="M3 12h14M3 12 5 6h10l2 6M3 12v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
			<circle cx="14" cy="14.5" r="0.9" fill="currentColor" />
		</svg>
	);
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
							<HomeIcon />
							{t("folderPicker.home")}
						</button>
						<button
							type="button"
							onClick={() => void navigateTo("/")}
							className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
							title="/"
						>
							<HardDriveIcon />
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
						{data.isDir ? <ChevronIcon expanded={expanded} /> : <ChevronPlaceholder />}
						<FolderIcon open={expanded && data.isDir} />
						<span className="truncate">{data.name}</span>
						{loading && (
							<span className="ml-1 inline-block w-2.5 h-2.5 rounded-full bg-accent/50 animate-pulse flex-shrink-0" aria-label="loading" />
						)}
					</button>
				);
			})}
		</div>
	);
}
