import { useEffect, useRef, type ReactNode } from "react";
import { useT } from "../i18n";
import { useMobile } from "../hooks/useMobile";
import { usePortraitOrientation } from "../hooks/usePortraitOrientation";

export default function MobilePortraitGate({ children }: { children: ReactNode }) {
	const t = useT();
	const isMobile = useMobile();
	const landscape = usePortraitOrientation(isMobile);
	const appRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const app = appRef.current;
		if (!app) return;

		if (landscape) {
			app.setAttribute("inert", "");
			app.setAttribute("aria-hidden", "true");
			if (app.contains(document.activeElement)) {
				(document.activeElement as HTMLElement).blur();
			}
		} else {
			app.removeAttribute("inert");
			app.removeAttribute("aria-hidden");
		}
	}, [landscape]);

	return (
		<div className="relative h-full w-full">
			<div ref={appRef} className="h-full w-full" aria-hidden={landscape || undefined}>
				{children}
			</div>
			{landscape && (
				<div
					data-testid="mobile-portrait-gate"
					role="alert"
					aria-live="assertive"
					aria-atomic="true"
					className="fixed inset-0 z-[200] flex items-center justify-center bg-base/95 px-6 text-center"
				>
					<div className="w-full max-w-sm rounded-2xl border border-edge bg-raised p-6 shadow-2xl">
						<div
							className="mb-4 text-4xl leading-none text-accent"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							aria-hidden="true"
						>
							{"↕"}
						</div>
						<h1 className="text-lg font-semibold text-fg">{t("mobile.portrait.title")}</h1>
						<p className="mt-2 text-sm leading-relaxed text-fg-2">{t("mobile.portrait.message")}</p>
					</div>
				</div>
			)}
		</div>
	);
}
