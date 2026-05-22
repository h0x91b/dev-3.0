import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
	PackageScripts,
	Project,
	ScriptPlacement,
	ScriptRunner,
	Task,
} from "../../../shared/types";
import { SCRIPT_PLACEMENTS } from "../../../shared/types";
import { api } from "../../rpc";
import { useT } from "../../i18n";
import RunScriptsBatchModal from "../RunScriptsBatchModal";

interface TaskScriptsProps {
	task: Task;
	project: Project;
	isTaskActive: boolean;
}

interface DropdownPosition {
	top: number;
	left: number;
}

function placementLabel(t: ReturnType<typeof useT>, p: ScriptPlacement): string {
	switch (p) {
		case "left":
			return t("scripts.picker.left");
		case "top":
			return t("scripts.picker.top");
		case "right":
			return t("scripts.picker.right");
		case "bottom":
			return t("scripts.picker.bottom");
		case "window":
			return t("scripts.picker.window");
	}
}

export default function TaskScripts({ task, project, isTaskActive }: TaskScriptsProps) {
	const t = useT();
	const btnRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<DropdownPosition>({ top: 0, left: 0 });
	const [pkg, setPkg] = useState<PackageScripts | null>(null);
	const [runner, setRunner] = useState<ScriptRunner | null>(null);
	const [pickerFor, setPickerFor] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [batchOpen, setBatchOpen] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const fn = api.request.parsePackageScripts;
			if (!fn) return;
			const p = await fn({ taskId: task.id, projectId: project.id });
			setPkg(p);
			setRunner((prev) => prev ?? p.runner);
		} catch (err) {
			setError(String(err));
		}
	}, [task.id, project.id]);

	useEffect(() => {
		if (open) refresh();
	}, [open, refresh]);

	useEffect(() => {
		if (!open) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				if (pickerFor) setPickerFor(null);
				else setOpen(false);
			}
		}
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("keydown", onKey);
		};
	}, [open, pickerFor]);

	// Sort scripts: most recently run first, then keep package.json order for the rest.
	const sortedScripts = useMemo(() => {
		if (!pkg?.scripts) return [];
		const lastRun = task.scriptLastRunAt ?? {};
		const indexed = pkg.scripts.map((s, i) => ({ s, i, ts: lastRun[s.name] ?? "" }));
		indexed.sort((a, b) => {
			if (a.ts && !b.ts) return -1;
			if (!a.ts && b.ts) return 1;
			if (a.ts && b.ts && a.ts !== b.ts) return a.ts > b.ts ? -1 : 1;
			return a.i - b.i;
		});
		return indexed.map((x) => x.s);
	}, [pkg?.scripts, task.scriptLastRunAt]);

	function openDropdown() {
		if (!isTaskActive) return;
		const rect = btnRef.current?.getBoundingClientRect();
		if (!rect) return;
		const width = 380;
		setPos({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) });
		setOpen(true);
		setPickerFor(null);
	}

	function closeDropdown() {
		setOpen(false);
		setPickerFor(null);
	}

	useEffect(() => {
		function onOpenDropdown(e: Event) {
			const detail = (e as CustomEvent).detail as { taskId: string };
			if (detail.taskId !== task.id) return;
			openDropdown();
		}
		function onOpenBatch(e: Event) {
			const detail = (e as CustomEvent).detail as { taskId: string };
			if (detail.taskId !== task.id) return;
			setBatchOpen(true);
			setOpen(false);
		}
		window.addEventListener("menu:task-run-script", onOpenDropdown);
		window.addEventListener("menu:task-run-multiple-scripts", onOpenBatch);
		return () => {
			window.removeEventListener("menu:task-run-script", onOpenDropdown);
			window.removeEventListener("menu:task-run-multiple-scripts", onOpenBatch);
		};
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [task.id, isTaskActive]);

	async function launch(scriptName: string, placement: ScriptPlacement) {
		setBusy(true);
		setError(null);
		try {
			await api.request.runScript({
				taskId: task.id,
				projectId: project.id,
				scriptName,
				placement,
				runner: runner ?? pkg?.runner,
			});
			closeDropdown();
		} catch (err) {
			setError(t("scripts.error.runFailed", { name: scriptName, error: String(err) }));
		} finally {
			setBusy(false);
		}
	}

	const dropdown = open ? createPortal(
		<>
			{/* Backdrop captures clicks anywhere outside the popover (including over WKWebView terminals). */}
			<div
				className="fixed inset-0 z-40"
				onMouseDown={closeDropdown}
				data-task-scripts-backdrop
			/>
			<div
				data-task-scripts-popover
				className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active w-[24rem] flex flex-col"
				style={{
					top: pos.top,
					left: pos.left,
					maxHeight: `calc(100vh - ${pos.top + 16}px)`,
				}}
				onMouseDown={(e) => e.stopPropagation()}
				onClick={(e) => e.stopPropagation()}
			>
				{/* Sticky header */}
				<div className="flex-shrink-0 flex items-center justify-between px-3 py-2 border-b border-edge">
					<div className="text-xs text-fg-3 truncate">
						{pickerFor
							? t("scripts.picker.title", { name: pickerFor })
							: pkg?.exists
								? t("scripts.dropdown.header", { count: pkg.scripts.length })
								: pkg?.error === "no-package-json"
									? t("scripts.empty.noPackageJson")
									: pkg?.error === "no-scripts"
										? t("scripts.empty.noScripts")
										: pkg?.error?.startsWith("parse-failed")
											? t("scripts.empty.parseError", { error: pkg.error })
											: t("scripts.empty.noPackageJson")}
					</div>
					{pkg?.exists && !pickerFor && (
						<RunnerChip
							runner={runner ?? pkg.runner}
							pkg={pkg}
							onSelect={setRunner}
						/>
					)}
				</div>
				{pkg?.multipleLockfiles && !pickerFor && (
					<div className="flex-shrink-0 px-3 py-1.5 text-xs text-warning bg-warning/10 border-b border-warning/20">
						⚠ {t("scripts.warning.multipleLockfiles")}: {pkg.lockfiles.join(", ")}
					</div>
				)}
				{error && (
					<div className="flex-shrink-0 px-3 py-1.5 text-xs text-danger bg-danger/10 border-b border-danger/20">
						{error}
					</div>
				)}

				{/* Picker mode — replaces the list */}
				{pickerFor ? (
					<div className="px-3 py-4">
						<div className="text-xs text-fg-2 mb-1">{pickerFor}</div>
						<div className="text-[0.6875rem] text-fg-3 font-mono mb-3 truncate">
							{pkg?.scripts.find((s) => s.name === pickerFor)?.command}
						</div>
						<div className="grid grid-cols-5 gap-1.5">
							{SCRIPT_PLACEMENTS.map((p) => (
								<button
									key={p}
									onClick={() => launch(pickerFor, p)}
									disabled={busy}
									className="flex flex-col items-center gap-1.5 px-2 py-3 rounded-lg bg-elevated border border-edge hover:border-accent hover:bg-accent/10 transition-colors disabled:opacity-50"
									title={placementLabel(t, p)}
								>
									<PlacementGlyph placement={p} />
									<span className="text-[0.625rem] text-fg-2">{placementLabel(t, p)}</span>
								</button>
							))}
						</div>
						<button
							onClick={() => setPickerFor(null)}
							disabled={busy}
							className="mt-3 text-xs text-fg-3 hover:text-fg disabled:opacity-50"
						>
							← {t("scripts.picker.back")}
						</button>
					</div>
				) : (
					<>
						{/* Scrollable list */}
						<div className="overflow-y-auto py-1 min-h-0">
							{sortedScripts.map((s) => (
								<button
									key={s.name}
									onClick={() => setPickerFor(s.name)}
									disabled={busy}
									className="w-full text-left px-3 py-1.5 flex flex-col hover:bg-elevated transition-colors disabled:opacity-50"
								>
									<span className="text-sm text-fg font-medium truncate">{s.name}</span>
									<span className="text-xs text-fg-3 truncate">{s.command}</span>
								</button>
							))}
						</div>

						{/* Sticky footer */}
						{pkg?.exists && pkg.scripts.length > 0 && (
							<div className="flex-shrink-0 border-t border-edge px-3 py-2">
								<button
									onClick={() => { setBatchOpen(true); setOpen(false); }}
									className="text-xs text-accent hover:text-accent-hover font-medium"
								>
									{t("scripts.footer.runMultiple")}
								</button>
							</div>
						)}
					</>
				)}
			</div>
		</>,
		document.body,
	) : null;

	return (
		<>
			<button
				ref={btnRef}
				onClick={openDropdown}
				className="flex items-center gap-1 px-2 py-1 rounded-lg border border-edge text-fg-3 hover:bg-elevated hover:text-fg transition-colors flex-shrink-0"
				title={pkg?.exists === false ? t("scripts.tooltip.disabled") : t("scripts.tooltip")}
			>
				<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'", fontSize: "0.875rem", lineHeight: 1 }}>
					{"\u{F040A}"}
				</span>
				<span className="text-[0.6875rem] font-semibold whitespace-nowrap">{t("scripts.button")}</span>
			</button>
			{dropdown}
			{batchOpen && pkg?.exists && (
				<RunScriptsBatchModal
					task={task}
					project={project}
					pkg={pkg}
					runner={runner ?? pkg.runner}
					onClose={() => setBatchOpen(false)}
				/>
			)}
		</>
	);
}

