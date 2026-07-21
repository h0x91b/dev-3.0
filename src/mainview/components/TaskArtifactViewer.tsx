import { useCallback, useEffect, useRef, useState } from "react";
import type { SharedArtifact } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";
import { toast } from "../toast";
import { composeArtifactDocument } from "../utils/artifactDocument";

interface TaskArtifactViewerProps {
	artifacts: SharedArtifact[];
	initialIndex: number;
	onClose: () => void;
	taskId?: string;
}

type ArtifactThemeMode = "follow" | "light" | "dark";

const ICON = "'JetBrainsMono Nerd Font Mono'";

function currentTheme(): "dark" | "light" {
	return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function downloadBase64(base64: string, mime: string, fileName: string): void {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 0);
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

function parseDataUrl(src: string): { mime: string; base64: string } | null {
	const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(src);
	if (!match) return null;
	const mime = match[1] || "application/octet-stream";
	if (match[2]) return { mime, base64: match[3] };
	try {
		return { mime, base64: btoa(decodeURIComponent(match[3])) };
	} catch {
		return null;
	}
}

/** Prefer the copied asset's original file name; otherwise derive one from alt + mime. */
function imageFileName(src: string, alt: string, mime: string, assets: ArtifactAsset[]): string {
	const known = assets.find((asset) => asset.dataUrl === src);
	if (known?.name) return known.name.split("/").pop() || known.name;
	const ext = EXT_BY_MIME[mime] || "png";
	const base = (alt || "image").trim().replace(/[^\w.-]+/g, "_").slice(0, 60) || "image";
	return /\.[a-z0-9]+$/i.test(base) ? base : `${base}.${ext}`;
}

export default function TaskArtifactViewer({ artifacts, initialIndex, onClose, taskId }: TaskArtifactViewerProps) {
	const t = useT();
	const [index, setIndex] = useState(() => Math.max(0, Math.min(artifacts.length - 1, initialIndex)));
	const [srcDoc, setSrcDoc] = useState<string | null>(null);
	const [error, setError] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);
	const [downloading, setDownloading] = useState(false);
	const [themeMode, setThemeMode] = useState<ArtifactThemeMode>("follow");
	const frameRef = useRef<HTMLIFrameElement>(null);
	const viewerRef = useRef<HTMLElement>(null);
	const assetsRef = useRef<ArtifactAsset[]>([]);
	const current = artifacts[index];

	useEffect(() => {
		setIndex((value) => Math.max(0, Math.min(artifacts.length - 1, value)));
	}, [artifacts.length]);

	useEffect(() => {
		if (!current) return;
		let cancelled = false;
		setSrcDoc(null);
		setError(false);
		assetsRef.current = [];
		api.request.readArtifactContent({ artifact: current })
			.then((payload) => {
				if (cancelled) return;
				assetsRef.current = payload.assets;
				setSrcDoc(composeArtifactDocument(payload.html, payload.assets, t("artifactViewer.saveImage")));
			})
			.catch(() => { if (!cancelled) setError(true); });
		return () => { cancelled = true; };
	}, [current, t]);

	useEffect(() => {
		function onMessage(event: MessageEvent) {
			if (event.source !== frameRef.current?.contentWindow) return;
			const data = event.data as { type?: string; src?: string; alt?: string } | null;
			if (!data || data.type !== "dev3-artifact-save-image" || typeof data.src !== "string") return;
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
	}, [t, taskId]);

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
		setIndex((value) => Math.max(0, Math.min(artifacts.length - 1, value + delta)));
	}, [artifacts.length]);

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if (!fullscreen && !viewerRef.current?.contains(document.activeElement)) return;
			if (event.key === "Escape") {
				event.preventDefault();
				if (fullscreen) setFullscreen(false);
				else onClose();
			} else if (event.key === "ArrowLeft") { event.preventDefault(); go(-1); }
			else if (event.key === "ArrowRight") { event.preventDefault(); go(1); }
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [fullscreen, go, onClose]);

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
	const iconButton = "flex h-11 w-11 sm:h-8 sm:w-8 flex-shrink-0 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-elevated-hover hover:text-fg disabled:opacity-40";
	const themeName = themeMode === "follow"
		? t("artifactViewer.themeFollow")
		: themeMode === "light" ? t("artifactViewer.themeLight") : t("artifactViewer.themeDark");
	const themeLabel = t("artifactViewer.themeMode", { mode: themeName });
	const cycleTheme = () => setThemeMode((mode) => mode === "follow" ? "light" : mode === "light" ? "dark" : "follow");
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
					<div className="truncate text-[0.6875rem] text-fg-muted">{current.name}</div>
				</div>
				{artifacts.length > 1 && (
					<>
						<button type="button" className={iconButton} disabled={index === 0} onClick={() => go(-1)} aria-label={t("artifactViewer.previous")}><span style={{ fontFamily: ICON }}></span></button>
						<span className="font-mono text-xs text-fg-3 tabular-nums">{index + 1} / {artifacts.length}</span>
						<button type="button" className={iconButton} disabled={index === artifacts.length - 1} onClick={() => go(1)} aria-label={t("artifactViewer.next")}><span style={{ fontFamily: ICON }}></span></button>
					</>
				)}
				<button
					type="button"
					data-testid="artifact-viewer-theme"
					className={`${iconButton} ${themeMode === "follow" ? "" : "bg-accent/10 text-accent"}`}
					onClick={cycleTheme}
					aria-label={themeLabel}
					title={themeLabel}
				><span style={{ fontFamily: ICON }}>{themeIcon}</span></button>
				<button type="button" className={iconButton} disabled={downloading} onClick={download} aria-label={current.bundlePath ? t("artifactViewer.downloadZip") : t("artifactViewer.downloadHtml")}><span style={{ fontFamily: ICON }}>{downloading ? "" : ""}</span></button>
				<button type="button" data-testid="artifact-viewer-fullscreen" className={iconButton} onClick={() => setFullscreen((value) => !value)} aria-label={fullscreen ? t("artifactViewer.exitFullscreen") : t("artifactViewer.fullscreen")}><span style={{ fontFamily: ICON }}>{fullscreen ? "" : ""}</span></button>
				<button type="button" data-testid="artifact-viewer-close" className={iconButton} onClick={onClose} aria-label={t("artifactViewer.close")}><span style={{ fontFamily: ICON }}></span></button>
			</header>
			<div className="min-h-0 flex-1 bg-base">
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
