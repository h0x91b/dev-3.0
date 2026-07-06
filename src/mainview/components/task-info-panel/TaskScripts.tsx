import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import fuzzysort from "fuzzysort";
import type {
	Project,
	ScriptPlacement,
	ScriptRunner,
	ScriptSource,
	Task,
	WorktreeScripts,
} from "../../../shared/types";
import { SCRIPT_PLACEMENTS, scriptStorageKey } from "../../../shared/types";
import { api } from "../../rpc";
import { useT } from "../../i18n";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import Tooltip from "../Tooltip";
import { ScriptsIcon } from "../TaskIcons";

const DEFAULT_PLACEMENT_IDX = SCRIPT_PLACEMENTS.indexOf("right");

interface TaskScriptsProps {
	task: Task;
	project: Project;
	isTaskActive: boolean;
}

interface DropdownPosition {
	top: number;
	left: number;
}

/** A single runnable row: an npm script or a Makefile target. */
interface RunnableEntry {
	name: string;
	command: string;
	source: ScriptSource;
}

interface PickerTarget {
	name: string;
	source: ScriptSource;
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
	const searchRef = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<DropdownPosition>({ top: 0, left: 0 });
	const [data, setData] = useState<WorktreeScripts | null>(null);
	const [runner, setRunner] = useState<ScriptRunner | null>(null);
	const [pickerFor, setPickerFor] = useState<PickerTarget | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [activeIdx, setActiveIdx] = useState(0);
	const [placementIdx, setPlacementIdx] = useState(0);
	const placementIdxRef = useRef(0);
	placementIdxRef.current = placementIdx;
	const taskRef = useRef(task);
	taskRef.current = task;

	const refresh = useCallback(async () => {
		try {
			const fn = api.request.parseRunnableScripts;
			if (!fn) return;
			const d = await fn({ taskId: task.id, projectId: project.id });
			setData(d);
			setRunner((prev) => prev ?? d.package.runner);
		} catch (err) {
			setError(String(err));
		}
	}, [task.id, project.id]);

	useEffect(() => {
		if (open) refresh();
	}, [open, refresh]);

	useEscapeKey(
		() => {
			if (pickerFor) setPickerFor(null);
			else setOpen(false);
		},
		{ enabled: open },
	);

	// Merge package.json scripts and Makefile targets into one tagged list.
	const entries = useMemo<RunnableEntry[]>(() => {
		if (!data) return [];
		const pkg = data.package.exists
			? data.package.scripts.map((s) => ({ ...s, source: "package" as const }))
			: [];
		const mk = data.makefile.exists
			? data.makefile.targets.map((tgt) => ({ ...tgt, source: "make" as const }))
			: [];
		return [...pkg, ...mk];
	}, [data]);

	const pkgHasScripts = !!data?.package.exists && data.package.scripts.length > 0;
	const mkHasTargets = !!data?.makefile.exists && data.makefile.targets.length > 0;
	const anyRunnable = entries.length > 0;
	// True only once we've fetched and confirmed nothing is runnable — drives the
	// disabled button tooltip without flashing it before the first parse lands.
	const knownEmpty = !!data && !anyRunnable;

	// Auto-focus the search input as soon as the dropdown opens (and not in picker mode).
	// On the very first open `data` is still null while parseRunnableScripts runs, so the
	// input isn't mounted yet — we also re-run once the input becomes available.
	useEffect(() => {
		if (open && !pickerFor && anyRunnable) {
			const timer = setTimeout(() => searchRef.current?.focus(), 0);
			return () => clearTimeout(timer);
		}
	}, [open, pickerFor, anyRunnable]);

	// Sort: most recently run first, then keep source/file order for the rest.
	const sortedScripts = useMemo(() => {
		const lastRun = task.scriptLastRunAt ?? {};
		const indexed = entries.map((s, i) => ({
			s,
			i,
			ts: lastRun[scriptStorageKey(s.source, s.name)] ?? "",
		}));
		indexed.sort((a, b) => {
			if (a.ts && !b.ts) return -1;
			if (!a.ts && b.ts) return 1;
			if (a.ts && b.ts && a.ts !== b.ts) return a.ts > b.ts ? -1 : 1;
			return a.i - b.i;
		});
		return indexed.map((x) => x.s);
	}, [entries, task.scriptLastRunAt]);

	// Apply fuzzy filter on top of the sorted list.
	const filteredScripts = useMemo(() => {
		if (!query.trim()) return sortedScripts;
		const targets = sortedScripts.map((s) => ({ ...s, key: `${s.name} ${s.command} ${s.source}` }));
		const results = fuzzysort.go(query, targets, { key: "key", threshold: -10000 });
		return results.map((r) => ({ name: r.obj.name, command: r.obj.command, source: r.obj.source }));
	}, [query, sortedScripts]);

