import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { artifactChannelDeliveryScript, type ArtifactTransport } from "../utils/artifactChannel";
import { ARTIFACT_MASK_SELECTORS, clearOverlayMaskTags, syncOverlayMaskTags } from "../utils/artifactOverlayMasks";

export interface ArtifactFrameHandle {
	/** Deliver a message into the artifact document. Queued until it is ready. */
	post(message: Record<string, unknown>): void;
}

interface ArtifactFrameProps {
	/** The composed artifact document, already carrying the matching channel. */
	document: string;
	title: string;
	transport: ArtifactTransport;
	className?: string;
	onMessage(message: unknown): void;
	/** The document finished loading — the viewer re-sends the theme here. */
	onReady(): void;
}

/** The subset of Electrobun's `<electrobun-webview>` this component drives. */
interface WebviewTagElement extends HTMLElement {
	on(event: string, listener: (event: CustomEvent) => void): void;
	off(event: string, listener: (event: CustomEvent) => void): void;
	addMaskSelector(selector: string): void;
	toggleHidden(hidden?: boolean): void;
	syncDimensions(force?: boolean): void;
	executeJavascript(js: string): void;
}

/** How often the native layer is re-checked against the page it floats over. */
const OVERLAY_SYNC_MS = 200;

/**
 * The artifact document's host, in whichever form this platform can give it.
 *
 * `webview` is an `<electrobun-webview>`: a separate WebContent process, so an
 * artifact that wedges its own main thread — the freeze this whole change exists
 * for — takes nothing else with it. `frame` is the sandboxed `srcdoc` iframe,
 * which shares the app window's process and therefore its fate.
 *
 * Callers see one handle either way and never branch on the transport.
 */
const ArtifactFrame = forwardRef<ArtifactFrameHandle, ArtifactFrameProps>(
	function ArtifactFrame(props, ref) {
		return props.transport === "webview"
			? <ArtifactWebview {...props} ref={ref} />
			: <ArtifactIframe {...props} ref={ref} />;
	},
);

const ArtifactIframe = forwardRef<ArtifactFrameHandle, ArtifactFrameProps>(
	function ArtifactIframe({ document: html, title, className, onMessage, onReady }, ref) {
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

const ArtifactWebview = forwardRef<ArtifactFrameHandle, ArtifactFrameProps>(
	function ArtifactWebview({ document: html, className, onMessage, onReady }, ref) {
		const hostRef = useRef<HTMLDivElement>(null);
		const tagRef = useRef<WebviewTagElement | null>(null);
		const readyRef = useRef(false);
		const queueRef = useRef<Record<string, unknown>[]>([]);
		const messageRef = useRef(onMessage);
		const readyHandlerRef = useRef(onReady);
		messageRef.current = onMessage;
		readyHandlerRef.current = onReady;

		function deliver(tag: WebviewTagElement, message: Record<string, unknown>): void {
			tag.executeJavascript(artifactChannelDeliveryScript(message));
		}

		useImperativeHandle(ref, () => ({
			post(message) {
				const tag = tagRef.current;
				// Before dom-ready the child has no channel yet, and executeJavascript
				// would evaluate against a document that is not there. Hold it.
				if (!tag || !readyRef.current) {
					queueRef.current.push(message);
					return;
				}
				deliver(tag, message);
			},
		}), []);

		// The element is built by hand rather than in JSX: `sandbox` and the initial
		// `html` must be set BEFORE it is connected, because the tag reads them once
		// in its own connectedCallback and never again.
		useEffect(() => {
			const host = hostRef.current;
			if (!host) return;
			const tag = document.createElement("electrobun-webview") as WebviewTagElement;
			// Sandbox is the security boundary, same as `sandbox="allow-scripts"` on the
			// iframe: it denies the artifact Electrobun's RPC bridges to the backend.
			// Measured to still allow the event bridge the channel rides on.
			tag.setAttribute("sandbox", "");
			tag.setAttribute("html", html);
			tag.style.cssText = "display:block;width:100%;height:100%;background:transparent";

			const onHostMessage = (event: CustomEvent) => {
				const detail = event.detail;
				// Electrobun splices the child's `detail` into the host page as a raw JS
				// expression, so what arrives here is normally the parsed OBJECT, not the
				// JSON string the child sent. A string is accepted too — that is what a
				// child that sent a bare string produces, and guessing wrong once already
				// cost this channel its whole inbound direction.
				if (detail && typeof detail === "object") {
					messageRef.current(detail);
					return;
				}
				if (typeof detail !== "string") return;
				try {
					messageRef.current(JSON.parse(detail));
				} catch {
					// Not ours — some other page script talking to the bridge.
				}
			};
			const onDomReady = () => {
				readyRef.current = true;
				const queued = queueRef.current;
				queueRef.current = [];
				for (const message of queued) deliver(tag, message);
				readyHandlerRef.current();
			};
			tag.on("host-message", onHostMessage);
			tag.on("dom-ready", onDomReady);
			host.appendChild(tag);
			tagRef.current = tag;
			for (const selector of ARTIFACT_MASK_SELECTORS) tag.addMaskSelector(selector);

			return () => {
				tag.off("host-message", onHostMessage);
				tag.off("dom-ready", onDomReady);
				// disconnectedCallback tears the native view down; leaving it attached
				// would leave a live process painting over the app.
				tag.remove();
				tagRef.current = null;
				readyRef.current = false;
				queueRef.current = [];
				clearOverlayMaskTags();
			};
		// `html` is deliberately not a dependency: a new document is loaded by the
		// effect below, not by rebuilding the whole native view.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);

		// A different artifact (or version) — reload in place.
		const firstDocumentRef = useRef(true);
		useEffect(() => {
			if (firstDocumentRef.current) { firstDocumentRef.current = false; return; }
			const tag = tagRef.current;
			if (!tag) return;
			readyRef.current = false;
			queueRef.current = [];
			tag.setAttribute("html", html);
		}, [html]);

		// The native layer floats above the window and knows nothing about the page
		// under it: it has to be told where the app's overlays are, and taken away
		// entirely when the viewer is laid out to zero (a hidden pane, a collapsed
		// panel), because the tag's own sync ignores a zero rect and would leave the
		// layer parked over the app.
		useEffect(() => {
			const host = hostRef.current;
			if (!host) return;
			let signature = "";
			let hidden = false;
			const timer = setInterval(() => {
				const tag = tagRef.current;
				if (!tag) return;
				const rect = host.getBoundingClientRect();
				const shouldHide = !host.isConnected || rect.width === 0 || rect.height === 0;
				if (shouldHide !== hidden) {
					hidden = shouldHide;
					tag.toggleHidden(hidden);
					if (!hidden) tag.syncDimensions(true);
				}
				if (hidden) return;
				const next = syncOverlayMaskTags(host);
				if (next === signature) return;
				signature = next;
				tag.syncDimensions(true);
			}, OVERLAY_SYNC_MS);
			return () => clearInterval(timer);
		}, []);

		return <div ref={hostRef} className={className} />;
	},
);

export default ArtifactFrame;
