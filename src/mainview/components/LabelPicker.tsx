import {
	useState,
	useEffect,
	useRef,
	useLayoutEffect,
	type Dispatch,
} from "react";
import { createPortal } from "react-dom";
import type { Label, Project, Task } from "../../shared/types";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";

interface LabelPickerProps {
	project: Project;
	task: Task;
	dispatch: Dispatch<AppAction>;
	onClose: () => void;
	anchorEl: HTMLElement;
}

function fuzzyMatch(text: string, query: string): boolean {
	if (!query) return true;
	const lower = text.toLowerCase();
	const q = query.toLowerCase();
	let qi = 0;
	for (let i = 0; i < lower.length && qi < q.length; i++) {
		if (lower[i] === q[qi]) qi++;
	}
	return qi === q.length;
}

function LabelPicker({ project, task, dispatch, onClose, anchorEl }: LabelPickerProps) {
	const t = useT();
	const [query, setQuery] = useState("");
	const [pos, setPos] = useState({ top: 0, left: 0 });
	const [visible, setVisible] = useState(false);
	const [saving, setSaving] = useState(false);
	const pickerRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const labels = project.labels ?? [];
	const taskLabelIds = task.labelIds ?? [];

	const filtered = query
		? labels.filter((l) => fuzzyMatch(l.name, query))
		: labels;

	const showCreate =
		query.trim().length > 0 &&
		!labels.some((l) => l.name.toLowerCase() === query.trim().toLowerCase());

	// Position the picker relative to anchor, clamped to viewport
	useLayoutEffect(() => {
		if (!pickerRef.current) return;
		const anchor = anchorEl.getBoundingClientRect();
		const picker = pickerRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;

		let top = anchor.bottom + 4;
		let left = anchor.left;

		if (top + picker.height > vh - pad) {
			top = anchor.top - picker.height - 4;
		}
		if (left + picker.width > vw - pad) {
			left = vw - picker.width - pad;
		}
		if (left < pad) left = pad;
		if (top < pad) top = pad;

		setPos({ top, left });
		setVisible(true);
		inputRef.current?.focus();
	}, [anchorEl]);

	// Close on click outside
	useEffect(() => {
		function handleClick(e: MouseEvent) {
			if (
				pickerRef.current &&
				!pickerRef.current.contains(e.target as Node) &&
				!anchorEl.contains(e.target as Node)
			) {
				onClose();
			}
		}
		function handleKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		document.addEventListener("mousedown", handleClick);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("mousedown", handleClick);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [anchorEl, onClose]);

	async function toggleLabel(label: Label) {
		setSaving(true);
		try {
			const isOn = taskLabelIds.includes(label.id);
			const newIds = isOn
				? taskLabelIds.filter((id) => id !== label.id)
				: [...taskLabelIds, label.id];
			const updated = await api.request.setTaskLabels({
				taskId: task.id,
				projectId: project.id,
				labelIds: newIds,
			});
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			alert(t("labels.failedSetLabels", { error: String(err) }));
		}
		setSaving(false);
	}

	async function createAndAssign() {
		const name = query.trim();
		if (!name) return;
		setSaving(true);
		try {
			const label = await api.request.createLabel({
				projectId: project.id,
				name,
			});
			// Update project in state with new label
			const updatedProject: Project = {
				...project,
				labels: [...labels, label],
			};
			dispatch({ type: "updateProject", project: updatedProject });
			// Assign to task
			const updated = await api.request.setTaskLabels({
				taskId: task.id,
				projectId: project.id,
				labelIds: [...taskLabelIds, label.id],
			});
			dispatch({ type: "updateTask", task: updated });
			setQuery("");
		} catch (err) {
			alert(t("labels.failedCreate", { error: String(err) }));
		}
		setSaving(false);
	}

	async function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
		if (e.key === "Enter") {
			e.preventDefault();
			if (filtered.length > 0 && !showCreate) {
				await toggleLabel(filtered[0]);
			} else if (showCreate) {
				await createAndAssign();
			}
		}
	}

	return createPortal(
		<div
			ref={pickerRef}
			className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active overflow-hidden"
			style={{
				top: pos.top,
				left: pos.left,
				width: 220,
				visibility: visible ? "visible" : "hidden",
			}}
			onClick={(e) => e.stopPropagation()}
		>
			{/* Search input */}
			<div className="p-2 border-b border-edge/50">
				<input
					ref={inputRef}
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={t("labels.searchPlaceholder")}
					className="w-full bg-elevated border border-edge rounded-lg px-2.5 py-1.5 text-xs text-fg placeholder-fg-muted outline-none focus:border-accent/50 transition-colors"
					disabled={saving}
				/>
			</div>

			{/* Label list */}
			<div className="max-h-48 overflow-y-auto py-1">
				{filtered.length === 0 && !showCreate && (
					<div className="px-3 py-4 text-xs text-fg-muted text-center">
						{t("labels.noLabels")}
					</div>
				)}
				{filtered.map((label) => {
					const isOn = taskLabelIds.includes(label.id);
					return (
						<button
							key={label.id}
							type="button"
							onClick={() => toggleLabel(label)}
							disabled={saving}
							className="w-full text-left px-3 py-2 flex items-center gap-2.5 hover:bg-elevated-hover transition-colors"
						>
							{/* Color dot */}
							<span
								className="w-3 h-3 rounded-full flex-shrink-0"
								style={{ background: label.color }}
							/>
							<span className="text-xs text-fg flex-1 truncate">{label.name}</span>
							{/* Checkmark */}
							{isOn && (
								<svg
									className="w-3.5 h-3.5 flex-shrink-0"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth={2.5}
									style={{ color: label.color }}
								>
									<path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
								</svg>
							)}
						</button>
					);
				})}

				{/* Create new label */}
				{showCreate && (
					<button
						type="button"
						onClick={createAndAssign}
						disabled={saving}
						className="w-full text-left px-3 py-2 flex items-center gap-2.5 hover:bg-elevated-hover transition-colors border-t border-edge/40"
					>
						<svg
							className="w-3.5 h-3.5 flex-shrink-0 text-accent"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth={2.5}
						>
							<path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
						</svg>
						<span className="text-xs text-accent truncate">
							{t("labels.createLabel", { name: query.trim() })}
						</span>
					</button>
				)}
			</div>
		</div>,
		document.body,
	);
}

export default LabelPicker;
