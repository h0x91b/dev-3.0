import { useState, useEffect, useRef } from "react";
import type { Project } from "../../../shared/types";
import { PROJECT_NAME_MAX_LENGTH, normalizeProjectName } from "../../../shared/types";
import { useT } from "../../i18n";

/**
 * The project's display name. Commits on blur / Enter like the label rows — the
 * Board tab has no Save button. Escape restores the stored name, and the path
 * underneath says out loud that nothing on disk moves.
 */
export function ProjectNameField({ project, onRename }: { project: Project; onRename: (name: string) => Promise<boolean> }) {
	const t = useT();
	const [draft, setDraft] = useState(project.name);
	const [saving, setSaving] = useState(false);
	// A rename arriving from elsewhere (CLI, another window) refreshes the field,
	// but never while the user is typing in it.
	const focused = useRef(false);
	useEffect(() => {
		if (!focused.current) setDraft(project.name);
	}, [project.name]);

	const normalized = normalizeProjectName(draft);
	const invalid = normalized === null;

	async function commit() {
		if (!normalized) {
			setDraft(project.name);
			return;
		}
		if (normalized === project.name) {
			setDraft(normalized);
			return;
		}
		setSaving(true);
		const ok = await onRename(normalized);
		setDraft(ok ? normalized : project.name);
		setSaving(false);
	}

	return (
		<div>
			<input
				id="project-name"
				type="text"
				value={draft}
				maxLength={PROJECT_NAME_MAX_LENGTH}
				onChange={(e) => setDraft(e.target.value)}
				onFocus={() => { focused.current = true; }}
				onBlur={() => {
					focused.current = false;
					void commit();
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
					if (e.key === "Escape") {
						setDraft(project.name);
						e.currentTarget.blur();
					}
				}}
				disabled={saving}
				aria-label={t("projectSettings.projectName")}
				aria-invalid={invalid}
				placeholder={t("projectSettings.projectNamePlaceholder")}
				className={`w-full px-3 py-2 bg-base border rounded-lg text-fg text-sm outline-none placeholder-fg-muted transition-colors duration-150 ease-out disabled:opacity-60 ${
					invalid ? "border-danger focus:border-danger" : "border-edge hover:border-edge-active focus:border-accent"
				}`}
			/>
			{invalid && (
				<p className="text-danger text-xs mt-2">{t("projectSettings.projectNameEmpty")}</p>
			)}
			<p className="text-fg-muted text-xs mt-2 font-mono truncate streamer-private" title={project.path}>
				{project.path}
			</p>
		</div>
	);
}
