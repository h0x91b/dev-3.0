import type { ReactNode } from "react";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useEscapeKey } from "../hooks/useEscapeKey";

type RemoteAccessDialogProps = {
	titleId: string;
	onClose: () => void;
	/** Pinned above the scroll area — stays readable however tall the body grows. */
	header?: ReactNode;
	/** Pinned below the scroll area — the primary action is never scrolled off. */
	footer?: ReactNode;
	children: ReactNode;
};

/**
 * Dialog shell for the Remote Access modal. It exists as its own component so
 * the focus trap mounts and unmounts with the modal — `useFocusTrap` captures
 * the trigger element on its first render, which is wrong if the hook lives in
 * a host that is always mounted.
 *
 * The body scrolls inside a viewport-capped box: this modal's content grows
 * with tunnel state, access-code state and exposed ports, and used to run off
 * both edges of a 720px-tall window.
 */
function RemoteAccessDialog({ titleId, onClose, header, footer, children }: RemoteAccessDialogProps) {
	const trapRef = useFocusTrap<HTMLDivElement>();
	useEscapeKey(onClose);

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				tabIndex={-1}
				data-testid="remote-access-dialog"
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-full max-w-[28rem] max-h-full flex flex-col text-center outline-none"
			>
				{header && <div className="shrink-0 px-6 pt-6 pb-3">{header}</div>}
				<div
					data-testid="remote-access-dialog-body"
					className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 space-y-4 ${header ? "pt-1" : "pt-6"} ${footer ? "pb-1" : "pb-6"}`}
				>
					{children}
				</div>
				{footer && <div className="shrink-0 px-6 pb-6 pt-3">{footer}</div>}
			</div>
		</div>
	);
}

export default RemoteAccessDialog;
