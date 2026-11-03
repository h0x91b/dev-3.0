import { useMemo } from "react";
import type { Epic } from "../../shared/types";
import { epicNameKey, pickableEpics } from "../../shared/types";
import { useEpics } from "../hooks/useEpics";
import { useT } from "../i18n";
import { api } from "../rpc";
import { toast } from "../toast";
import Select, { type SelectOption } from "./Select";

interface EpicSelectProps {
	/** The current epic id, or null for none. */
	value: string | null;
	/** Commit a new epic id (null = none). Typing a new name creates the epic first. */
	onChange: (epicId: string | null) => void;
	id?: string;
}

const NONE = "";

/**
 * Pick, change or clear an epic, or create one by typing its name. Archived
 * epics are never offered — the current one still shows, so nothing is lost.
 */
function EpicSelect({ value, onChange, id }: EpicSelectProps) {
	const t = useT();
	const { epics, byId } = useEpics();
	const current = value ? byId.get(value) : undefined;

	const options = useMemo<SelectOption[]>(() => {
		const offered = pickableEpics(epics);
		if (current?.archived) offered.unshift(current);
		return [
			{ value: NONE, label: t("epic.pickerClear") },
			...offered.map((e) => ({ value: e.id, label: e.name })),
		];
	}, [epics, current, t]);

	const swatch = (epic: Epic | undefined, label: string) => (
		<span className="flex min-w-0 items-center gap-2">
			<span aria-hidden className="h-3 w-[3px] flex-shrink-0 rounded-full" style={{ background: epic?.color ?? "transparent" }} />
			<span className={`truncate ${epic?.archived ? "text-fg-3" : ""}`}>{label}</span>
		</span>
	);

	async function commit(next: string) {
		if (next === NONE) return onChange(null);
		if (byId.has(next)) return onChange(next);
		// A typed name: reuse an epic that already has it, else create it.
		const existing = epics.find((e) => epicNameKey(e.name) === epicNameKey(next));
		if (existing) return onChange(existing.id);
		try {
			const created = await api.request.createEpic({ name: next });
			onChange(created.id);
		} catch (err) {
			toast.error(t("epic.createFailed", { error: String(err) }));
		}
	}

	return (
		<Select
			id={id}
			value={value ?? NONE}
			options={options}
			onChange={(next) => void commit(next)}
			renderOption={(option) => swatch(byId.get(option.value), option.label)}
			allowCustom
			ariaLabel={t("epic.change")}
			searchPlaceholder={t("epic.pickerSearch")}
			searchLabel={t("epic.pickerSearch")}
			customOptionLabel={(query) => t("epic.pickerCreate", { name: query.trim() })}
			emptyLabel={epics.length === 0 ? t("epic.pickerEmpty") : t("epic.pickerNoMatch")}
		/>
	);
}

export default EpicSelect;
