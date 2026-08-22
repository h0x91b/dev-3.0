import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SharedArtifact } from "../../shared/types";
import { artifactAtVersion, latestArtifactVersion } from "../../shared/artifact-versions";
import { api } from "../rpc";
import { useT } from "../i18n";
import HelpSpot from "./HelpSpot";
import { toast } from "../toast";
import { composeArtifactDocument } from "../utils/artifactDocument";
import { isMac, isRemote } from "../utils/platform";
import ArtifactSearchBar, { type ArtifactSearchBarHandle } from "./ArtifactSearchBar";
import ArtifactVersionPicker from "./ArtifactVersionPicker";
import { registerOverlayLayer } from "../utils/overlay-layers";
import { downloadBase64, parseDataUrl } from "../utils/downloadBytes";

interface TaskArtifactViewerProps {
	artifacts: SharedArtifact[];
	initialIndex: number;
	onClose: () => void;
	taskId?: string;
	/**
	 * Overlay-only host: opened from a surface with no workspace pane to dock into
	 * (the archived task modal). Locks the overlay layout, drops the fullscreen
	 * toggle, and lets Escape close outright — un-fullscreening would render the
	 * docked panel into nothing.
	 */
	standalone?: boolean;
}

type ArtifactThemeMode = "follow" | "light" | "dark";

const ICON = "'JetBrainsMono Nerd Font Mono'";
const SEARCH_DEBOUNCE_MS = 150;

function currentTheme(): "dark" | "light" {
	return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

interface ArtifactAsset {
	name: string;
	mime: string;
	dataUrl: string;
}

const EXT_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
	"image/svg+xml": "svg",
};


/** Prefer the copied asset's original file name; otherwise derive one from alt + mime. */
function imageFileName(src: string, alt: string, mime: string, assets: ArtifactAsset[]): string {
	const known = assets.find((asset) => asset.dataUrl === src);
	if (known?.name) return known.name.split("/").pop() || known.name;
	const ext = EXT_BY_MIME[mime] || "png";
	const base = (alt || "image").trim().replace(/[^\w.-]+/g, "_").slice(0, 60) || "image";
	return /\.[a-z0-9]+$/i.test(base) ? base : `${base}.${ext}`;
}

