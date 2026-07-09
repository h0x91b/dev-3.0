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
}

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

export default function TaskArtifactViewer({ artifacts, initialIndex, onClose }: TaskArtifactViewerProps) {
	const t = useT();
	const [index, setIndex] = useState(() => Math.max(0, Math.min(artifacts.length - 1, initialIndex)));
	const [srcDoc, setSrcDoc] = useState<string | null>(null);
	const [error, setError] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);
	const [downloading, setDownloading] = useState(false);
	const frameRef = useRef<HTMLIFrameElement>(null);
	const current = artifacts[index];

	useEffect(() => {
		setIndex((value) => Math.max(0, Math.min(artifacts.length - 1, value)));
	}, [artifacts.length]);

	useEffect(() => {
		if (!current) return;
		let cancelled = false;
		setSrcDoc(null);
		setError(false);
		api.request.readArtifactContent({ artifact: current })
			.then((payload) => {
				if (!cancelled) setSrcDoc(composeArtifactDocument(payload.html, payload.assets));
			})
			.catch(() => { if (!cancelled) setError(true); });
		return () => { cancelled = true; };
	}, [current]);

	const sendTheme = useCallback(() => {
		frameRef.current?.contentWindow?.postMessage({ type: "dev3-artifact-theme", theme: currentTheme() }, "*");
	}, []);

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
			if (event.key === "Escape") {
				event.preventDefault();
				if (fullscreen) setFullscreen(false);
				else onClose();
			} else if (event.key === "ArrowLeft") go(-1);
			else if (event.key === "ArrowRight") go(1);
			else if (event.key === "f" || event.key === "F") setFullscreen((value) => !value);
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
			toast.error(t("artifactViewer.downloadFailed"));
		} finally {
			setDownloading(false);
		}
	};
	const iconButton = "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-elevated-hover hover:text-fg disabled:opacity-40";

	return (
		<section
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
