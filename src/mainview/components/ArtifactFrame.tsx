import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export interface ArtifactFrameHandle {
	/** Deliver a message into the artifact document. */
	post(message: Record<string, unknown>): void;
}

interface ArtifactFrameProps {
	/** The composed artifact document, already carrying the channel. */
	document: string;
	title: string;
	className?: string;
	onMessage(message: unknown): void;
	/** The document finished loading — the viewer re-sends the theme here. */
	onReady(): void;
}

/**
 * The artifact document's host: a sandboxed `srcdoc` iframe, in the desktop shell
 * and in remote (browser) mode alike. It is part of the page, so app overlays —
 * modals, toasts, popovers, the viewer's own find bar — stack over it by ordinary
 * CSS and need no native masking.
 *
 * See `decisions/2026/09/05/artifact-viewer-back-in-the-page.md` for why the
 * separate `<electrobun-webview>` process was removed again.
 */
const ArtifactFrame = forwardRef<ArtifactFrameHandle, ArtifactFrameProps>(
	function ArtifactFrame({ document: html, title, className, onMessage, onReady }, ref) {
		const frameRef = useRef<HTMLIFrameElement>(null);

		useImperativeHandle(ref, () => ({
			post(message) {
				frameRef.current?.contentWindow?.postMessage(message, "*");
			},
		}), []);

		// Only messages from THIS frame: the app hosts other frames, and a stray
		// postMessage from any of them would otherwise read as artifact traffic.
		const messageRef = useRef(onMessage);
		messageRef.current = onMessage;
		useEffect(() => {
			function handle(event: MessageEvent) {
				if (event.source !== frameRef.current?.contentWindow) return;
				messageRef.current(event.data);
			}
			window.addEventListener("message", handle);
			return () => window.removeEventListener("message", handle);
		}, []);

		return (
			<iframe
				ref={frameRef}
				title={title}
				sandbox="allow-scripts"
				srcDoc={html}
				onLoad={onReady}
				className={className}
			/>
		);
	},
);

export default ArtifactFrame;
