import { useEffect, useMemo, useState } from "react";
import type {
	PackageScripts,
	Project,
	ScriptPlacement,
	ScriptRunner,
	ScriptState,
	Task,
} from "../../shared/types";
import { SCRIPT_PLACEMENTS } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";

interface BatchRow {
	scriptName: string;
	placement: ScriptPlacement;
}

interface Props {
	task: Task;
	project: Project;
	pkg: PackageScripts;
	runner: ScriptRunner;
	states: ScriptState[];
	onClose: () => void;
}

const PLACEMENT_LABELS: Record<ScriptPlacement, string> = {
	left: "scripts.picker.left",
	top: "scripts.picker.top",
	right: "scripts.picker.right",
	bottom: "scripts.picker.bottom",
	window: "scripts.picker.window",
};

export default function RunScriptsBatchModal({ task, project, pkg, runner, states, onClose }: Props) {
	const t = useT();
	const [rows, setRows] = useState<BatchRow[]>([{ scriptName: "", placement: task.scriptPlacement?.default ?? "right" }]);
	const [launching, setLaunching] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const runningNames = useMemo(() => new Set(states.filter((s) => s.status === "running").map((s) => s.scriptName)), [states]);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	function updateRow(i: number, patch: Partial<BatchRow>) {
		setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
	}

	function addRow() {
		setRows((r) => [...r, { scriptName: "", placement: task.scriptPlacement?.default ?? "right" }]);
	}

	function removeRow(i: number) {
		setRows((r) => r.filter((_, idx) => idx !== i));
	}

	async function handleLaunch() {
		setError(null);
		const valid = rows.filter((r) => r.scriptName.trim() !== "");
		if (valid.length === 0) {
			setError(t("scripts.batch.error.empty"));
			return;
		}
		setLaunching(true);
		try {
			for (const row of valid) {
				try {
					await api.request.runScript({
						taskId: task.id,
						projectId: project.id,
						scriptName: row.scriptName,
						placement: row.placement,
						runner,
					});
				} catch (err) {
					setError(t("scripts.error.runFailed", { name: row.scriptName, error: String(err) }));
					setLaunching(false);
					return;
				}
			}
			onClose();
		} finally {
			setLaunching(false);
		}
	}

	const launchableCount = rows.filter((r) => r.scriptName.trim() !== "").length;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onClick={onClose}
		>
			<div
				className="bg-overlay rounded-2xl shadow-2xl shadow-black/50 border border-edge-active w-full max-w-xl mx-4 max-h-[80vh] flex flex-col"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="flex-shrink-0 px-6 py-4 border-b border-edge flex items-center justify-between">
					<div className="min-w-0">
						<h2 className="text-fg text-lg font-semibold">{t("scripts.batch.title")}</h2>
						<p className="text-fg-3 text-xs mt-0.5">{t("scripts.dropdown.header", { count: pkg.scripts.length })}</p>
					</div>
					<span className="text-xs px-2 py-0.5 rounded bg-elevated border border-edge text-fg-2">
						{runner}
					</span>
				</div>

				{/* Body */}
				<div className="overflow-y-auto px-6 py-4 space-y-3 min-h-0">
					{rows.map((row, i) => {
						const conflict = row.scriptName && runningNames.has(row.scriptName);
						return (
							<div
								key={i}
								className="p-3 bg-raised rounded-xl border border-edge"
							>
								<div className="flex items-start gap-3">
									<span className="text-accent font-bold text-sm w-6 flex-shrink-0 mt-1">#{i + 1}</span>

									<div className="flex-1 min-w-0 space-y-2">
										{/* Script select */}
										<div>
											<label className="text-[0.6875rem] text-fg-3 block mb-1">{t("scripts.batch.script")}</label>
											<select
												value={row.scriptName}
												onChange={(e) => updateRow(i, { scriptName: e.target.value })}
												className="w-full bg-base border border-edge rounded-lg px-2 py-1.5 text-sm text-fg focus:outline-none focus:border-accent"
											>
												<option value="">— {t("scripts.batch.pick")} —</option>
												{pkg.scripts.map((s) => (
													<option key={s.name} value={s.name}>{s.name}</option>
												))}
											</select>
											{row.scriptName && (
												<div className="text-[0.6875rem] text-fg-3 mt-1 font-mono truncate">
													{pkg.scripts.find((s) => s.name === row.scriptName)?.command}
												</div>
											)}
										</div>

										{/* Placement segmented */}
										<div>
											<label className="text-[0.6875rem] text-fg-3 block mb-1">{t("scripts.batch.placement")}</label>
											<div className="flex items-center gap-1">
												{SCRIPT_PLACEMENTS.map((p) => (
													<button
														key={p}
														onClick={() => updateRow(i, { placement: p })}
														className={`flex-1 px-2 py-1.5 rounded-md text-[0.625rem] border transition-colors ${
															row.placement === p
																? "border-accent bg-accent/10 text-accent"
																: "border-edge text-fg-3 hover:border-edge-active"
														}`}
													>
														{t(PLACEMENT_LABELS[p] as never)}
													</button>
												))}
											</div>
										</div>

										{conflict && (
											<div className="text-[0.6875rem] text-warning">
												⚠ {t("scripts.batch.alreadyRunning")}
											</div>
										)}
									</div>

									{rows.length > 1 && (
										<button
											onClick={() => removeRow(i)}
											className="text-fg-muted hover:text-danger mt-1 p-1"
											title={t("scripts.batch.removeRow")}
										>
											<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
											</svg>
										</button>
									)}
								</div>
							</div>
						);
					})}

					<button
						onClick={addRow}
						className="text-xs text-accent hover:text-accent-hover font-medium"
					>
						+ {t("scripts.batch.addRow")}
					</button>
				</div>

				{error && (
					<div className="flex-shrink-0 px-6 py-2 text-danger text-sm border-t border-danger/20 bg-danger/5">
						{error}
					</div>
				)}

				{/* Footer */}
				<div className="flex-shrink-0 px-6 py-4 border-t border-edge flex items-center justify-end gap-3">
					<button
						onClick={onClose}
						disabled={launching}
						className="text-fg-3 hover:text-fg text-sm px-3 py-1.5 transition-colors"
					>
						{t("scripts.picker.cancel")}
					</button>
					<button
						onClick={handleLaunch}
						disabled={launching || launchableCount === 0}
						className="bg-accent hover:bg-accent-hover text-white text-sm font-medium px-5 py-2 rounded-xl transition-colors disabled:opacity-50"
					>
						{launching
							? t("scripts.batch.launching")
							: t.plural("scripts.batch.launchN", launchableCount, { count: launchableCount })}
					</button>
				</div>
			</div>
		</div>
	);
}
