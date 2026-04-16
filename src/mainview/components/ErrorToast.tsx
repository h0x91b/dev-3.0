import { useState, useEffect, useRef } from "react";

const ERROR_EVENT = "app:error";

export function dispatchErrorToast(message: string) {
	window.dispatchEvent(new CustomEvent(ERROR_EVENT, { detail: { message } }));
}

interface ToastEntry {
	id: number;
	message: string;
}

const AUTO_DISMISS_MS = 6000;

export function ErrorToast() {
	const [toasts, setToasts] = useState<ToastEntry[]>([]);
	const nextId = useRef(0);

	useEffect(() => {
		function handler(e: Event) {
			const { message } = (e as CustomEvent<{ message: string }>).detail;
			const id = ++nextId.current;
			setToasts(prev => [...prev, { id, message }]);
			setTimeout(() => {
				setToasts(prev => prev.filter(t => t.id !== id));
			}, AUTO_DISMISS_MS);
		}
		window.addEventListener(ERROR_EVENT, handler);
		return () => window.removeEventListener(ERROR_EVENT, handler);
	}, []);

	if (!toasts.length) return null;

	return (
		<div className="fixed top-14 right-4 z-50 flex flex-col gap-2 pointer-events-none">
			{toasts.map(({ id, message }) => (
				<div key={id} className="pointer-events-auto animate-slide-in-right">
					<div className="bg-overlay border border-danger/40 rounded-xl shadow-2xl p-4 w-80 flex items-start gap-3">
						<span
							className="text-danger text-xl leading-none mt-0.5 flex-shrink-0"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
						>
							{"\uf071"}
						</span>
						<div className="flex-1 min-w-0 text-fg text-sm break-words">{message}</div>
						<button
							onClick={() => setToasts(prev => prev.filter(t => t.id !== id))}
							className="text-fg-muted hover:text-fg transition-colors flex-shrink-0 ml-1"
						>
							<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
							</svg>
						</button>
					</div>
				</div>
			))}
		</div>
	);
}
