import { createPortal } from "react-dom";
import type { TerminalPreviewState } from "../hooks/useTerminalPreview";

function TerminalPreviewPopover({ open, html, loading, pos, cancelClose, scheduleClose }: TerminalPreviewState) {
	if (!open) return null;

	return createPortal(
		<div
			className="fixed z-50 rounded-xl shadow-2xl shadow-black/50 border border-edge-active overflow-hidden transition-opacity duration-150"
			style={{
				top: pos.top,
				left: pos.left,
				width: 420,
				maxHeight: 320,
				background: "#1a1a2e",
				opacity: html || loading ? 1 : 0,
			}}
			onMouseEnter={cancelClose}
			onMouseLeave={scheduleClose}
			onClick={(e) => e.stopPropagation()}
		>
			{loading ? (
				<div className="flex items-center justify-center h-20">
					<div className="w-4 h-4 border-2 border-fg-muted/30 border-t-fg-muted rounded-full animate-spin" />
				</div>
			) : html ? (
				<pre
					className="overflow-hidden m-0 p-2"
					style={{
						fontFamily: "monospace",
						fontSize: "5px",
						lineHeight: "6px",
						color: "#d3d7cf",
						whiteSpace: "pre",
						userSelect: "none",
					}}
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			) : null}
		</div>,
		document.body
	);
}

export default TerminalPreviewPopover;
