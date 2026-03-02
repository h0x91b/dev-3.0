import { useState, useRef, useEffect, useLayoutEffect, type Dispatch } from "react";
import { createPortal } from "react-dom";
import type { Label, Project } from "../../shared/types";
import { LABEL_COLORS } from "../../shared/types";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";

interface LabelManagerProps {
	project: Project;
	labels: Label[];
	dispatch: Dispatch<AppAction>;
	onClose: () => void;
	anchorRect: DOMRect;
}

function LabelManager({ project, labels, dispatch, onClose, anchorRect }: LabelManagerProps) {
	const t = useT();
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ top: 0, left: 0 });
	const [visible, setVisible] = useState(false);
	const [newName, setNewName] = useState("");
	const [newColor, setNewColor] = useState(LABEL_COLORS[0]);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editName, setEditName] = useState("");
	const [editColor, setEditColor] = useState("");
	const nameInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		function handleClick(e: MouseEvent) {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				onClose();
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [onClose]);

	useLayoutEffect(() => {
		if (!ref.current) return;
		const menu = ref.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;

		let top = anchorRect.bottom + 6;
		let left = anchorRect.left;

		if (top + menu.height > vh - pad) {
			top = anchorRect.top - menu.height - 6;
		}
		if (left + menu.width > vw - pad) {
			left = vw - menu.width - pad;
		}
		if (left < pad) left = pad;
		if (top < pad) top = pad;

		setPos({ top, left });
		setVisible(true);
	}, [anchorRect]);

	async function handleCreate() {
		const trimmed = newName.trim();
		if (!trimmed) return;
		try {
			const label = await api.request.createLabel({
				projectId: project.id,
				name: trimmed,
				color: newColor,
			});
			dispatch({ type: "addLabel", label });
			setNewName("");
			// Pick next unused color
			const usedColors = new Set(labels.map((l) => l.color));
			usedColors.add(newColor);
			const next = LABEL_COLORS.find((c) => !usedColors.has(c)) ?? LABEL_COLORS[0];
			setNewColor(next);
		} catch (err) {
			alert(t("labels.failedCreate", { error: String(err) }));
		}
	}

	async function handleUpdate(labelId: string) {
		const trimmed = editName.trim();
		if (!trimmed) {
			setEditingId(null);
			return;
		}
		try {
			const label = await api.request.updateLabel({
				projectId: project.id,
				labelId,
				name: trimmed,
				color: editColor,
			});
			dispatch({ type: "updateLabel", label });
			setEditingId(null);
		} catch (err) {
			alert(t("labels.failedUpdate", { error: String(err) }));
		}
	}

	async function handleDelete(label: Label) {
		const confirmed = await api.request.showConfirm({
			title: t("labels.delete"),
			message: t("labels.confirmDelete", { name: label.name }),
		});
		if (!confirmed) return;
		try {
			await api.request.deleteLabel({ projectId: project.id, labelId: label.id });
			dispatch({ type: "removeLabel", labelId: label.id });
		} catch (err) {
			alert(t("labels.failedDelete", { error: String(err) }));
		}
	}

	function startEdit(label: Label) {
		setEditingId(label.id);
		setEditName(label.name);
		setEditColor(label.color);
	}

	return createPortal(
		<div
			ref={ref}
			className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-2 w-[320px]"
			style={{ top: pos.top, left: pos.left, visibility: visible ? "visible" : "hidden" }}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="px-3 py-1.5 text-xs text-fg-3 uppercase tracking-wider font-semibold">
				{t("labels.manage")}
			</div>

			{/* Existing labels */}
			<div className="max-h-[240px] overflow-y-auto">
				{labels.map((label) => (
					<div key={label.id} className="px-3 py-1.5">
						{editingId === label.id ? (
							<div className="space-y-2">
								<div className="flex gap-2">
									<input
										value={editName}
										onChange={(e) => setEditName(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") handleUpdate(label.id);
											if (e.key === "Escape") setEditingId(null);
										}}
										className="flex-1 px-2 py-1 bg-raised border border-edge rounded-lg text-sm text-fg outline-none focus:border-accent/40"
										autoFocus
									/>
									<button
										onClick={() => handleUpdate(label.id)}
										className="px-2 py-1 text-xs bg-accent text-white rounded-lg hover:bg-accent-hover font-semibold"
									>
										{t("task.editSave")}
									</button>
								</div>
								<div className="flex gap-1 flex-wrap">
									{LABEL_COLORS.map((c) => (
										<button
											key={c}
											onClick={() => setEditColor(c)}
											className={`w-5 h-5 rounded-full transition-all ${editColor === c ? "ring-2 ring-white/60 scale-110" : "hover:scale-110"}`}
											style={{ background: c }}
										/>
									))}
								</div>
							</div>
						) : (
							<div className="flex items-center gap-2 group/label">
								<div
									className="w-3 h-3 rounded-full flex-shrink-0"
									style={{ background: label.color }}
								/>
								<span className="text-sm text-fg flex-1 truncate">{label.name}</span>
								<button
									onClick={() => startEdit(label)}
									className="opacity-0 group-hover/label:opacity-100 text-xs text-fg-3 hover:text-fg-2 px-1.5 py-0.5 rounded transition-all"
								>
									{t("labels.edit")}
								</button>
								<button
									onClick={() => handleDelete(label)}
									className="opacity-0 group-hover/label:opacity-100 text-xs text-danger hover:text-danger/80 px-1.5 py-0.5 rounded transition-all"
								>
									{t("labels.delete")}
								</button>
							</div>
						)}
					</div>
				))}
			</div>

			{/* Add new label */}
			<div className="border-t border-edge mt-1 pt-2 px-3 space-y-2">
				<div className="flex gap-2">
					<input
						ref={nameInputRef}
						value={newName}
						onChange={(e) => setNewName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") handleCreate();
						}}
						placeholder={t("labels.namePlaceholder")}
						className="flex-1 px-2 py-1.5 bg-raised border border-edge rounded-lg text-sm text-fg placeholder-fg-muted outline-none focus:border-accent/40"
					/>
					<button
						onClick={handleCreate}
						disabled={!newName.trim()}
						className="px-3 py-1.5 text-xs bg-accent text-white rounded-lg hover:bg-accent-hover font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-all"
					>
						{t("labels.add")}
					</button>
				</div>
				<div className="flex gap-1 flex-wrap pb-1">
					{LABEL_COLORS.map((c) => (
						<button
							key={c}
							onClick={() => setNewColor(c)}
							className={`w-5 h-5 rounded-full transition-all ${newColor === c ? "ring-2 ring-white/60 scale-110" : "hover:scale-110"}`}
							style={{ background: c }}
						/>
					))}
				</div>
			</div>
		</div>,
		document.body,
	);
}

export default LabelManager;
