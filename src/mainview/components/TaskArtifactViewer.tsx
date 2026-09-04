import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SharedArtifact, TaskStatus } from "../../shared/types";
import { TERMINAL_STATUSES } from "../../shared/types";
import { artifactAtVersion, latestArtifactVersion } from "../../shared/artifact-versions";
import { api } from "../rpc";
import { useT } from "../i18n";
import HelpSpot from "./HelpSpot";
import { toast } from "../toast";
import { composeArtifactDocument } from "../utils/artifactDocument";
import type { ArtifactDraft } from "../utils/artifactBridge";
import { isMac, isRemote } from "../utils/platform";
import ArtifactSearchBar, { type ArtifactSearchBarHandle } from "./ArtifactSearchBar";
import ArtifactVersionPicker from "./ArtifactVersionPicker";
import ArtifactFrame, { type ArtifactFrameHandle } from "./ArtifactFrame";
import { artifactTransport } from "../utils/artifactTransport";
import { registerOverlayLayer } from "../utils/overlay-layers";
import { downloadBase64, parseDataUrl } from "../utils/downloadBytes";

interface TaskArtifactViewerProps {
	artifacts: SharedArtifact[];
	initialIndex: number;
	onClose: () => void;
	/** Required: an artifact with no addressable task has nowhere to send. */
	taskId: string;
	/** Status of the owning task, when the host knows it. Terminal → no send channel. */
	taskStatus?: TaskStatus;
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

/**
 * Windowed lightbox for artifacts an agent surfaced via `dev3 show-artifact` —
 * the exact container `TaskImageViewer` uses for images: a centred modal card
 * filling ~90% of the viewport over a scrim, with a fullscreen toggle for
 * edge-to-edge viewing. It is deliberately NOT a docked, drag-resizable panel:
 * resizing relaid out the iframe and refit the terminal on every pointer move
 * and could wedge the whole UI (see
 * `decisions/2026/09/05/artifact-popup-replaces-resizable-panel.md`).
 *
 * While open it marks <html data-artifact-viewer="open">, which hides the
 * ghostty WebGL terminal behind it (index.css) — in WKWebView that canvas is
 * promoted to a hardware overlay plane painting ABOVE any DOM scrim.
 */
export default function TaskArtifactViewer({ artifacts, initialIndex, onClose, taskId, taskStatus }: TaskArtifactViewerProps) {
	const t = useT();
	const [index, setIndex] = useState(() => Math.max(0, Math.min(artifacts.length - 1, initialIndex)));
	const [srcDoc, setSrcDoc] = useState<string | null>(null);
	const [error, setError] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);
	const [downloading, setDownloading] = useState(false);
	const [themeMode, setThemeMode] = useState<ArtifactThemeMode>(() => currentTheme());
	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState("");
	// null = nothing searched yet (empty query) — the counter stays hidden.
	const [matches, setMatches] = useState<number | null>(null);
	const [activeIndex, setActiveIndex] = useState(-1);
	const frameRef = useRef<ArtifactFrameHandle>(null);
	const viewerRef = useRef<HTMLDivElement>(null);
	const assetsRef = useRef<ArtifactAsset[]>([]);
	const searchBarRef = useRef<ArtifactSearchBarHandle | null>(null);
	const searchToggleRef = useRef<HTMLButtonElement>(null);
	// Guards against out-of-order replies from the document while typing fast.
	const searchTokenRef = useRef(0);
	// Fixed for this window: which host renders the artifact, and therefore which
	// channel the composed document must carry. See utils/artifactTransport.ts.
	const [transport] = useState(artifactTransport);
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

	// Keyed on the array identity, not its length: a republish hands over a fresh
	// list of the same size whose last row is the artifact that was just published,
	// and the viewer has to land on it rather than sit on whatever index it held.
	useEffect(() => {
		setPick(null);
		setIndex(Math.max(0, Math.min(artifacts.length - 1, initialIndex)));
	}, [artifacts, initialIndex]);

