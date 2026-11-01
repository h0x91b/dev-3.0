import { useEffect, useRef } from "react";
import type { ExtensionManifest } from "../../../shared/extensions";
import { useT } from "../../i18n";
import { useFocusTrap } from "../../utils/useFocusTrap";

export interface ExtensionConsentRequest {
	manifest: ExtensionManifest;
	/** The picked folder; absent for an extension already sitting in `~/.dev3.0/extensions`. */
	sourcePath?: string;
	compatible: boolean;
	apiVersion: string;
	/** "install" copies a picked folder in; "trust" approves one that is already there. */
	mode: "install" | "trust";
}

/**
 * The one-time consent for third-party code (D10). Extensions run unsandboxed, so
 * the confirm is a danger action and Cancel holds the initial focus: the dialog
 * must not be answerable on muscle memory.
 */
export default function ExtensionConsentModal({
	request,
	onCancel,
	onConfirm,
}: {
	request: ExtensionConsentRequest;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const cancelRef = useRef<HTMLButtonElement>(null);
	const { manifest } = request;

	useEffect(() => {
		cancelRef.current?.focus();
	}, []);

	return (
		<div
			className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onCancel();
			}}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="extension-consent-title"
				aria-describedby="extension-consent-intro"
				tabIndex={-1}
				data-testid="extension-consent"
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						e.stopPropagation();
						onCancel();
					}
				}}
				className="bg-overlay border border-danger/40 rounded-2xl shadow-2xl w-[30rem] max-w-full max-h-[calc(100vh-2rem)] overflow-y-auto p-6 space-y-4 outline-none"
			>
				<h2 id="extension-consent-title" className="text-fg text-lg font-semibold">
					{t("extensions.consent.title")}
				</h2>
				<div className="rounded-xl bg-elevated border border-edge px-3 py-2.5 space-y-1">
					<p className="text-fg text-sm font-semibold break-words">{manifest.name}</p>
					<p className="text-fg-3 text-xs break-words">
						{t("extensions.byPublisher", { publisher: manifest.publisher, version: manifest.version })}
					</p>
					<p className="text-fg-3 text-xs break-words">
						{t("extensions.consent.views", { views: manifest.contributes.boardViews.map((v) => v.label).join(", ") })}
					</p>
					{request.sourcePath && (
						<p className="text-fg-muted text-xs font-mono break-all">
							{t("extensions.consent.folder")}: <span className="streamer-private">{request.sourcePath}</span>
						</p>
					)}
				</div>
				<p id="extension-consent-intro" className="text-fg-2 text-sm">
					{t("extensions.consent.intro", { name: manifest.name, publisher: manifest.publisher })}
				</p>
				<div>
					<p className="text-fg text-sm font-semibold mb-1.5">{t("extensions.consent.canTitle")}</p>
					<ul className="list-disc pl-5 space-y-1 text-fg-2 text-sm">
						<li>{t("extensions.consent.canRead")}</li>
						<li>{t("extensions.consent.canAct")}</li>
						<li>{t("extensions.consent.canRun")}</li>
					</ul>
				</div>
				{!request.compatible && (
					<p className="text-warning-strong text-sm" role="note">
						{t("extensions.consent.incompatible", { range: manifest.engines.dev3, version: request.apiVersion })}
					</p>
				)}
				<div className="flex flex-wrap justify-end gap-2 pt-1">
					<button
						ref={cancelRef}
						type="button"
						onClick={onCancel}
						data-testid="extension-consent-cancel"
						className="px-4 py-2 text-sm rounded-lg text-fg-2 border border-edge hover:text-fg hover:bg-elevated-hover transition-colors"
					>
						{t("extensions.consent.cancel")}
					</button>
					<button
						type="button"
						onClick={onConfirm}
						data-testid="extension-consent-confirm"
						className="px-4 py-2 text-sm rounded-lg bg-danger text-white hover:bg-danger/80 transition-colors"
					>
						{request.mode === "install" ? t("extensions.consent.confirm") : t("extensions.consent.confirmTrust")}
					</button>
				</div>
			</div>
		</div>
	);
}
