import { useRef, useState } from "react";
import { spacesOfProject } from "../../shared/types";
import { MASK_CLASS } from "../sensitive-projects";
import { api } from "../rpc";
import { toast } from "../toast";
import { useT } from "../i18n";
import { useSpaces } from "../useSpaces";
import SpacePicker from "./SpacePicker";

type ProjectSpacesFieldProps =
	| { projectId: string; mode?: "connected" }
	/** Deferred mode: pure controlled value for forms where the project id does
	 *  not exist yet (create-project). No RPC calls happen inside the field. */
	| { mode: "deferred"; value: string[]; onChange: (spaceIds: string[]) => void };

/**
 * Self-contained membership field: a chip per space, each removable, plus a
 * dashed add-pill opening the SpacePicker — the same shape as a task's labels. Owns its own RPC calls and toasts in
 * connected mode, so host forms never grow spaces state management.
 */
function ProjectSpacesField(props: ProjectSpacesFieldProps) {
	const t = useT();
	const { spaces, file } = useSpaces();
	const [pickerOpen, setPickerOpen] = useState(false);
	const anchorRef = useRef<HTMLButtonElement>(null);

	const connected = props.mode !== "deferred";
	const selectedIds = connected
		? spacesOfProject(file.spaces, (props as { projectId: string }).projectId).map((s) => s.id)
		: (props as { value: string[] }).value;

	async function persist(nextIds: string[]) {
		if (!connected) {
			(props as { onChange: (ids: string[]) => void }).onChange(nextIds);
			return;
		}
		const { projectId } = props as { projectId: string };
		try {
			const { autoDeleted } = await api.request.setProjectSpaces({ projectId, spaceIds: nextIds });
			for (const space of autoDeleted) {
				toast.info(t("spaces.autoDeleted", { name: space.name }));
			}
		} catch (err) {
			toast.error(t("spaces.failedUpdate", { error: String(err) }));
		}
	}

	function handleToggle(spaceId: string) {
		const next = selectedIds.includes(spaceId)
			? selectedIds.filter((id) => id !== spaceId)
			: [...selectedIds, spaceId];
		void persist(next);
	}

	// Inline create needs a first member (a space is never empty), so it only
	// exists in connected mode where the project id is real.
	async function handleCreateNew(name: string) {
		const { projectId } = props as { projectId: string };
		try {
			await api.request.createSpace({ name, projectIds: [projectId] });
		} catch (err) {
			toast.error(t("spaces.failedCreate", { error: String(err) }));
		}
	}

	const selectedSpaces = spaces.filter((s) => selectedIds.includes(s.id));

	return (
		<div data-testid="project-spaces-field">
			{/* Pills, not bordered boxes with a text link beside them: membership
			    here is the same kind of thing as a task's labels, so it wears the
			    same chip and the same dashed "add" affordance. Removal lives on
			    the chip, where the thing being removed is. */}
			<div className="flex flex-wrap items-center gap-1.5">
				{selectedSpaces.map((space) => (
					<span
						key={space.id}
						className="group/chip inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 pl-2.5 pr-1 py-1 text-xs text-accent"
						data-testid={`space-chip-${space.id}`}
					>
						<span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-accent/70 flex-shrink-0" />
						<span className={`font-medium leading-none truncate max-w-[10rem] ${space.sensitive ? MASK_CLASS : ""}`}>{space.name}</span>
						<button
							type="button"
							onClick={() => handleToggle(space.id)}
							title={t("spaces.removeFromSpace", { name: space.name })}
							aria-label={t("spaces.removeFromSpace", { name: space.name })}
							className="touch-inline flex items-center justify-center w-4 h-4 rounded-full flex-shrink-0 text-accent/70 bg-accent/15 opacity-0 group-hover/chip:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 hover:text-accent hover:bg-accent/30 transition-[opacity,background-color,color]"
							data-testid={`space-chip-remove-${space.id}`}
						>
							<svg aria-hidden="true" focusable="false" className="w-2 h-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
								<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
							</svg>
						</button>
					</span>
				))}
				<button
					ref={anchorRef}
					type="button"
					onClick={() => setPickerOpen(true)}
					className="inline-flex items-center gap-1 rounded-full border border-dashed border-edge-active px-2.5 py-1 text-xs font-medium text-fg-3 hover:text-fg hover:bg-fg/5 transition-colors"
					data-testid="project-spaces-edit"
				>
					<svg aria-hidden="true" focusable="false" className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
						<path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
					</svg>
					{t("spaces.addToSpace")}
				</button>
			</div>
			{pickerOpen && anchorRef.current && (
				<SpacePicker
					spaces={spaces}
					selectedIds={selectedIds}
					onToggle={handleToggle}
					onCreateNew={connected ? handleCreateNew : undefined}
					anchorEl={anchorRef.current}
					onClose={() => setPickerOpen(false)}
				/>
			)}
		</div>
	);
}

export default ProjectSpacesField;
