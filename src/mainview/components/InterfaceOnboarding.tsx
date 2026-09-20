import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Route } from "../state";
import { useT } from "../i18n";
import { useInterfaceOnboarding } from "../hooks/useInterfaceOnboarding";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { AddAgentIcon, EyeIcon, SendLaterIcon } from "./TaskIcons";
import "./InterfaceOnboarding.css";

export default function InterfaceOnboarding({ route, blocked, onVisibilityChange }: {
	route: Route;
	blocked: boolean;
	onVisibilityChange?: (visible: boolean) => void;
}) {
	const onboarding = useInterfaceOnboarding(route, blocked);
	const visible = onboarding.prompt !== null;
	useEffect(() => {
		onVisibilityChange?.(visible);
		return () => onVisibilityChange?.(false);
	}, [visible, onVisibilityChange]);
	return visible ? <Invitation {...onboarding} /> : null;
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
	return createPortal(
		<div ref={overlay} className="interface-invitation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
			<div ref={trap} role="dialog" aria-modal="true" aria-labelledby="interface-invitation-title" aria-describedby="interface-invitation-description" tabIndex={-1}
				className={`interface-invitation${lesson ? " interface-invitation--lesson" : ""}`}>
				{lesson ? <div className="interface-invitation-lesson">
					<div className="interface-invitation-eyebrow"><EyeIcon />{t("settings.fullInterfaceEyebrow")}</div>
					<h2 id="interface-invitation-title">{t("settings.fullInterfaceLessonTitle")}</h2>
					<p id="interface-invitation-description">{t("settings.fullInterfaceLesson")}</p>
				</div> : <div className="interface-invitation-body">
					<div className="interface-invitation-copy">
						<div className="interface-invitation-eyebrow"><TerminalMark />{t("settings.fullInterfaceEyebrow")}</div>
						<h2 id="interface-invitation-title">{t("settings.fullInterfaceTitleLead")}<br />{t("settings.fullInterfaceTitle")}<br className="interface-invitation-desktop-break" /> <span>{t("settings.fullInterfaceTitleAccent")}</span></h2>
						<p id="interface-invitation-description" className="interface-invitation-benefits">
							<span>{t("settings.fullInterfaceAgents")}</span>{" "}<span>{t("settings.fullInterfaceSchedule")}</span>{" "}<span>{t("settings.fullInterfaceProgress")}</span>
						</p>
					</div>
					<CapabilityPreview />
				</div>}
				<div className="interface-invitation-footer">
					<p className="interface-invitation-reassurance">{t("settings.fullInterfaceReassurance")}</p>
					{failed && <p role="alert" className="text-danger text-sm mb-3">{t("settings.fullInterfaceError")}</p>}
					<div className="interface-invitation-actions">
						{!lesson && <button type="button" disabled={busy} onClick={close} className="interface-invitation-secondary">{t("settings.fullInterfaceLater")}</button>}
						<button type="button" disabled={busy} onClick={() => void request(lesson ? "acknowledge" : "disable")} className="interface-invitation-primary">
							{t(lesson ? "settings.fullInterfaceLessonDone" : "settings.fullInterfaceSwitch")}
							{!lesson && <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14m-5-5 5 5-5 5" /></svg>}
						</button>
					</div>
					<p className="interface-invitation-restore">{t("settings.fullInterfaceRestore")}</p>
				</div>
			</div>
		</div>, document.body,
	);
}

function CapabilityPreview() {
	const t = useT();
	return <figure className="interface-invitation-preview" role="img" aria-label={t("settings.fullInterfaceExample")}>
		<figcaption className="interface-invitation-preview-caption">{t("settings.fullInterfacePreviewLabel")}</figcaption>
		<div aria-hidden="true">
			<div className="interface-invitation-task">
				<div className="interface-invitation-task-title"><TerminalMark />{t("settings.fullInterfaceTaskExample")}<span>···</span></div>
				<div className="interface-invitation-tabs"><span>{t("settings.fullInterfaceAgentOne")}</span><span><AddAgentIcon />{t("settings.fullInterfaceAgentTwo")}</span></div>
				<div className="interface-invitation-terminal"><span className="text-accent-emphasis">›</span> {t("settings.fullInterfacePerspective")}<br /><span className="text-fg-3">&nbsp; {t("settings.fullInterfaceSameTask")}</span><i /><i /><b /></div>
			</div>
			<div className="interface-invitation-schedule"><SendLaterIcon /><div><small>{t("settings.fullInterfaceScheduledExample")}</small><strong>{t("settings.fullInterfaceTimeExample")}</strong></div></div>
			<div className="interface-invitation-progress"><div><span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4v16h17M8 15l4-5 4 2 5-7" /></svg>{t("settings.fullInterfaceStatsExample")}</span><small>{t("settings.fullInterfaceProgressExample")}</small></div><div className="interface-invitation-chart">{[27, 43, 35, 57, 48, 68, 62, 86, 74, 95].map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div></div>
		</div>
	</figure>;
}

function TerminalMark() {
	return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m5 7 5 5-5 5m8 0h6" /></svg>;
}
