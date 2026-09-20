import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Route } from "../state";
import { useT } from "../i18n";
import { useInterfaceOnboarding } from "../hooks/useInterfaceOnboarding";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useEscapeKey } from "../hooks/useEscapeKey";

export default function InterfaceOnboarding({ route, blocked }: { route: Route; blocked: boolean }) {
	const onboarding = useInterfaceOnboarding(route, blocked);
	return onboarding.prompt ? <Invitation {...onboarding} /> : null;
}

function Invitation({ prompt, busy, failed, request }: ReturnType<typeof useInterfaceOnboarding>) {
	const t = useT();
	const overlay = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const siblings = Array.from(document.body.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el !== overlay.current);
		const previous = siblings.map((el) => el.inert);
		siblings.forEach((el) => { el.inert = true; });
		return () => siblings.forEach((el, index) => { el.inert = previous[index]!; });
	}, []);
	const trap = useFocusTrap<HTMLDivElement>();
	const lesson = prompt === "lesson";
	const close = () => { if (!busy) void request(lesson ? "acknowledge" : "postpone"); };
	useEscapeKey(close);
	useEffect(() => { trap.current?.focus(); }, [lesson, trap]);
	const button = "min-h-11 px-4 py-2 rounded-lg text-sm font-semibold transition-colors motion-safe:active:scale-[0.96] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
	return createPortal(
		<div ref={overlay} className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
			<div ref={trap} role="dialog" aria-modal="true" aria-labelledby="interface-invitation-title" aria-describedby="interface-invitation-description" tabIndex={-1}
				className="bg-overlay rounded-2xl shadow-2xl w-full max-w-md max-h-[90dvh] overflow-y-auto overscroll-contain p-6 text-fg outline-none">
				<h2 id="interface-invitation-title" className="text-lg font-semibold">{t(lesson ? "settings.fullInterfaceLessonTitle" : "settings.fullInterfaceTitle")}</h2>
				<p id="interface-invitation-description" className="mt-3 text-sm text-fg-2">{t(lesson ? "settings.fullInterfaceLesson" : "settings.fullInterfaceIntro")}</p>
				{!lesson && <ul className="mt-3 space-y-2 text-sm text-fg-2 list-disc ps-5">
					<li>{t("settings.fullInterfaceAgents")}</li>
					<li>{t("settings.fullInterfaceSchedule")}</li>
					<li>{t("settings.fullInterfaceProgress")}</li>
				</ul>}
				<figure className="mt-5 rounded-xl bg-raised p-3">
					<div className="flex flex-wrap gap-2 text-xs" aria-hidden="true">
						<span className="rounded-lg bg-elevated px-3 py-2 text-fg">{t("settings.fullInterfaceKeep")}</span>
						<span className="rounded-lg px-3 py-2 text-fg-muted line-through">{t("settings.fullInterfaceHide")}</span>
					</div>
					<figcaption className="mt-2 text-xs text-fg-3">{t("settings.fullInterfaceExample")}</figcaption>
				</figure>
				<p className="mt-4 text-sm text-fg-3">{t("settings.fullInterfaceReassurance")}</p>
				{failed && <p role="alert" className="mt-3 text-sm text-danger">{t("settings.fullInterfaceError")}</p>}
				<div className="mt-5 flex flex-wrap justify-end gap-2">
					{!lesson && <button type="button" disabled={busy} onClick={close} className={`${button} bg-raised text-fg-2 hover:bg-elevated`}>{t("settings.fullInterfaceLater")}</button>}
					<button type="button" disabled={busy} onClick={() => void request(lesson ? "acknowledge" : "disable")} className={`${button} bg-accent-fill text-white hover:bg-accent-fill-hover`}>
						{t(lesson ? "settings.fullInterfaceLessonDone" : "settings.fullInterfaceSwitch")}
					</button>
				</div>
			</div>
		</div>, document.body,
	);
}