function PlacementGlyph({ placement }: { placement: ScriptPlacement }) {
	if (placement === "window") {
		return (
			<div className="w-8 h-6 rounded-sm border border-fg-3 flex items-center justify-center">
				<span className="text-[0.65rem] text-fg-3">+</span>
			</div>
		);
	}
	const cells: Record<Exclude<ScriptPlacement, "window">, { box: string; activeIdx: 0 | 1 }> = {
		left: { box: "grid grid-cols-2 gap-px", activeIdx: 0 },
		right: { box: "grid grid-cols-2 gap-px", activeIdx: 1 },
		top: { box: "grid grid-rows-2 gap-px", activeIdx: 0 },
		bottom: { box: "grid grid-rows-2 gap-px", activeIdx: 1 },
	};
	const cfg = cells[placement];
	return (
		<div className={`w-8 h-6 rounded-sm border border-fg-3 ${cfg.box}`}>
			<div className={cfg.activeIdx === 0 ? "bg-accent/70 rounded-sm" : "bg-transparent"} />
			<div className={cfg.activeIdx === 1 ? "bg-accent/70 rounded-sm" : "bg-transparent"} />
		</div>
	);
}

function RunnerChip({ runner, pkg, onSelect }: { runner: ScriptRunner; pkg: PackageScripts; onSelect: (r: ScriptRunner) => void }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		function onClickOutside(e: MouseEvent) {
			if (!ref.current?.contains(e.target as Node)) setOpen(false);
		}
		if (open) document.addEventListener("mousedown", onClickOutside);
		return () => document.removeEventListener("mousedown", onClickOutside);
	}, [open]);
	const title = pkg.runnerAutoDetected && pkg.lockfiles[0]
		? t("scripts.dropdown.runner.tooltip", { lockfile: pkg.lockfiles[0] })
		: t("scripts.dropdown.runner.fallback");
	return (
		<div ref={ref} className="relative">
			<button
				onClick={() => setOpen((o) => !o)}
				className="text-[0.6875rem] px-1.5 py-0.5 rounded bg-elevated border border-edge text-fg-2 hover:bg-elevated-hover"
				title={title}
			>
				{runner} ▾
			</button>
			{open && (
				<div className="absolute right-0 top-full mt-1 bg-overlay border border-edge-active rounded-lg shadow-xl py-1 min-w-[5rem] z-10">
					{(["bun", "pnpm", "yarn", "npm"] as ScriptRunner[]).map((r) => (
						<button
							key={r}
							onClick={() => { onSelect(r); setOpen(false); }}
							className={`block w-full text-left px-3 py-1 text-xs ${r === runner ? "text-accent" : "text-fg-2"} hover:bg-elevated-hover`}
						>
							{r}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