export default function TaskArtifactViewer({ artifacts, initialIndex, onClose, taskId, standalone = false }: TaskArtifactViewerProps) {
	const t = useT();
	const [index, setIndex] = useState(() => Math.max(0, Math.min(artifacts.length - 1, initialIndex)));
	const [srcDoc, setSrcDoc] = useState<string | null>(null);
	const [error, setError] = useState(false);
	const [fullscreen, setFullscreen] = useState(standalone);
	const [downloading, setDownloading] = useState(false);
	const [themeMode, setThemeMode] = useState<ArtifactThemeMode>(() => currentTheme());
	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState("");
	// null = nothing searched yet (empty query) — the counter stays hidden.
	const [matches, setMatches] = useState<number | null>(null);
	const [activeIndex, setActiveIndex] = useState(-1);
	const frameRef = useRef<HTMLIFrameElement>(null);
	const viewerRef = useRef<HTMLElement>(null);
	const assetsRef = useRef<ArtifactAsset[]>([]);
	const searchBarRef = useRef<ArtifactSearchBarHandle | null>(null);
	const searchToggleRef = useRef<HTMLButtonElement>(null);
	// Guards against out-of-order replies from the iframe while typing fast.
	const searchTokenRef = useRef(0);
	const group = artifacts[index];
	// Keyed by artifact id rather than reset in an effect: an artifact the user
	// just opened has no pick, so it renders its newest version on the first
	// frame instead of flashing the previous artifact's version.
	const [pick, setPick] = useState<{ id: string; version: number } | null>(null);
	const selectedVersion = group && pick?.id === group.id ? pick.version : group ? latestArtifactVersion(group) : 1;
	// Memoized: an older version is a projected record, and a fresh object every
	// render would re-fetch its content forever.
	const current = useMemo(
		() => (group ? artifactAtVersion(group, selectedVersion) : undefined),
		[group, selectedVersion],
	);

	useEffect(() => {
		setPick(null);
		setIndex(Math.max(0, Math.min(artifacts.length - 1, initialIndex)));
	}, [artifacts.length, initialIndex]);

	useEffect(() => {
		if (!current) return;
		let cancelled = false;
		setSrcDoc(null);
		setError(false);
		assetsRef.current = [];
		// A different document invalidates the query's matches — start it clean
		// instead of showing a counter from the artifact the user just left.
		setQuery("");
		setMatches(null);
		setActiveIndex(-1);
		api.request.readArtifactContent({ artifact: current })
			.then((payload) => {
				if (cancelled) return;
				assetsRef.current = payload.assets;
				setSrcDoc(composeArtifactDocument(payload.html, payload.assets, t("artifactViewer.saveImage")));
			})
			.catch(() => { if (!cancelled) setError(true); });
		return () => { cancelled = true; };
	}, [current, t]);

	const postToFrame = useCallback((message: Record<string, unknown>) => {
		frameRef.current?.contentWindow?.postMessage(message, "*");
	}, []);

	const openSearch = useCallback(() => {
		setSearchOpen(true);
		// Already open → re-focus the input and select the query for retyping.
		searchBarRef.current?.focusInput();
	}, []);

	const closeSearch = useCallback(() => {
		setSearchOpen(false);
		setQuery("");
		setMatches(null);
		setActiveIndex(-1);
		postToFrame({ type: "dev3-artifact-find-clear" });
		// Hand focus back to the toggle, NOT to the iframe: focusing the frame moves
		// focus into the sandboxed document, whose key events never reach this window
		// — the next Escape (and ⌘F) would silently die.
		searchToggleRef.current?.focus();
	}, [postToFrame]);

	// The search runs inside the opaque-origin iframe; we only ship the query in and
	// read the counter back. Debounced so fast typing doesn't re-walk the document
	// per keystroke, tokened so a slow reply can't overwrite a newer one.
	useEffect(() => {
		if (!searchOpen) return;
		const timer = setTimeout(() => {
			if (!query) {
				searchTokenRef.current++;
				setMatches(null);
				setActiveIndex(-1);
				postToFrame({ type: "dev3-artifact-find-clear" });
				return;
			}
			postToFrame({ type: "dev3-artifact-find", query, token: ++searchTokenRef.current });
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [query, searchOpen, srcDoc, postToFrame]);

	const step = useCallback((delta: 1 | -1) => {
		if (!matches) return;
		postToFrame({ type: "dev3-artifact-find-step", delta, token: ++searchTokenRef.current });
	}, [matches, postToFrame]);

	useEffect(() => {
		function onMessage(event: MessageEvent) {
			if (event.source !== frameRef.current?.contentWindow) return;
			const data = event.data as { type?: string; src?: string; alt?: string; token?: number; matches?: number; index?: number } | null;
			if (!data) return;
			// Keyboard events inside the sandboxed iframe never reach this window, so
			// the artifact's own ⌘F handler asks us to open the bar.
			if (data.type === "dev3-artifact-find-open") { openSearch(); return; }
			if (data.type === "dev3-artifact-find-result") {
				if (data.token !== searchTokenRef.current) return;
				setMatches(typeof data.matches === "number" ? data.matches : 0);
				setActiveIndex(typeof data.index === "number" ? data.index : -1);
				return;
			}
			if (data.type !== "dev3-artifact-save-image" || typeof data.src !== "string") return;
			const parsed = parseDataUrl(data.src);
			if (!parsed) { toast.error(t("artifactViewer.imageSaveFailed"), { taskId }); return; }
			try {
				downloadBase64(parsed.base64, parsed.mime, imageFileName(data.src, data.alt ?? "", parsed.mime, assetsRef.current));
				toast.success(t("artifactViewer.imageSaved"), { taskId });
			} catch {
				toast.error(t("artifactViewer.imageSaveFailed"), { taskId });
			}
		}
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [t, taskId, openSearch]);

	const sendTheme = useCallback(() => {
		const theme = themeMode === "follow" ? currentTheme() : themeMode;
		frameRef.current?.contentWindow?.postMessage({ type: "dev3-artifact-theme", theme }, "*");
	}, [themeMode]);

	useEffect(() => {
		sendTheme();
	}, [sendTheme]);

	useEffect(() => {
		const observer = new MutationObserver(sendTheme);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		return () => observer.disconnect();
	}, [sendTheme]);

	useEffect(() => {
		if (!fullscreen) return;
		document.documentElement.setAttribute("data-artifact-viewer", "fullscreen");
		return () => document.documentElement.removeAttribute("data-artifact-viewer");
	}, [fullscreen]);

	const go = useCallback((delta: number) => {
		// Drop the version pick with the artifact: paging back to an artifact must
		// land on its newest version, never on the one that was open a moment ago —
		// a silently stale version is the confusion this whole feature removes.
		setPick(null);
		setIndex((value) => Math.max(0, Math.min(artifacts.length - 1, value + delta)));
	}, [artifacts.length]);

	// Capture phase + stopPropagation: the App-level Escape handler is a plain
	// window bubble listener registered at root mount, so it runs BEFORE any nested
	// surface's and would navigate out of the whole task workspace instead of just
	// closing this viewer. The open viewer owns the keys it handles (decision 181).
	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if (!fullscreen && !viewerRef.current?.contains(document.activeElement)) return;
			if (event.key === "Escape") {
				// Standalone hands the unwind to the overlay-layer stack instead.
				if (standalone) return;
				event.preventDefault();
				event.stopPropagation();
				// Escape unwinds one layer at a time: search → fullscreen → viewer.
				if (searchOpen) closeSearch();
				else if (fullscreen) setFullscreen(false);
				else onClose();
			} else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
				// While searching, arrows belong to the query caret, not to history.
				if (searchOpen) return;
				event.preventDefault();
				event.stopPropagation();
				go(event.key === "ArrowLeft" ? -1 : 1);
			}
		}
		window.addEventListener("keydown", onKey, { capture: true });
		return () => window.removeEventListener("keydown", onKey, { capture: true });
	}, [fullscreen, go, onClose, searchOpen, closeSearch, standalone]);

	// A standalone overlay sits on top of the archived task modal, whose
	// capture-phase Escape listener was registered first and stops immediate
	// propagation — a private listener here would never run and the modal
	// underneath would close instead. The layer stack fixes the unwind order.
	const dismissRef = useRef<() => void>(() => {});
	dismissRef.current = () => { if (searchOpen) closeSearch(); else onClose(); };
	useEffect(() => {
		if (!standalone) return;
		const el = viewerRef.current;
		if (!el) return;
		return registerOverlayLayer(el, () => dismissRef.current());
	// The section element identity is stable for the viewer's lifetime.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [standalone]);

	// ⌘F (Ctrl+F elsewhere) — find inside the artifact. Gated on focus being inside
	// this viewer so the browser's native find keeps working everywhere else in
	// remote mode. Focus sitting *inside* the iframe is handled by the injected
	// script, which posts `dev3-artifact-find-open` instead.
	useEffect(() => {
		function onFindShortcut(event: KeyboardEvent) {
			const combo = isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
			if (!combo || event.shiftKey || event.altKey || event.code !== "KeyF") return;
			if (!fullscreen && !viewerRef.current?.contains(document.activeElement)) return;
			event.preventDefault();
			event.stopPropagation();
			openSearch();
		}
		window.addEventListener("keydown", onFindShortcut, { capture: true });
		return () => window.removeEventListener("keydown", onFindShortcut, { capture: true });
	}, [fullscreen, openSearch]);

	if (!current) return null;

	const download = async () => {
		setDownloading(true);
		try {
			const payload = await api.request.readArtifactDownload({ artifact: current });
			downloadBase64(payload.base64, payload.mime, payload.fileName);
		} catch {
			toast.error(t("artifactViewer.downloadFailed"), { taskId });
		} finally {
			setDownloading(false);
		}
	};
	// Desktop hands the stored file to the OS browser, so relative assets keep
	// resolving. In remote mode that file lives on the host machine, so the tab gets
	// the already-composed document — opened synchronously, or the popup blocker eats it.
	const openInBrowser = () => {
		if (!isRemote()) {
			api.request.openArtifactInBrowser({ artifact: current })
				.catch(() => toast.error(t("artifactViewer.openInBrowserFailed"), { taskId }));
			return;
		}
		if (!srcDoc) return;
		const url = URL.createObjectURL(new Blob([srcDoc], { type: "text/html" }));
		if (!window.open(url, "_blank", "noopener,noreferrer")) {
			URL.revokeObjectURL(url);
			toast.error(t("artifactViewer.openInBrowserFailed"), { taskId });
			return;
		}
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	};
	const iconButton = "flex h-11 w-11 sm:h-8 sm:w-8 flex-shrink-0 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-elevated-hover hover:text-fg disabled:opacity-40";
	const themeName = themeMode === "follow"
		? t("artifactViewer.themeFollow")
		: themeMode === "light" ? t("artifactViewer.themeLight") : t("artifactViewer.themeDark");
	const themeLabel = t("artifactViewer.themeMode", { mode: themeName });
	const searchLabel = `${t("artifactViewer.search")} (${isMac() ? "⌘F" : "Ctrl+F"})`;
	const cycleTheme = () => setThemeMode((mode) => {
		if (mode === "follow") return currentTheme();
		return mode === currentTheme() ? (mode === "light" ? "dark" : "light") : "follow";
	});
	const themeIcon = themeMode === "follow" ? "◐" : themeMode === "light" ? "" : "";

	return (
		<section
			ref={viewerRef}
			data-testid="artifact-viewer"
			data-fullscreen={fullscreen ? "true" : "false"}
			aria-label={t("artifactViewer.regionLabel")}
			className={fullscreen
				? "fixed inset-0 z-[70] flex min-h-0 flex-col bg-base"
				: "flex h-full min-h-0 w-full flex-col bg-base border-l border-edge"}
		>
			<header className="flex flex-shrink-0 items-center gap-2 border-b border-edge bg-raised px-3 py-2">
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-medium text-fg">{current.title}</div>
					<div className="truncate text-micro text-fg-muted">{current.name}</div>
				</div>
				<HelpSpot topicId="viewer.artifact" />
				{group && (
					<ArtifactVersionPicker
						artifact={group}
						selected={selectedVersion}
						onSelect={(version) => setPick({ id: group.id, version })}
					/>
				)}
				{artifacts.length > 1 && (
					<>
						<button type="button" className={iconButton} disabled={index === 0} onClick={() => go(-1)} aria-label={t("artifactViewer.previous")}><span style={{ fontFamily: ICON }}></span></button>
						<span className="font-mono text-xs text-fg-3 tabular-nums">{index + 1} / {artifacts.length}</span>
						<button type="button" className={iconButton} disabled={index === artifacts.length - 1} onClick={() => go(1)} aria-label={t("artifactViewer.next")}><span style={{ fontFamily: ICON }}></span></button>
					</>
				)}
				<button
					type="button"
					ref={searchToggleRef}
					data-testid="artifact-viewer-search"
					className={`${iconButton} ${searchOpen ? "bg-accent/10 text-accent" : ""}`}
					onClick={() => (searchOpen ? closeSearch() : openSearch())}
					aria-label={searchLabel}
					aria-pressed={searchOpen}
					title={searchLabel}
				><span style={{ fontFamily: ICON }}>{"\uf002"}</span></button>
				<button
					type="button"
					data-testid="artifact-viewer-theme"
					className={`${iconButton} ${themeMode === "follow" ? "" : "bg-accent/10 text-accent"}`}
					onClick={cycleTheme}
					aria-label={themeLabel}
					title={themeLabel}
				><span style={{ fontFamily: ICON }}>{themeIcon}</span></button>
				<button type="button" className={iconButton} disabled={downloading} onClick={download} aria-label={current.bundlePath ? t("artifactViewer.downloadZip") : t("artifactViewer.downloadHtml")}><span style={{ fontFamily: ICON }}>{downloading ? "" : ""}</span></button>
				<button
					type="button"
					data-testid="artifact-viewer-open-browser"
					className={iconButton}
					disabled={!srcDoc}
					onClick={openInBrowser}
					aria-label={t("artifactViewer.openInBrowser")}
					title={t("artifactViewer.openInBrowser")}
				><span style={{ fontFamily: ICON }}>{""}</span></button>
				{!standalone && (
					<button type="button" data-testid="artifact-viewer-fullscreen" className={iconButton} onClick={() => setFullscreen((value) => !value)} aria-label={fullscreen ? t("artifactViewer.exitFullscreen") : t("artifactViewer.fullscreen")}><span style={{ fontFamily: ICON }}>{fullscreen ? "" : ""}</span></button>
				)}
				<button type="button" data-testid="artifact-viewer-close" className={iconButton} onClick={onClose} aria-label={t("artifactViewer.close")}><span style={{ fontFamily: ICON }}></span></button>
			</header>
			<div className="relative min-h-0 flex-1 bg-base">
				{searchOpen && srcDoc && !error && (
					<ArtifactSearchBar
						ref={searchBarRef}
						query={query}
						onQueryChange={setQuery}
						matches={matches}
						activeIndex={activeIndex}
						onStep={step}
						onClose={closeSearch}
					/>
				)}
				{error ? (
					<div className="flex h-full items-center justify-center px-6 text-center text-sm text-danger">{t("artifactViewer.loadFailed")}</div>
				) : srcDoc ? (
					<iframe
						ref={frameRef}
						title={current.title}
						sandbox="allow-scripts"
						srcDoc={srcDoc}
						onLoad={sendTheme}
						className="h-full w-full border-0 bg-base"
					/>
				) : (
					<div className="flex h-full items-center justify-center text-sm text-fg-3">{t("artifactViewer.loading")}</div>
				)}
			</div>
		</section>
	);
}