	// Clamp active index whenever the filtered list changes.
	useEffect(() => {
		setActiveIdx((i) => {
			if (filteredScripts.length === 0) return 0;
			return Math.min(i, filteredScripts.length - 1);
		});
	}, [filteredScripts.length]);

	function openDropdown() {
		if (!isTaskActive) return;
		const rect = btnRef.current?.getBoundingClientRect();
		if (!rect) return;
		const width = 380;
		setPos({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) });
		setOpen(true);
		setPickerFor(null);
		setQuery("");
		setActiveIdx(0);
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
		window.addEventListener("menu:task-run-script", onOpenDropdown);
		return () => {
			window.removeEventListener("menu:task-run-script", onOpenDropdown);
		};
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [task.id, isTaskActive]);

	async function launch(name: string, source: ScriptSource, placement: ScriptPlacement) {
		setBusy(true);
		setError(null);
		try {
			await api.request.runScript({
				taskId: task.id,
				projectId: project.id,
				scriptName: name,
				placement,
				source,
				runner: source === "package" ? (runner ?? data?.package.runner) : undefined,
			});
			closeDropdown();
		} catch (err) {
			setError(t("scripts.error.runFailed", { name, error: String(err) }));
		} finally {
			setBusy(false);
		}
	}

	useEffect(() => {
		if (!pickerFor) return;
		// Read the last placement off the latest task ref so a server-side echo of
		// scriptLastPlacement doesn't reset the user's mid-picker arrow key navigation.
		const last = taskRef.current.scriptLastPlacement?.[scriptStorageKey(pickerFor.source, pickerFor.name)];
		const idx = last ? SCRIPT_PLACEMENTS.indexOf(last) : -1;
		setPlacementIdx(idx >= 0 ? idx : DEFAULT_PLACEMENT_IDX);
	}, [pickerFor]);

	useEffect(() => {
		if (!open || !pickerFor) return;
		const { name, source } = pickerFor;
		// Arm Enter on the next tick so the keystroke that *opened* the picker
		// (typed in the search input) doesn't also fire launch here.
		let armed = false;
		const armId = setTimeout(() => { armed = true; }, 0);
		// Move focus away from any newly-mounted picker button so a focused
		// button doesn't turn Enter into a synthetic click → launch.
		(document.activeElement as HTMLElement | null)?.blur?.();
		function onKey(e: KeyboardEvent) {
			if (e.key === "ArrowLeft") {
				e.preventDefault();
				setPlacementIdx((i) => Math.max(0, i - 1));
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				setPlacementIdx((i) => Math.min(SCRIPT_PLACEMENTS.length - 1, i + 1));
			} else if (e.key === "Enter") {
				if (!armed) return;
				e.preventDefault();
				const p = SCRIPT_PLACEMENTS[placementIdxRef.current];
				if (p) void launch(name, source, p);
			}
		}
		document.addEventListener("keydown", onKey);
		return () => {
			clearTimeout(armId);
			document.removeEventListener("keydown", onKey);
		};
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, pickerFor]);

	function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActiveIdx((i) => Math.min(i + 1, filteredScripts.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActiveIdx((i) => Math.max(i - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			const picked = filteredScripts[activeIdx];
			if (picked) setPickerFor({ name: picked.name, source: picked.source });
		}
	}

	function headerText(): string {
		if (pkgHasScripts && mkHasTargets) {
			return t("scripts.dropdown.headerBoth", {
				scripts: data!.package.scripts.length,
				targets: data!.makefile.targets.length,
			});
		}
		if (pkgHasScripts) return t("scripts.dropdown.header", { count: data!.package.scripts.length });
		if (mkHasTargets) return t("scripts.dropdown.headerMake", { count: data!.makefile.targets.length });
		// Nothing runnable — surface the most informative reason.
		const pkgErr = data?.package.error;
		if (pkgErr?.startsWith("parse-failed")) return t("scripts.empty.parseError", { error: pkgErr });
		if (data?.package.exists && pkgErr === "no-scripts" && !data.makefile.exists) {
			return t("scripts.empty.noScripts");
		}
		return t("scripts.empty.none");
	}

	const pickedEntry = pickerFor
		? entries.find((e) => e.name === pickerFor.name && e.source === pickerFor.source)
		: null;

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
						{pickerFor ? t("scripts.picker.title", { name: pickerFor.name }) : headerText()}
					</div>
					{pkgHasScripts && !pickerFor && data && (
						<RunnerChip
							runner={runner ?? data.package.runner}
							pkg={data.package}
							onSelect={setRunner}
						/>
					)}
				</div>
				{data?.package.multipleLockfiles && !pickerFor && (
					<div className="flex-shrink-0 px-3 py-1.5 text-xs text-warning bg-warning/10 border-b border-warning/20">
						⚠ {t("scripts.warning.multipleLockfiles")}: {data.package.lockfiles.join(", ")}
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
						<div className="text-xs text-fg-2 mb-1">{pickerFor.name}</div>
						<div className="text-[0.6875rem] text-fg-3 font-mono mb-3 truncate">
							{pickedEntry?.command}
						</div>
						<div className="grid grid-cols-5 gap-1.5">
							{SCRIPT_PLACEMENTS.map((p, idx) => (
								<Tooltip key={p} content={placementLabel(t, p)}>
									<button
										onClick={() => launch(pickerFor.name, pickerFor.source, p)}
										onMouseEnter={() => setPlacementIdx(idx)}
										disabled={busy}
										className={`flex flex-col items-center gap-1.5 px-2 py-3 rounded-lg transition-colors disabled:opacity-50 ${
											idx === placementIdx
												? "bg-accent/15 border border-accent"
												: "bg-elevated border border-edge hover:border-accent hover:bg-accent/10"
										}`}
									>
										<PlacementGlyph placement={p} />
										<span className="text-[0.625rem] text-fg-2">{placementLabel(t, p)}</span>
									</button>
								</Tooltip>
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
						{/* Search input */}
						{anyRunnable && (
							<div className="flex-shrink-0 px-3 py-2 border-b border-edge">
								<input
									ref={searchRef}
									type="text"
									value={query}
									onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
									onKeyDown={onSearchKey}
									placeholder={t("scripts.search.placeholder")}
									className="w-full bg-base border border-edge rounded-lg px-2.5 py-1.5 text-sm text-fg placeholder:text-fg-muted focus:outline-none focus:border-accent"
								/>
							</div>
						)}

						{/* Scrollable list */}
						<div className="overflow-y-auto py-1 min-h-0">
							{filteredScripts.length === 0 && query.trim() && (
								<div className="px-3 py-4 text-xs text-fg-3 text-center">
									{t("scripts.search.noMatches")}
								</div>
							)}
							{filteredScripts.map((s, idx) => (
								<button
									key={`${s.source}:${s.name}`}
									onClick={() => setPickerFor({ name: s.name, source: s.source })}
									onMouseEnter={() => setActiveIdx(idx)}
									disabled={busy}
									className={`w-full text-left px-3 py-1.5 flex items-center gap-2 transition-colors disabled:opacity-50 ${idx === activeIdx ? "bg-elevated" : "hover:bg-elevated"}`}
								>
									<span className="flex flex-col min-w-0 flex-1">
										<span className="text-sm text-fg font-medium truncate">{s.name}</span>
										{s.command && <span className="text-xs text-fg-3 truncate">{s.command}</span>}
									</span>
									<span className="flex-shrink-0 text-[0.625rem] px-1 py-0.5 rounded border border-edge text-fg-3 font-mono">
										{s.source === "make" ? "make" : (runner ?? data?.package.runner)}
									</span>
								</button>
							))}
						</div>
					</>
				)}
			</div>
		</>,
		document.body,
	) : null;

	return (
		<>
			<Tooltip content={knownEmpty ? t("scripts.tooltip.disabled") : t("scripts.tooltip")} detail={t("ttip.scripts.run")}>
				<button
					ref={btnRef}
					onClick={openDropdown}
					disabled={!isTaskActive}
					className={`task-anim flex items-center justify-center px-2 py-1 rounded-lg transition-colors flex-shrink-0 ${
						!isTaskActive
							? "text-fg-muted/50 cursor-not-allowed border border-edge/40"
							: "text-success hover:text-success-hover hover:bg-success/15 border border-success/30"
					}`}
					aria-label={t("scripts.button")}
				>
					<ScriptsIcon className="w-[1.125rem] h-[1.125rem]" />
				</button>
			</Tooltip>
			{dropdown}
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

function RunnerChip({ runner, pkg, onSelect }: { runner: ScriptRunner; pkg: WorktreeScripts["package"]; onSelect: (r: ScriptRunner) => void }) {
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
			<Tooltip content={title}>
				<button
					onClick={() => setOpen((o) => !o)}
					className="text-[0.6875rem] px-1.5 py-0.5 rounded bg-elevated border border-edge text-fg-2 hover:bg-elevated-hover"
				>
					{runner} ▾
				</button>
			</Tooltip>
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
