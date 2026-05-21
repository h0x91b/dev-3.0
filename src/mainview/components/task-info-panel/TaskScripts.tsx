import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
	PackageScripts,
	Project,
	ScriptPlacement,
	ScriptRunner,
	ScriptState,
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

const PLACEMENT_GLYPH: Record<ScriptPlacement, string> = {
	left: "←",
	top: "↑",
	right: "→",
	bottom: "↓",
	window: "⊞",
};

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
	const [states, setStates] = useState<ScriptState[]>([]);
	const [runner, setRunner] = useState<ScriptRunner | null>(null);
	const [pickerFor, setPickerFor] = useState<{ scriptName: string; firstTime: boolean } | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [batchOpen, setBatchOpen] = useState(false);

	const runningCount = useMemo(() => states.filter((s) => s.status === "running").length, [states]);
	const failedScript = useMemo(() => states.find((s) => s.status === "failed"), [states]);

	const refresh = useCallback(async () => {
		try {
			const parseFn = api.request.parsePackageScripts;
			const statesFn = api.request.getScriptStates;
			if (!parseFn || !statesFn) return;
			const [p, s] = await Promise.all([
				parseFn({ taskId: task.id, projectId: project.id }),
				statesFn({ taskId: task.id }),
			]);
			setPkg(p);
			setRunner((prev) => prev ?? p.runner);
			setStates(s);
		} catch (err) {
			setError(String(err));
		}
	}, [task.id, project.id]);

	useEffect(() => {
		// Initial fetch — light: state only, no parsePackageScripts until user opens.
		const fn = api.request.getScriptStates;
		if (!fn) return;
		fn({ taskId: task.id }).then(setStates).catch(() => {});
	}, [task.id]);

	useEffect(() => {
		function onStateChange(e: Event) {
			const detail = (e as CustomEvent).detail as { taskId: string; states: ScriptState[] };
			if (detail.taskId === task.id) setStates(detail.states);
		}
		window.addEventListener("rpc:scriptStateChanged", onStateChange);
		return () => window.removeEventListener("rpc:scriptStateChanged", onStateChange);
	}, [task.id]);

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

	useEffect(() => {
		if (open) refresh();
	}, [open, refresh]);

	useEffect(() => {
		if (!open) return;
		// Click-outside handled by the backdrop element rendered with the popover.
		// We only need keyboard Escape support at the document level.
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

	const stateByName = useMemo(() => {
		const m = new Map<string, ScriptState>();
		for (const s of states) m.set(s.scriptName, s);
		return m;
	}, [states]);

	function openDropdown() {
		if (!isTaskActive) return;
		const rect = btnRef.current?.getBoundingClientRect();
		if (!rect) return;
		const width = 380;
		setPos({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) });
		setOpen(true);
	}

	function effectivePlacement(scriptName: string): ScriptPlacement | null {
		const ov = task.scriptPlacement?.overrides?.[scriptName];
		if (ov) return ov;
		return task.scriptPlacement?.default ?? null;
	}

	async function launch(scriptName: string, placement: ScriptPlacement) {
		setBusy(scriptName);
		setError(null);
		try {
			await api.request.runScript({
				taskId: task.id,
				projectId: project.id,
				scriptName,
				placement,
				runner: runner ?? pkg?.runner,
			});
			// Server emits scriptStateChanged; we also refresh placement memory by reloading task indirectly.
		} catch (err) {
			setError(t("scripts.error.runFailed", { name: scriptName, error: String(err) }));
		} finally {
			setBusy(null);
		}
	}

	async function onRowClick(scriptName: string) {
		const state = stateByName.get(scriptName);
		if (state?.status === "running" && state.paneId) {
			try {
				await api.request.focusScriptPane({ taskId: task.id, scriptName });
			} catch {
				/* noop */
			}
			return;
		}
		const placement = effectivePlacement(scriptName);
		const noTaskDefault = !task.scriptPlacement?.default;
		if (!placement || noTaskDefault) {
			setPickerFor({ scriptName, firstTime: noTaskDefault });
			return;
		}
		await launch(scriptName, placement);
	}

	function onPickerConfirm(placement: ScriptPlacement) {
		const target = pickerFor;
		setPickerFor(null);
		if (target) void launch(target.scriptName, placement);
	}

	async function onStop(scriptName: string) {
		try {
			await api.request.stopScript({ taskId: task.id, scriptName });
		} catch {
			/* noop */
		}
	}

	async function onKill(scriptName: string) {
		try {
			await api.request.killScriptPane({ taskId: task.id, scriptName });
		} catch {
			/* noop */
		}
	}

	async function onResetPlacement(scriptName: string) {
		try {
			await api.request.setTaskScriptPlacement({
				taskId: task.id,
				projectId: project.id,
				override: { scriptName, placement: null },
			});
		} catch {
			/* noop */
		}
	}

	// Button content / state
	const buttonState = (() => {
		if (!pkg && !states.length) return "neutral" as const;
		if (failedScript) return "failed" as const;
		if (runningCount > 0) return "running" as const;
		return "neutral" as const;
	})();

	const buttonLabel = (() => {
		if (buttonState === "failed" && failedScript) {
			return t("scripts.button.failed", { name: failedScript.scriptName });
		}
		if (buttonState === "running") {
			return t.plural("scripts.button.running", runningCount, { count: runningCount });
		}
		return t("scripts.button");
	})();

	const buttonTitle = (() => {
		if (pkg && pkg.exists === false) return t("scripts.tooltip.disabled");
		return t("scripts.tooltip");
	})();

	const colorClass = (() => {
		if (buttonState === "failed") return "text-danger border-danger/30 hover:bg-danger/15";
		if (buttonState === "running") return "text-success border-success/30 hover:bg-success/15";
		return "text-fg-3 border-edge hover:bg-elevated hover:text-fg";
	})();

	function closeDropdown() {
		setOpen(false);
		setPickerFor(null);
	}

	const dropdown = open ? createPortal(
		<>
			{/* Backdrop captures clicks anywhere outside the popover (including over WKWebView terminals) */}
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
						{pkg?.exists
							? t("scripts.dropdown.header", { count: pkg.scripts.length })
							: pkg?.error === "no-package-json"
								? t("scripts.empty.noPackageJson")
								: pkg?.error === "no-scripts"
									? t("scripts.empty.noScripts")
									: pkg?.error?.startsWith("parse-failed")
										? t("scripts.empty.parseError", { error: pkg.error })
										: t("scripts.empty.noPackageJson")}
					</div>
					{pkg?.exists && (
						<RunnerChip
							runner={runner ?? pkg.runner}
							pkg={pkg}
							onSelect={setRunner}
						/>
					)}
				</div>
				{pkg?.multipleLockfiles && (
					<div className="flex-shrink-0 px-3 py-1.5 text-xs text-warning bg-warning/10 border-b border-warning/20">
						⚠ {t("scripts.warning.multipleLockfiles")}: {pkg.lockfiles.join(", ")}
					</div>
				)}
				{error && (
					<div className="flex-shrink-0 px-3 py-1.5 text-xs text-danger bg-danger/10 border-b border-danger/20">
						{error}
					</div>
				)}

				{/* Scrollable body */}
				<div className="overflow-y-auto py-1 min-h-0">
					{/* Running section */}
					{states.filter((s) => s.status === "running").length > 0 && (
						<>
							<div className="px-3 py-1.5 text-[0.625rem] uppercase tracking-wider font-semibold text-fg-3">
								{t("scripts.section.running")}
							</div>
							{states.filter((s) => s.status === "running").map((s) => (
								<RunningRow
									key={s.scriptName}
									state={s}
									t={t}
									onFocus={() => onRowClick(s.scriptName)}
									onStop={() => onStop(s.scriptName)}
									onKill={() => onKill(s.scriptName)}
								/>
							))}
						</>
					)}

					{/* Scripts section */}
					{pkg?.scripts && pkg.scripts.length > 0 && (
						<>
							<div className="px-3 py-1.5 mt-1 text-[0.625rem] uppercase tracking-wider font-semibold text-fg-3 border-t border-edge">
								{t("scripts.section.scripts")}
							</div>
							{pkg.scripts.map((s) => (
								<ScriptRow
									key={s.name}
									name={s.name}
									command={s.command}
									state={stateByName.get(s.name)}
									lastPlacement={effectivePlacement(s.name)}
									busy={busy === s.name}
									onClick={() => onRowClick(s.name)}
									onRunIn={() => setPickerFor({ scriptName: s.name, firstTime: false })}
									onStop={() => onStop(s.name)}
									onKill={() => onKill(s.name)}
									onResetPlacement={() => onResetPlacement(s.name)}
									t={t}
								/>
							))}
						</>
					)}
				</div>

				{/* Sticky inline picker (does not scroll away) */}
				{pickerFor && (
					<div className="flex-shrink-0 border-t border-edge px-3 py-3 bg-raised">
						<div className="text-xs text-fg-2 mb-2">
							{pickerFor.firstTime
								? t("scripts.picker.titleFirstTime")
								: t("scripts.picker.title", { name: pickerFor.scriptName })}
						</div>
						<div className="flex items-center gap-1.5">
							{SCRIPT_PLACEMENTS.map((p) => (
								<button
									key={p}
									onClick={() => onPickerConfirm(p)}
									className="flex-1 flex flex-col items-center gap-1 px-2 py-2 rounded-lg bg-elevated border border-edge hover:border-accent hover:bg-accent/10 transition-colors"
									title={placementLabel(t, p)}
								>
									<PlacementGlyph placement={p} />
									<span className="text-[0.625rem] text-fg-3">{placementLabel(t, p)}</span>
								</button>
							))}
						</div>
					</div>
				)}

				{/* Sticky footer */}
				{pkg?.exists && pkg.scripts.length > 0 && (
					<div className="flex-shrink-0 border-t border-edge px-3 py-2 flex items-center justify-between">
						<button
							onClick={() => { setBatchOpen(true); setOpen(false); }}
							className="text-xs text-accent hover:text-accent-hover font-medium"
						>
							{t("scripts.footer.runMultiple")}
						</button>
					</div>
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
				className={`flex items-center gap-1 px-2 py-1 rounded-lg border transition-colors flex-shrink-0 ${colorClass}`}
				title={buttonTitle}
			>
				<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'", fontSize: "0.875rem", lineHeight: 1 }}>
					{"\u{F040A}"}
				</span>
				<span className="text-[0.6875rem] font-semibold whitespace-nowrap">{buttonLabel}</span>
				{buttonState === "running" && (
					<span className="w-1.5 h-1.5 rounded-full bg-success ml-0.5" />
				)}
			</button>
			{dropdown}
			{batchOpen && pkg?.exists && (
				<RunScriptsBatchModal
					task={task}
					project={project}
					pkg={pkg}
					runner={runner ?? pkg.runner}
					states={states}
					onClose={() => setBatchOpen(false)}
				/>
			)}
		</>
	);
}

function PlacementGlyph({ placement }: { placement: ScriptPlacement }) {
	const cells: Record<ScriptPlacement, { box: string; fill: string }> = {
		left: { box: "grid grid-cols-2 gap-px", fill: "left" },
		right: { box: "grid grid-cols-2 gap-px", fill: "right" },
		top: { box: "grid grid-rows-2 gap-px", fill: "top" },
		bottom: { box: "grid grid-rows-2 gap-px", fill: "bottom" },
		window: { box: "", fill: "window" },
	};
	const cfg = cells[placement];
	if (placement === "window") {
		return (
			<div className="w-7 h-5 rounded-sm border border-fg-3 flex items-center justify-center">
				<span className="text-[0.6rem] text-fg-3">+</span>
			</div>
		);
	}
	return (
		<div className={`w-7 h-5 rounded-sm border border-fg-3 ${cfg.box}`}>
			<div className={cfg.fill === "left" || cfg.fill === "top" ? "bg-accent/70 rounded-sm" : "bg-transparent"} />
			<div className={cfg.fill === "right" || cfg.fill === "bottom" ? "bg-accent/70 rounded-sm" : "bg-transparent"} />
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

function RunningRow({
	state,
	onFocus,
	onStop,
	onKill,
	t,
}: {
	state: ScriptState;
	onFocus: () => void;
	onStop: () => void;
	onKill: () => void;
	t: ReturnType<typeof useT>;
}) {
	return (
		<div className="px-3 py-1.5 flex items-center gap-2 hover:bg-elevated transition-colors group">
			<span className="w-2 h-2 rounded-full bg-success flex-shrink-0" />
			<button onClick={onFocus} className="flex-1 min-w-0 text-left flex items-center gap-2">
				<span className="text-sm text-fg font-medium truncate">{state.scriptName}</span>
				<span className="text-xs text-fg-3 truncate">{state.command}</span>
			</button>
			<span className="text-xs text-fg-3 opacity-60 group-hover:opacity-100">{PLACEMENT_GLYPH[state.placement]}</span>
			<button
				onClick={onFocus}
				className="text-[0.625rem] px-1.5 py-0.5 rounded border border-edge text-fg-3 hover:text-fg hover:border-edge-active opacity-0 group-hover:opacity-100 transition-opacity"
			>
				{t("scripts.action.focus")}
			</button>
			<button
				onClick={onStop}
				className="text-[0.625rem] px-1.5 py-0.5 rounded border border-edge text-fg-3 hover:text-danger hover:border-danger/40 opacity-0 group-hover:opacity-100 transition-opacity"
			>
				{t("scripts.action.stop")}
			</button>
			<button
				onClick={onKill}
				className="text-[0.625rem] px-1 text-fg-3 hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity"
				title={t("scripts.action.kill")}
				style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
			>
				{""}
			</button>
		</div>
	);
}

function ScriptRow({
	name,
	command,
	state,
	lastPlacement,
	busy,
	onClick,
	onRunIn,
	onStop,
	onKill,
	onResetPlacement,
	t,
}: {
	name: string;
	command: string;
	state: ScriptState | undefined;
	lastPlacement: ScriptPlacement | null;
	busy: boolean;
	onClick: () => void;
	onRunIn: () => void;
	onStop: () => void;
	onKill: () => void;
	onResetPlacement: () => void;
	t: ReturnType<typeof useT>;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		function onClickOutside(e: MouseEvent) {
			if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
		}
		if (menuOpen) document.addEventListener("mousedown", onClickOutside);
		return () => document.removeEventListener("mousedown", onClickOutside);
	}, [menuOpen]);

	const isRunning = state?.status === "running";
	return (
		<div className="px-3 py-1.5 flex items-center gap-2 hover:bg-elevated transition-colors group">
			<button
				onClick={onClick}
				onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true); }}
				disabled={busy}
				className="flex-1 min-w-0 text-left flex flex-col disabled:opacity-50"
			>
				<div className="flex items-center gap-2">
					<span className="text-sm text-fg font-medium truncate">{name}</span>
					{isRunning && <span className="text-[0.625rem] text-success">●</span>}
				</div>
				<span className="text-xs text-fg-3 truncate">{command}</span>
			</button>
			{lastPlacement && (
				<span className="text-xs text-fg-3 opacity-60" title={t("scripts.row.lastPlacement", { placement: lastPlacement })}>
					{PLACEMENT_GLYPH[lastPlacement]}
				</span>
			)}
			<div ref={menuRef} className="relative">
				<button
					onClick={() => setMenuOpen((o) => !o)}
					className="px-1 text-fg-3 hover:text-fg opacity-0 group-hover:opacity-100 transition-opacity"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{"\u{F01D9}"}
				</button>
				{menuOpen && (
					<div className="absolute right-0 top-full mt-1 bg-overlay border border-edge-active rounded-lg shadow-xl py-1 min-w-[10rem] z-10 text-xs">
						<button
							onClick={() => { setMenuOpen(false); onClick(); }}
							className="block w-full text-left px-3 py-1.5 text-fg-2 hover:bg-elevated-hover"
						>
							{t("scripts.action.run")}
						</button>
						<button
							onClick={() => { setMenuOpen(false); onRunIn(); }}
							className="block w-full text-left px-3 py-1.5 text-fg-2 hover:bg-elevated-hover"
						>
							{t("scripts.action.runIn")}
						</button>
						{isRunning && (
							<>
								<button
									onClick={() => { setMenuOpen(false); onStop(); }}
									className="block w-full text-left px-3 py-1.5 text-danger hover:bg-elevated-hover"
								>
									{t("scripts.action.stop")}
								</button>
								<button
									onClick={() => { setMenuOpen(false); onKill(); }}
									className="block w-full text-left px-3 py-1.5 text-danger hover:bg-elevated-hover"
								>
									{t("scripts.action.kill")}
								</button>
							</>
						)}
						{lastPlacement && (
							<button
								onClick={() => { setMenuOpen(false); onResetPlacement(); }}
								className="block w-full text-left px-3 py-1.5 text-fg-3 hover:bg-elevated-hover border-t border-edge mt-1 pt-1.5"
							>
								{t("scripts.action.resetPlacement")}
							</button>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
