import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type { HeaderFlyout } from "../hooks/useHeaderFlyout";

/**
 * The floating panel of an ambient header readout, portaled to `document.body`.
 *
 * Portaled because the kebab clips its own overflow, and the panel is wider than
 * the menu. It stays hidden until the positioning effect has measured it — a
 * panel painted at 0,0 for one frame reads as a flicker in the top-left corner.
 */
export default function HeaderFlyoutPanel({
	flyout,
	width,
	ariaLabel,
	testId,
	children,
}: {
	flyout: HeaderFlyout;
	/** Panel width in px; each readout's content decides its own. */
	width: number;
	ariaLabel: string;
	testId: string;
	children: ReactNode;
}) {
	return createPortal(
		<div
			ref={flyout.popRef}
			role="dialog"
			aria-label={ariaLabel}
			data-testid={testId}
			// Portaled outside the kebab, so the menu's outside-click handler needs
			// this marker to keep itself open while the flyout is being used.
			data-header-flyout="true"
			className="fixed z-[1200] overflow-y-auto overflow-x-hidden rounded-xl border border-edge-active bg-overlay shadow-2xl shadow-black/40"
			style={{
				top: flyout.pos?.top ?? 0,
				left: flyout.pos?.left ?? 0,
				width,
				maxWidth: "calc(100vw - 2rem)",
				maxHeight: "28rem",
				visibility: flyout.pos ? "visible" : "hidden",
			}}
			{...flyout.panelProps}
		>
			{children}
		</div>,
		document.body,
	);
}
