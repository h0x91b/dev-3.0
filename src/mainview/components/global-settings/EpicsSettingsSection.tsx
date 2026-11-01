import { useMemo, useState } from "react";
import type { Epic } from "../../../shared/types";
import { EPIC_COLORS, EPIC_NAME_MAX_LENGTH } from "../../../shared/types";
import type { TFunction } from "../../i18n";
import { useEpicMembers, useEpics } from "../../hooks/useEpics";
import { api } from "../../rpc";
import { toast } from "../../toast";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";

const FIELD = "min-w-0 flex-1 bg-raised text-fg text-sm rounded-lg px-2.5 py-1.5 border border-edge outline-none focus:border-accent";
const BUTTON = "flex-shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium text-fg-2 hover:text-fg hover:bg-fg/5 focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.96] transition-transform";

async function update(t: TFunction, epicId: string, changes: { name?: string; color?: string; archived?: boolean }) {
	try {
		await api.request.updateEpic({ epicId, ...changes });
	} catch (err) {
		toast.error(t("epic.updateFailed", { error: String(err) }));
	}
}

/** Click-to-cycle palette swatch: the next label colour on each click. */
function ColorSwatch({ t, epic }: { t: TFunction; epic: Epic }) {
	const next = EPIC_COLORS[(EPIC_COLORS.indexOf(epic.color as (typeof EPIC_COLORS)[number]) + 1) % EPIC_COLORS.length];
	return (
		<button
			type="button"
			aria-label={t("epic.colorOf", { name: epic.name })}
			title={t("epic.colorOf", { name: epic.name })}
			onClick={() => void update(t, epic.id, { color: next })}
			className="h-5 w-5 flex-shrink-0 rounded-md focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.96] transition-transform"
			style={{ background: epic.color }}
		/>
	);
}

function EpicRow({ t, epic, taskCount }: { t: TFunction; epic: Epic; taskCount: number }) {
	const [name, setName] = useState(epic.name);
	function commitName() {
		const trimmed = name.trim();
		if (!trimmed || trimmed === epic.name) return setName(epic.name);
		void update(t, epic.id, { name: trimmed });
	}
	return (
		<li data-testid="epic-settings-row" className={`flex items-center gap-2 ${epic.archived ? "opacity-70" : ""}`}>
			<ColorSwatch t={t} epic={epic} />
			<input
				aria-label={t("epic.renameOf", { name: epic.name })}
				value={name}
				maxLength={EPIC_NAME_MAX_LENGTH}
				onChange={(e) => setName(e.target.value)}
				onBlur={commitName}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
					if (e.key === "Escape") setName(epic.name);
				}}
				className={FIELD}
			/>
			<span className="w-16 flex-shrink-0 text-right text-xs tabular-nums text-fg-3">{t.plural("epic.taskCount", taskCount)}</span>
			<button type="button" className={`${BUTTON} w-24 text-center`} onClick={() => void update(t, epic.id, { archived: !epic.archived })}>
				{epic.archived ? t("epic.unarchive") : t("epic.archive")}
			</button>
		</li>
	);
}

/**
 * Settings → Tasks → Epics: the one place to rename, recolour and archive the
 * global epics. There is no delete — an archived epic stays on its tasks.
 */
export default function EpicsSettingsSection({ t }: { t: TFunction }) {
	const { epics } = useEpics();
	const members = useEpicMembers();
	const [draft, setDraft] = useState("");
	const counts = useMemo(() => {
		const map = new Map<string, number>();
		for (const m of members) map.set(m.epicId, (map.get(m.epicId) ?? 0) + 1);
		return map;
	}, [members]);
	const byName = (a: Epic, b: Epic) => a.name.localeCompare(b.name);
	const active = epics.filter((e) => !e.archived).sort(byName);
	const archived = epics.filter((e) => e.archived).sort(byName);

	async function create() {
		const name = draft.trim();
		if (!name) return;
		try {
			await api.request.createEpic({ name });
			setDraft("");
		} catch (err) {
			toast.error(t("epic.createFailed", { error: String(err) }));
		}
	}

	return (
		<SettingsSection title={t("epic.settingsTitle")} description={t("epic.settingsDesc")}>
			<SettingsEntry anchor="epics">
				<form
					className="flex items-center gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						void create();
					}}
				>
					<input
						aria-label={t("epic.new")}
						placeholder={t("epic.namePlaceholder")}
						value={draft}
						maxLength={EPIC_NAME_MAX_LENGTH}
						onChange={(e) => setDraft(e.target.value)}
						className={FIELD}
					/>
					<button
						type="submit"
						disabled={!draft.trim()}
						className="flex-shrink-0 rounded-lg bg-accent-fill px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-fill-hover disabled:opacity-50 motion-safe:active:scale-[0.96] transition-transform"
					>
						{t("epic.create")}
					</button>
				</form>
				{epics.length === 0 ? (
					<p className="mt-3 text-sm text-fg-3">{t("epic.empty")}</p>
				) : (
					<ul className="mt-3 space-y-1.5">
						{active.map((e) => <EpicRow key={`${e.id}:${e.name}`} t={t} epic={e} taskCount={counts.get(e.id) ?? 0} />)}
					</ul>
				)}
				{archived.length > 0 && (
					<>
						<h3 className="mt-4 mb-1.5 text-xs font-semibold uppercase tracking-wider text-fg-3">{t("epic.archivedHeading")}</h3>
						<ul className="space-y-1.5">
							{archived.map((e) => <EpicRow key={`${e.id}:${e.name}`} t={t} epic={e} taskCount={counts.get(e.id) ?? 0} />)}
						</ul>
					</>
				)}
			</SettingsEntry>
		</SettingsSection>
	);
}
