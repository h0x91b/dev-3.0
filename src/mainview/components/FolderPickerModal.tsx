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

function buildBreadcrumbs(path: string): Array<{ label: string; path: string }> {
	if (!path) return [];
	if (path === "/") return [{ label: "/", path: "/" }];
	const parts = path.split("/").filter(Boolean);
	const crumbs: Array<{ label: string; path: string }> = [{ label: "/", path: "/" }];
	let acc = "";
	for (const part of parts) {
		acc += "/" + part;
		crumbs.push({ label: part, path: acc });
	}
	return crumbs;
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
			<div className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[40rem] max-w-[92vw] flex flex-col overflow-hidden">
				{/* Header */}
				<div className="px-5 py-4 border-b border-edge flex items-center justify-between">
					<h2 className="text-fg text-base font-semibold">
						{options.title ?? t("folderPicker.title")}
					</h2>
					<div className="flex items-center gap-1">
						<button
							type="button"
							onClick={() => home && void navigateTo(home)}
							disabled={!home}
							className="px-2.5 py-1 text-xs rounded-md text-fg-3 hover:text-fg hover:bg-elevated transition-colors disabled:opacity-40"
							title={home}
						>
							{t("folderPicker.home")}
						</button>
						<button
							type="button"
							onClick={() => void navigateTo("/")}
							className="px-2.5 py-1 text-xs rounded-md text-fg-3 hover:text-fg hover:bg-elevated transition-colors"
						>
							{t("folderPicker.rootFs")}
						</button>
					</div>
				</div>

				{/* Breadcrumbs */}
				<div className="px-5 py-2 border-b border-edge flex items-center gap-1 overflow-x-auto text-xs font-mono">
					{breadcrumbs.map((crumb, idx) => (
						<div key={crumb.path} className="flex items-center gap-1 flex-shrink-0">
							{idx > 0 && <span className="text-fg-muted">/</span>}
							<button
								type="button"
								onClick={() => void navigateTo(crumb.path)}
								className="px-1.5 py-0.5 rounded hover:bg-elevated text-fg-2 hover:text-fg transition-colors"
							>
								{crumb.label}
							</button>
						</div>
					))}
				</div>

				{/* Manual path input */}
				<form onSubmit={handleManualSubmit} className="px-5 py-2 border-b border-edge">
					<input
						type="text"
						value={manualPath}
						onChange={(e) => setManualPath(e.target.value)}
						onKeyDown={handleManualKeyDown}
						placeholder={t("folderPicker.pathPlaceholder")}
						spellCheck={false}
						autoCorrect="off"
						autoCapitalize="off"
						className="w-full px-3 py-2 bg-raised border border-edge rounded-lg text-fg text-sm font-mono outline-none focus:border-accent/50 transition-colors"
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
		<div {...tree.getContainerProps()} className="outline-none" role="tree">
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
						style={{ paddingLeft: `${0.5 + level * 1}rem` }}
						className={`w-full flex items-center gap-1.5 text-left px-2 py-1 rounded-md text-sm transition-colors ${
							selected
								? "bg-accent/20 text-fg"
								: "text-fg-2 hover:bg-elevated hover:text-fg"
						}`}
					>
						<span
							className="inline-flex items-center justify-center w-4 h-4 text-fg-muted flex-shrink-0"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
						>
							{data.isDir ? (expanded ? "\u{F0374}" : "\u{F0370}") : "\u{F15B}"}
						</span>
						<span
							className="inline-flex items-center justify-center w-4 h-4 flex-shrink-0"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'", color: data.isDir ? "#f9c74f" : "var(--fg-3)" }}
						>
							{data.isDir ? (expanded ? "\u{F115}" : "\u{F114}") : "\u{F15B}"}
						</span>
						<span className="truncate font-mono">{data.name}</span>
						{loading && <span className="text-fg-muted text-xs">…</span>}
					</button>
				);
			})}
		</div>
	);
}
