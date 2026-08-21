import type { ReactNode } from "react";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useEscapeKey } from "../hooks/useEscapeKey";

type RemoteAccessDialogProps = {
	titleId: string;
	onClose: () => void;
	children: ReactNode;
};

/**
 * Dialog shell for the Remote Access modal. It exists as its own component so
 * the focus trap mounts and unmounts with the modal — `useFocusTrap` captures
 * the trigger element on its first render, which is wrong if the hook lives in
 * a host that is always mounted.
 */
function RemoteAccessDialog({ titleId, onClose, children }: RemoteAccessDialogProps) {
	const trapRef = useFocusTrap<HTMLDivElement>();
	useEscapeKey(onClose);

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
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
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[28rem] p-6 space-y-4 text-center outline-none"
			>
				{children}
			</div>
		</div>
	);
}

export default RemoteAccessDialog;
