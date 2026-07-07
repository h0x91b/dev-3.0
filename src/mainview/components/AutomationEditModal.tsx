import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Automation, AutomationCatchUpPolicy, CodingAgent, Project } from "../../shared/types";
import { AUTOMATION_TEMPLATES } from "../../shared/automation-templates";
import { formatRRule, parseRRule, type RRuleSpec } from "../../shared/rrule";
import { api } from "../rpc";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useLocale, useT } from "../i18n";
import Select from "./Select";
import { useFocusTrap } from "../utils/useFocusTrap";

interface AutomationEditModalProps {
	project: Project;
	/** null = create mode. */
	automation: Automation | null;
	onClose: () => void;
	onSaved: () => void;
}

type ScheduleMode = "daily" | "weekly" | "monthly" | "custom";

/** Map an existing RRULE onto the simple builder, or fall back to custom. */
function scheduleModeFor(spec: RRuleSpec): ScheduleMode {
	const simpleTime = spec.byHour.length === 1 && spec.byMinute.length === 1 && spec.interval === 1;
	if (!simpleTime) return "custom";
	if (spec.freq === "DAILY" && spec.byDay.length === 0) return "daily";
	if (spec.freq === "WEEKLY") return "weekly";
	if (spec.freq === "MONTHLY" && spec.byMonthDay.length <= 1) return "monthly";
	return "custom";
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** Localized short weekday labels, Monday-first, indexed as [dow, label]. */
function weekdayLabels(locale: string): Array<{ dow: number; label: string }> {
	const fmt = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
	// 2024-01-07 is a Sunday; +1..+7 walks Mon..Sun.
	return [1, 2, 3, 4, 5, 6, 0].map((dow) => ({
		dow,
		label: fmt.format(new Date(Date.UTC(2024, 0, 7 + (dow === 0 ? 7 : dow)))),
	}));
}

function AutomationEditModal({ project, automation, onClose, onSaved }: AutomationEditModalProps) {
	const t = useT();
	const [locale] = useLocale();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const isCreate = automation === null;

	const parsedSpec = useMemo(() => {
		if (!automation) return null;
		try {
			return parseRRule(automation.rrule);
		} catch {
			return null;
		}
	}, [automation]);

	const [name, setName] = useState(automation?.name ?? "");
	const [prompt, setPrompt] = useState(automation?.prompt ?? "");
	const [mode, setMode] = useState<ScheduleMode>(parsedSpec ? scheduleModeFor(parsedSpec) : "weekly");
	const [time, setTime] = useState(parsedSpec && parsedSpec.byHour.length === 1 ? `${pad2(parsedSpec.byHour[0])}:${pad2(parsedSpec.byMinute[0] ?? 0)}` : "09:00");
	const [byDay, setByDay] = useState<number[]>(parsedSpec && parsedSpec.byDay.length > 0 ? parsedSpec.byDay : [5]); // Friday
	const [monthDay, setMonthDay] = useState<number>(parsedSpec?.byMonthDay[0] ?? 1);
	const [customRRule, setCustomRRule] = useState(automation?.rrule ?? "FREQ=DAILY;BYHOUR=9;BYMINUTE=0");
	const [timezone, setTimezone] = useState(automation?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
	const [agentId, setAgentId] = useState<string | null>(automation?.agentId ?? null);
	const [configId, setConfigId] = useState<string | null>(automation?.configId ?? null);
	const [catchUp, setCatchUp] = useState<AutomationCatchUpPolicy>(automation?.catchUp ?? "skip");
	const [agents, setAgents] = useState<CodingAgent[]>([]);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEscapeKey(onClose);

	useEffect(() => {
		api.request.getAgents().then(setAgents).catch(() => {});
	}, []);

	const weekdays = useMemo(() => weekdayLabels(locale), [locale]);

	function applyTemplate(templateId: string) {
		const template = AUTOMATION_TEMPLATES.find((tpl) => tpl.id === templateId);
		if (!template) return;
		if (!name.trim()) setName(template.name);
		setPrompt(template.prompt);
		try {
			const spec = parseRRule(template.rrule);
			const m = scheduleModeFor(spec);
			setMode(m);
			if (spec.byHour.length === 1) setTime(`${pad2(spec.byHour[0])}:${pad2(spec.byMinute[0] ?? 0)}`);
			if (spec.byDay.length > 0) setByDay(spec.byDay);
			if (spec.byMonthDay.length > 0) setMonthDay(spec.byMonthDay[0]);
		} catch {
			setMode("custom");
		}
		setCustomRRule(template.rrule);
	}

	function buildRRule(): string {
		if (mode === "custom") return customRRule.trim();
		const [hh, mm] = time.split(":").map((v) => Number(v));
		const hour = Number.isInteger(hh) ? hh : 9;
		const minute = Number.isInteger(mm) ? mm : 0;
		if (mode === "daily") {
			return formatRRule({ freq: "DAILY", interval: 1, byDay: [], byMonthDay: [], byHour: [hour], byMinute: [minute] });
		}
		if (mode === "weekly") {
			return formatRRule({ freq: "WEEKLY", interval: 1, byDay: byDay.length > 0 ? byDay : [5], byMonthDay: [], byHour: [hour], byMinute: [minute] });
		}
		return formatRRule({ freq: "MONTHLY", interval: 1, byDay: [], byMonthDay: [Math.min(31, Math.max(1, monthDay))], byHour: [hour], byMinute: [minute] });
	}

	function toggleWeekday(dow: number) {
		setByDay((prev) => (prev.includes(dow) ? prev.filter((d) => d !== dow) : [...prev, dow].sort((a, b) => a - b)));
	}

	async function handleSave() {
		setSaving(true);
		setError(null);
		try {
			const rrule = buildRRule();
			parseRRule(rrule); // client-side validation for a fast error
			if (isCreate) {
				await api.request.createAutomation({
					projectId: project.id,
					name: name.trim(),
					prompt,
					rrule,
					timezone: timezone.trim(),
					agentId,
					configId,
					catchUp,
				});
			} else {
				await api.request.updateAutomation({
					projectId: project.id,
					automationId: automation.id,
					name: name.trim(),
					prompt,
					rrule,
					timezone: timezone.trim(),
					agentId,
					configId,
					catchUp,
				});
			}
			onSaved();
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
		setSaving(false);
	}

	const selectedAgent = agents.find((a) => a.id === agentId);
	const configs = selectedAgent?.configurations ?? [];
	const canSave = name.trim().length > 0 && prompt.trim().length > 0 && !saving;

	const inputClass = "w-full bg-raised border border-edge rounded-lg px-3 py-2 text-sm text-fg placeholder-fg-muted focus:border-edge-active focus:outline-none";
	const labelClass = "text-xs text-fg-3 block mb-1";
	const modeButtonClass = (m: ScheduleMode) =>
		`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
			mode === m ? "bg-accent/15 text-accent" : "text-fg-3 hover:text-fg-2 hover:bg-raised-hover"
		}`;

	// Portal to <body>: this modal is rendered inside ProjectSettings' `backdrop-blur`
	// card, and `backdrop-filter` establishes a containing block for `position: fixed`
	// descendants — an inline `fixed inset-0` would anchor to that ~672px card and land
	// partially off-screen (#845). Portaling detaches it from that subtree so it re-anchors
	// to the viewport.
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				tabIndex={-1}
				className="bg-overlay rounded-2xl shadow-2xl shadow-black/50 border border-edge-active w-full max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto outline-none"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="px-6 py-4 border-b border-edge">
					<h2 className="text-fg text-lg font-semibold">
						{isCreate ? t("automations.modalCreateTitle") : t("automations.modalEditTitle")}
					</h2>
				</div>

				<div className="px-6 py-4 space-y-4">
					{isCreate && (
						<div>
							<label className={labelClass}>{t("automations.template")}</label>
							<div className="flex flex-wrap gap-2">
								{AUTOMATION_TEMPLATES.map((tpl) => (
									<button
										key={tpl.id}
										type="button"
										onClick={() => applyTemplate(tpl.id)}
										className="px-3 py-1.5 rounded-lg text-xs font-medium text-accent bg-accent/10 hover:bg-accent/20 transition-colors"
									>
										{t(tpl.nameKey as Parameters<typeof t>[0])}
									</button>
								))}
							</div>
						</div>
					)}

					<div>
						<label htmlFor="automation-name" className={labelClass}>{t("automations.name")}</label>
						<input
							id="automation-name"
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder={t("automations.namePlaceholder")}
							className={inputClass}
						/>
					</div>

					<div>
						<label htmlFor="automation-prompt" className={labelClass}>{t("automations.prompt")}</label>
						<textarea
							id="automation-prompt"
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							placeholder={t("automations.promptPlaceholder")}
							rows={6}
							className={`${inputClass} resize-y font-mono text-xs leading-relaxed`}
						/>
					</div>

					<div>
						<label className={labelClass}>{t("automations.schedule")}</label>
						<div className="flex gap-1 bg-elevated/50 rounded-lg p-1 mb-2 w-fit">
							<button type="button" onClick={() => setMode("daily")} className={modeButtonClass("daily")}>{t("automations.scheduleDaily")}</button>
							<button type="button" onClick={() => setMode("weekly")} className={modeButtonClass("weekly")}>{t("automations.scheduleWeekly")}</button>
							<button type="button" onClick={() => setMode("monthly")} className={modeButtonClass("monthly")}>{t("automations.scheduleMonthly")}</button>
							<button type="button" onClick={() => setMode("custom")} className={modeButtonClass("custom")}>{t("automations.scheduleCustom")}</button>
						</div>

						{mode === "weekly" && (
							<div className="flex gap-1 mb-2">
								{weekdays.map(({ dow, label }) => (
									<button
										key={dow}
										type="button"
										onClick={() => toggleWeekday(dow)}
										className={`px-2 py-1 rounded-md text-xs font-medium transition-colors ${
											byDay.includes(dow) ? "bg-accent text-white" : "bg-raised text-fg-3 hover:text-fg-2 hover:bg-raised-hover"
										}`}
									>
										{label}
									</button>
								))}
							</div>
						)}

						{mode === "monthly" && (
							<div className="flex items-center gap-2 mb-2">
								<label htmlFor="automation-monthday" className="text-xs text-fg-3">{t("automations.dayOfMonth")}</label>
								<input
									id="automation-monthday"
									type="number"
									min={1}
									max={31}
									value={monthDay}
									onChange={(e) => setMonthDay(Number(e.target.value))}
									className="w-20 bg-raised border border-edge rounded-lg px-2 py-1 text-sm text-fg focus:border-edge-active focus:outline-none"
								/>
							</div>
						)}

						{mode !== "custom" ? (
							<div className="flex items-center gap-2">
								<label htmlFor="automation-time" className="text-xs text-fg-3">{t("automations.time")}</label>
								<input
									id="automation-time"
									type="time"
									value={time}
									onChange={(e) => setTime(e.target.value)}
									className="bg-raised border border-edge rounded-lg px-2 py-1 text-sm text-fg focus:border-edge-active focus:outline-none"
								/>
							</div>
						) : (
							<div>
								<input
									type="text"
									value={customRRule}
									onChange={(e) => setCustomRRule(e.target.value)}
									placeholder="FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=0"
									className={`${inputClass} font-mono text-xs`}
								/>
								<p className="text-fg-muted text-xs mt-1">{t("automations.customRRuleHint")}</p>
							</div>
						)}
					</div>

					<div className="grid grid-cols-2 gap-3">
						<div>
							<label htmlFor="automation-timezone" className={labelClass}>{t("automations.timezone")}</label>
							<input
								id="automation-timezone"
								type="text"
								value={timezone}
								onChange={(e) => setTimezone(e.target.value)}
								placeholder="Europe/Berlin"
								className={inputClass}
							/>
						</div>
						<div>
							<label htmlFor="automation-catchup" className={labelClass}>{t("automations.catchUp")}</label>
							<Select
								id="automation-catchup"
								value={catchUp}
								options={[
									{ value: "skip", label: t("automations.catchUpSkip") },
									{ value: "runOnce", label: t("automations.catchUpRunOnce") },
								]}
								onChange={(val) => setCatchUp((val as AutomationCatchUpPolicy) || "skip")}
							/>
						</div>
					</div>

					<div className="grid grid-cols-2 gap-3">
						<div>
							<label htmlFor="automation-agent" className={labelClass}>{t("launch.agent")}</label>
							<Select
								id="automation-agent"
								value={agentId ?? ""}
								options={[{ value: "", label: t("automations.agentDefault") }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
								onChange={(val) => {
									const newId = val || null;
									setAgentId(newId);
									const agent = agents.find((a) => a.id === newId);
									setConfigId(agent?.defaultConfigId ?? agent?.configurations[0]?.id ?? null);
								}}
							/>
						</div>
						{configs.length > 0 && (
							<div>
								<label htmlFor="automation-config" className={labelClass}>{t("launch.config")}</label>
								<Select
									id="automation-config"
									value={configId ?? ""}
									options={configs.map((c) => ({ value: c.id, label: c.name }))}
									onChange={(val) => setConfigId(val || null)}
								/>
							</div>
						)}
					</div>
				</div>

				{error && (
					<div className="px-6 py-2 text-danger text-sm break-words">{error}</div>
				)}

				<div className="px-6 py-4 border-t border-edge flex items-center justify-end gap-3">
					<button
						onClick={onClose}
						className="text-fg-3 hover:text-fg text-sm transition-colors px-3 py-1.5"
						disabled={saving}
					>
						{t("kanban.cancel")}
					</button>
					<button
						onClick={handleSave}
						disabled={!canSave}
						className="bg-accent hover:bg-accent-hover text-white text-sm font-medium px-5 py-2 rounded-xl transition-colors disabled:opacity-50"
					>
						{saving ? t("automations.saving") : isCreate ? t("automations.create") : t("automations.save")}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}

export default AutomationEditModal;