	// What the user typed into a version's form and never sent. Held here rather
	// than in the artifact because the frame is opaque-origin — every storage API
	// inside it throws — and because it has to outlive the document it came from.
	const [draft, setDraft] = useState<{ artifactId: string; version: number; draft: ArtifactDraft } | null>(null);
	const [draftDismissed, setDraftDismissed] = useState(false);
	const pendingDraft = group && draft?.artifactId === group.id ? draft : null;
	const draftIsHere = pendingDraft?.version === selectedVersion;

	// Compose-time half of `window.dev3.canSendToAgent`. An older version's form is
	// inert on purpose: it asks a question the newest report has already replaced.
	// The exception is the version the user is part-way through answering — that
	// question is the one in front of them, and refusing to send it would only
	// trade a wiped form for a dead button. The runtime half (is this document
	// actually inside the viewer's frame) lives in the injected bridge, and whether
	// an agent is alive is only knowable at send time — that arrives as a toast.
	const canSendToAgent = Boolean(group)
		&& (selectedVersion === latestArtifactVersion(group) || Boolean(draftIsHere))
		&& !(taskStatus && TERMINAL_STATUSES.includes(taskStatus));

	// Deliberately NOT a dependency of the compose effect below: re-composing the
	// document to change this flag would unmount the iframe and destroy the very
	// input this feature exists to keep. The frame is told instead.
	const canSendRef = useRef(canSendToAgent);
	canSendRef.current = canSendToAgent;

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
				setSrcDoc(composeArtifactDocument(payload.html, payload.assets, t("artifactViewer.saveImage"), canSendRef.current, transport));
			})
			.catch(() => { if (!cancelled) setError(true); });
		return () => { cancelled = true; };
	}, [current, t, transport]);

	const postToFrame = useCallback((message: Record<string, unknown>) => {
		frameRef.current?.post(message);
	}, []);

	// The frame keeps its own copy of the capability so it never has to be rebuilt
	// to learn the answer changed.
	useEffect(() => {
		postToFrame({ type: "dev3-artifact-can-send", canSend: canSendToAgent });
	}, [canSendToAgent, srcDoc, postToFrame]);

	// Put the unsent answer back the moment its own version is on screen again.
	const restoreDraft = useCallback(() => {
		if (!draftIsHere || !pendingDraft) return;
		postToFrame({ type: "dev3-artifact-draft-restore", draft: pendingDraft.draft });
	}, [draftIsHere, pendingDraft, postToFrame]);

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

	// Read at send time, not captured when the listener registers: the user may have
	// paged to another artifact between opening the form and clicking send.
	const currentRef = useRef({ title: "", version: 1, versionCount: 1, artifactId: "" });
	currentRef.current = {
		title: current?.title ?? "",
		version: selectedVersion,
		versionCount: group ? latestArtifactVersion(group) : 1,
		artifactId: group?.id ?? "",
	};

	const onFrameMessage = useCallback((incoming: unknown) => {
		{
			const data = incoming as { type?: string; src?: string; alt?: string; token?: number; matches?: number; index?: number; id?: number; text?: string; fields?: ArtifactDraft["fields"]; custom?: unknown } | null;
			if (!data) return;
			// Keyboard events inside the sandboxed document never reach this window, so
			// the artifact's own ⌘F handler asks us to open the bar.
			if (data.type === "dev3-artifact-find-open") { openSearch(); return; }
			// The frame reports its unsent form values whenever they stop matching
			// their defaults. Empty and with nothing custom means the form went clean
			// again, so the offer to restore goes away with it.
			if (data.type === "dev3-artifact-draft") {
				const fields = Array.isArray(data.fields) ? data.fields : [];
				const artifactId = currentRef.current.artifactId;
				if (!artifactId) return;
				setDraftDismissed(false);
				if (!fields.length && data.custom === undefined) {
					setDraft((held) => (held?.artifactId === artifactId && held.version === currentRef.current.version ? null : held));
					return;
				}
				setDraft({ artifactId, version: currentRef.current.version, draft: { fields, custom: data.custom } });
				return;
			}
			if (data.type === "dev3-artifact-find-result") {
				if (data.token !== searchTokenRef.current) return;
				setMatches(typeof data.matches === "number" ? data.matches : 0);
				setActiveIndex(typeof data.index === "number" ? data.index : -1);
				return;
			}
			// An artifact message: the user filled in a form the report drew and
			// clicked send. It goes into this task's agent pane as if they had typed
			// it; the outcome goes back into the frame so the report can render its
			// own state, and to a toast so the click is never silent.
			if (data.type === "dev3-artifact-send") {
				const id = data.id;
				const text = data.text;
				if (typeof id !== "number" || typeof text !== "string") return;
				const reply = (payload: Record<string, unknown>) =>
					frameRef.current?.post({ type: "dev3-artifact-send-result", id, ...payload });
				api.request.sendArtifactMessageToAgent({
					taskId,
					text,
					artifactTitle: currentRef.current.title,
					version: currentRef.current.version,
					versionCount: currentRef.current.versionCount,
				})
					.then(() => {
						reply({ ok: true });
						toast.success(t("artifactViewer.messageSent"), { taskId });
					})
					.catch((err) => {
						reply({ ok: false, reason: "failed", message: String(err) });
						toast.error(t("artifactViewer.messageFailed"), { taskId });
					});
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
	}, [t, taskId, openSearch]);

	const sendTheme = useCallback(() => {
		const theme = themeMode === "follow" ? currentTheme() : themeMode;
		frameRef.current?.post({ type: "dev3-artifact-theme", theme });
	}, [themeMode]);

	useEffect(() => {
		sendTheme();
	}, [sendTheme]);

	useEffect(() => {
		const observer = new MutationObserver(sendTheme);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		return () => observer.disconnect();
	}, [sendTheme]);

	// Hide the WebGL terminal behind the lightbox (see the component docstring).
	useEffect(() => {
		const el = document.documentElement;
		el.setAttribute("data-artifact-viewer", "open");
		return () => el.removeAttribute("data-artifact-viewer");
	}, []);

	const go = useCallback((delta: number) => {
		// Drop the version pick with the artifact: paging back to an artifact must
		// land on its newest version, never on the one that was open a moment ago —
		// a silently stale version is the confusion this whole feature removes.
		setPick(null);
		setIndex((value) => Math.max(0, Math.min(artifacts.length - 1, value + delta)));
	}, [artifacts.length]);

	// Capture phase + stopPropagation: this lightbox is a modal that owns the
	// keyboard while open, and the App-level handler is registered first and would
	// otherwise navigate out of the task workspace behind it (decision 181).
	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
			// While searching, arrows belong to the query caret, not to history.
			if (searchOpen) return;
			event.preventDefault();
			event.stopPropagation();
			go(event.key === "ArrowLeft" ? -1 : 1);
		}
		window.addEventListener("keydown", onKey, { capture: true });
		return () => window.removeEventListener("keydown", onKey, { capture: true });
	}, [go, searchOpen]);

	// Escape is owned by the overlay-layer stack, not by a listener of our own: a
	// modal that opened this lightbox (the archived task modal) registered its
	// capture-phase Escape first and stops immediate propagation, so a private
	// listener here would never run and the modal underneath would close instead.
	// Registering as a layer puts us at the top of that unwind order, one layer
	// per press: search → fullscreen → viewer.
	const dismissRef = useRef<() => void>(() => {});
	dismissRef.current = () => {
		if (searchOpen) closeSearch();
		else if (fullscreen) setFullscreen(false);
		else onClose();
	};
	useEffect(() => {
		const el = viewerRef.current;
		if (!el) return;
		return registerOverlayLayer(el, () => dismissRef.current());
	// The card element identity is stable for the viewer's lifetime.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ⌘F (Ctrl+F elsewhere) — find inside the artifact. The lightbox is modal, so
	// while it is open the shortcut is unconditionally ours; the browser's native
	// find keeps working everywhere else in remote mode because nothing else
	// mounts this listener. Focus sitting *inside* the iframe is handled by the
	// injected script, which posts `dev3-artifact-find-open` instead.
	useEffect(() => {
		function onFindShortcut(event: KeyboardEvent) {
			const combo = isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
			if (!combo || event.shiftKey || event.altKey || event.code !== "KeyF") return;
			event.preventDefault();
			event.stopPropagation();
			openSearch();
		}
		window.addEventListener("keydown", onFindShortcut, { capture: true });
		return () => window.removeEventListener("keydown", onFindShortcut, { capture: true });
	}, [openSearch]);

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
		<div
			className={`fixed inset-0 z-[70] flex items-center justify-center bg-black/60 outline-none ${fullscreen ? "p-0" : "px-[5vw] py-[5vh]"}`}
			onClick={onClose}
		>
			<div
				ref={viewerRef}
				role="dialog"
				aria-modal="true"
				data-testid="artifact-viewer"
				data-fullscreen={fullscreen ? "true" : "false"}
				data-tour-anchor="task.artifact"
				aria-label={t("artifactViewer.regionLabel")}
				tabIndex={-1}
				onClick={(event) => event.stopPropagation()}
				className={`relative flex min-h-0 flex-col overflow-hidden bg-base outline-none ${fullscreen
					? "h-full w-full rounded-none"
					: "h-full w-full max-w-[2400px] max-h-[1600px] rounded-2xl border border-edge shadow-2xl"}`}
			>
				<header className="relative flex flex-shrink-0 items-center gap-2 border-b border-edge bg-raised px-3 py-2">
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
					<button type="button" data-testid="artifact-viewer-fullscreen" className={iconButton} onClick={() => setFullscreen((value) => !value)} aria-label={fullscreen ? t("artifactViewer.exitFullscreen") : t("artifactViewer.fullscreen")}><span style={{ fontFamily: ICON }}>{fullscreen ? "" : ""}</span></button>
					<button type="button" data-testid="artifact-viewer-close" className={iconButton} onClick={onClose} aria-label={t("artifactViewer.close")}><span style={{ fontFamily: ICON }}></span></button>
				</header>
				{pendingDraft && !draftIsHere && !draftDismissed && (
					<div
						role="status"
						aria-live="polite"
						data-testid="artifact-draft-notice"
						className="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge bg-raised px-3 py-2 text-xs text-fg-2"
					>
						<span className="min-w-0 flex-1">{t("artifactViewer.draftKept", { version: pendingDraft.version })}</span>
						<button
							type="button"
							data-testid="artifact-draft-restore"
							className="rounded-md px-2 py-1 font-medium text-accent transition-colors hover:bg-elevated-hover hover:text-accent-emphasis"
							onClick={() => setPick({ id: pendingDraft.artifactId, version: pendingDraft.version })}
						>{t("artifactViewer.draftBack", { version: pendingDraft.version })}</button>
						<button
							type="button"
							data-testid="artifact-draft-dismiss"
							className="rounded-md px-2 py-1 text-fg-3 transition-colors hover:bg-elevated-hover hover:text-fg"
							onClick={() => setDraftDismissed(true)}
							aria-label={t("artifactViewer.draftDismiss")}
							title={t("artifactViewer.draftDismiss")}
						><span style={{ fontFamily: ICON }}></span></button>
					</div>
				)}
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
						<ArtifactFrame
							ref={frameRef}
							title={current.title}
							transport={transport}
							document={srcDoc}
							onReady={() => { sendTheme(); restoreDraft(); }}
							onMessage={onFrameMessage}
							className="h-full w-full border-0 bg-base"
						/>
					) : (
						<div className="flex h-full items-center justify-center text-sm text-fg-3">{t("artifactViewer.loading")}</div>
					)}
				</div>
				</div>
		</div>
	);
}
