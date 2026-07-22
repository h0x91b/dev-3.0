import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
} from "react";
import {
	activatePane,
	closePane,
	createSplitTree,
	focusPane,
	listPaneIds,
	restoreSplitTree,
	serializeSplitTree,
	setSplitRatio,
	splitPane,
	toggleZoom,
	unzoomPane,
	type SplitBranchNode,
	type SplitDirection,
	type SplitNode,
	type SplitTree,
} from "../../../shared/split-tree";
import { useNarrowViewport } from "../../hooks/useNarrowViewport";
import { useT, type TFunction } from "../../i18n";
import { formatBytes } from "../../utils/formatBytes";
import { FakeTerminalRegistry, type FakeTerminalSession } from "./fake-terminal";
import { runFakeTerminalStress, type FakeTerminalStressResult } from "./stress";

const NARROW_BREAKPOINT = 768;
const CONTROL_CLASS = "h-8 shrink-0 px-3 rounded-md border border-edge bg-elevated text-fg-2 text-xs font-medium hover:bg-elevated-hover hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed transition-colors";
const ICON_CONTROL_CLASS = "size-8 shrink-0 rounded-md border border-edge bg-elevated text-fg-2 text-sm hover:bg-elevated-hover hover:text-fg transition-colors";

interface NativePaneLayoutLabProps {
	navigate: (route: { screen: "dashboard" }) => void;
	registry?: FakeTerminalRegistry;
}

interface PaneParent {
	branch: SplitBranchNode;
	side: "first" | "second";
}

function findPaneParent(node: SplitNode, paneId: string, parent: PaneParent | null = null): PaneParent | null {
	if (node.type === "pane") return node.id === paneId ? parent : null;
	return findPaneParent(node.first, paneId, { branch: node, side: "first" })
		?? findPaneParent(node.second, paneId, { branch: node, side: "second" });
}

export function buildLabTree(paneCount: 1 | 2 | 6): SplitTree {
	let tree = createSplitTree();
	if (paneCount >= 2) tree = splitPane(tree, "pane-1", "horizontal");
	if (paneCount === 6) {
		tree = splitPane(tree, "pane-1", "vertical");
		tree = splitPane(tree, "pane-2", "vertical");
		tree = splitPane(tree, "pane-3", "vertical");
		tree = splitPane(tree, "pane-4", "vertical");
		tree = setSplitRatio(tree, "split-2", 1 / 3);
		tree = setSplitRatio(tree, "split-3", 1 / 3);
	}
	return activatePane(tree, "pane-1");
}

function FakeTerminalPane({
	session,
	active,
	onActivate,
	t,
}: {
	session: FakeTerminalSession;
	active: boolean;
	onActivate: () => void;
	t: TFunction;
}) {
	const [lines, setLines] = useState<readonly string[]>([]);
	const [input, setInput] = useState("");
	const [size, setSize] = useState(() => session.getSize());
	const containerRef = useRef<HTMLDivElement>(null);
	const outputRef = useRef<HTMLDivElement>(null);

	useEffect(() => session.subscribeOutput(() => {
		setLines([...session.getOutputLines()]);
	}), [session]);

	useEffect(() => session.subscribeResize(setSize), [session]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(([entry]) => {
			if (!entry) return;
			const columns = Math.floor(entry.contentRect.width / 8);
			const rows = Math.floor(Math.max(18, entry.contentRect.height - 76) / 18);
			session.resize(columns, rows);
		});
		observer.observe(container);
		return () => observer.disconnect();
	}, [session]);

	useEffect(() => {
		const output = outputRef.current;
		if (output) output.scrollTop = output.scrollHeight;
	}, [lines]);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!input) return;
		session.writeInput(input);
		setInput("");
	};

	return (
		<div
			ref={containerRef}
			data-testid={`fake-pane-${session.paneId}`}
			data-stream-id={session.streamId}
			data-active={active ? "true" : "false"}
			onClick={onActivate}
			className={`min-h-0 min-w-0 h-full w-full flex flex-col overflow-hidden rounded-lg border bg-base shadow-sm transition-colors ${
				active ? "border-accent ring-1 ring-accent/40" : "border-edge hover:border-edge-active"
			}`}
		>
			<div className="h-8 shrink-0 flex items-center gap-2 px-2.5 border-b border-edge bg-raised text-xs">
				<span className={`size-2 rounded-full ${active ? "bg-accent" : "bg-fg-muted/40"}`} aria-hidden="true" />
				<span className="font-semibold text-fg">{session.paneId}</span>
				<span className="ml-auto text-fg-muted font-mono">{size.columns}×{size.rows}</span>
			</div>
			<div
				ref={outputRef}
				data-testid={`fake-output-${session.paneId}`}
				className="flex-1 min-h-0 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-[1.45] text-fg-2 whitespace-pre-wrap break-all"
				aria-label={t("nativePaneLab.stream", { streamId: session.streamId })}
			>
				{lines.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}
			</div>
			<form onSubmit={submit} className="shrink-0 flex items-center gap-1.5 p-1.5 border-t border-edge bg-raised">
				<input
					value={input}
					onChange={(event) => setInput(event.target.value)}
					aria-label={t("nativePaneLab.input", { paneId: session.paneId })}
					placeholder={t("nativePaneLab.inputPlaceholder")}
					className="min-w-0 flex-1 h-7 rounded border border-edge bg-base px-2 font-mono text-xs text-fg placeholder:text-fg-muted"
				/>
				<button
					type="submit"
					aria-label={t("nativePaneLab.send", { paneId: session.paneId })}
					className="size-7 rounded bg-accent text-white hover:bg-accent-hover text-sm"
				>
					{"↵"}
				</button>
			</form>
		</div>
	);
}

function formatMemoryDelta(value: number | null, unavailable: string): string {
	if (value === null) return unavailable;
	return `${value >= 0 ? "+" : "−"}${formatBytes(Math.abs(value))}`;
}

export default function NativePaneLayoutLab({ navigate, registry: injectedRegistry }: NativePaneLayoutLabProps) {
	const t = useT();
	const narrow = useNarrowViewport(NARROW_BREAKPOINT);
	const ownedRegistryRef = useRef<FakeTerminalRegistry | null>(null);
	if (!ownedRegistryRef.current) ownedRegistryRef.current = new FakeTerminalRegistry();
	const registry = injectedRegistry ?? ownedRegistryRef.current;
	const [tree, setTree] = useState<SplitTree>(() => buildLabTree(1));
	const [savedSnapshot, setSavedSnapshot] = useState(() => serializeSplitTree(buildLabTree(1)));
	const [viewEpoch, setViewEpoch] = useState(0);
	const [stressRunning, setStressRunning] = useState(false);
	const [stressResult, setStressResult] = useState<FakeTerminalStressResult | null>(null);
	const mountedRef = useRef(true);
	const stressAbortRef = useRef<AbortController | null>(null);
	const paneIds = useMemo(() => listPaneIds(tree).sort((first, second) => {
		const firstOrdinal = Number(/^pane-(\d+)$/.exec(first)?.[1] ?? Number.MAX_SAFE_INTEGER);
		const secondOrdinal = Number(/^pane-(\d+)$/.exec(second)?.[1] ?? Number.MAX_SAFE_INTEGER);
		return firstOrdinal - secondOrdinal || first.localeCompare(second);
	}), [tree]);
	const paneKey = paneIds.join("|");
	const activeIndex = Math.max(0, paneIds.indexOf(tree.activePaneId));
	const parent = findPaneParent(tree.root, tree.activePaneId);
	const activeRatio = parent
		? (parent.side === "first" ? parent.branch.ratio : 1 - parent.branch.ratio)
		: null;

	useEffect(() => {
		registry.reconcile(paneIds);
	}, [registry, paneKey]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			stressAbortRef.current?.abort();
			stressAbortRef.current = null;
			registry.dispose();
		};
	}, [registry]);

	const changeScenario = (count: 1 | 2 | 6) => {
		const next = buildLabTree(count);
		setTree(next);
		setSavedSnapshot(serializeSplitTree(next));
		setStressResult(null);
	};

	const page = useCallback((delta: number) => {
		if (paneIds.length < 2) return;
		const index = (activeIndex + delta + paneIds.length) % paneIds.length;
		setTree((current) => activatePane(current, paneIds[index]));
	}, [activeIndex, paneIds]);

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement;
		if (target !== event.currentTarget && target.closest("input, button, textarea, select")) return;
		if (event.key === "Escape" && tree.zoomedPaneId) {
			event.preventDefault();
			setTree((current) => unzoomPane(current));
			return;
		}
		if (narrow && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
			event.preventDefault();
			page(event.key === "ArrowRight" ? 1 : -1);
			return;
		}
		if (!narrow && event.altKey && event.key.startsWith("Arrow")) {
			const direction = event.key.slice(5).toLowerCase() as SplitDirection;
			event.preventDefault();
			setTree((current) => focusPane(current, direction));
		}
	};

	const renderPane = (paneId: string): ReactNode => (
		<FakeTerminalPane
			key={`${paneId}:${viewEpoch}`}
			session={registry.ensure(paneId)}
			active={tree.activePaneId === paneId}
			onActivate={() => setTree((current) => activatePane(current, paneId))}
			t={t}
		/>
	);

	const renderNode = (node: SplitNode): ReactNode => {
		if (node.type === "pane") return renderPane(node.id);
		return (
			<div
				key={node.id}
				data-split-id={node.id}
				data-split-ratio={String(node.ratio)}
				className={`h-full min-h-0 min-w-0 flex-1 flex gap-1 ${node.orientation === "horizontal" ? "flex-row" : "flex-col"}`}
			>
				<div className="min-h-0 min-w-0" style={{ flexBasis: 0, flexGrow: node.ratio }}>
					{renderNode(node.first)}
				</div>
				<div className="min-h-0 min-w-0" style={{ flexBasis: 0, flexGrow: 1 - node.ratio }}>
					{renderNode(node.second)}
				</div>
			</div>
		);
	};

	const runStress = async () => {
		if (stressRunning) return;
		const controller = new AbortController();
		stressAbortRef.current?.abort();
		stressAbortRef.current = controller;
		setStressRunning(true);
		try {
			const result = await runFakeTerminalStress({}, controller.signal);
			if (mountedRef.current && !result.aborted) setStressResult(result);
		} finally {
			if (stressAbortRef.current === controller) stressAbortRef.current = null;
			if (mountedRef.current) setStressRunning(false);
		}
	};

	const stressCopy = stressResult
		? t("nativePaneLab.stressResult", {
			output: stressResult.events.output,
			input: stressResult.events.input,
			resize: stressResult.events.resize,
			cpu: stressResult.cpu ? `${stressResult.cpu.totalMs.toFixed(1)} ms` : t("nativePaneLab.cpuUnavailable"),
			memory: formatMemoryDelta(stressResult.memory.deltaBytes, t("nativePaneLab.memoryUnavailable")),
			cleanup: t(stressResult.cleanupPassed ? "nativePaneLab.cleanupPassed" : "nativePaneLab.cleanupFailed"),
		})
		: t("nativePaneLab.stressIdle");

	return (
		<div
			data-testid="native-pane-layout-lab"
			data-layout-mode={narrow ? "narrow" : "wide"}
			tabIndex={0}
			onKeyDown={handleKeyDown}
			className="flex-1 min-h-0 flex flex-col overflow-hidden bg-base text-fg"
		>
			<header className="shrink-0 flex flex-wrap items-center gap-3 px-4 py-3 border-b border-edge bg-raised">
				<button type="button" onClick={() => navigate({ screen: "dashboard" })} className="text-sm text-fg-3 hover:text-fg">
					{"← "}{t("nativePaneLab.back")}
				</button>
				<div className="min-w-[12rem] flex-1">
					<h1 className="text-lg font-bold text-fg">{t("nativePaneLab.title")}</h1>
					<p className="text-xs text-fg-3 truncate">{t("nativePaneLab.subtitle")}</p>
				</div>
				<span className="shrink-0 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-[11px] font-semibold text-accent">
					{t("nativePaneLab.fakeOnly")}
				</span>
			</header>

			<div className="shrink-0 space-y-2 px-3 py-2 border-b border-edge bg-raised/70">
				<div className={`flex items-center gap-1.5 ${narrow ? "overflow-x-auto pb-1" : "flex-wrap"}`}>
					<span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">{t("nativePaneLab.scenarios")}</span>
					{([1, 2, 6] as const).map((count) => (
						<button
							key={count}
							type="button"
							onClick={() => changeScenario(count)}
							className={`${CONTROL_CLASS} ${paneIds.length === count ? "border-accent/50 bg-accent/10 text-accent" : ""}`}
						>
							{t(count === 1 ? "nativePaneLab.onePane" : count === 2 ? "nativePaneLab.twoPanes" : "nativePaneLab.sixPanes")}
						</button>
					))}
					<span className="mx-1 h-5 border-l border-edge" aria-hidden="true" />
					<button type="button" onClick={() => setTree((current) => splitPane(current, current.activePaneId, "horizontal"))} className={CONTROL_CLASS}>
						{t("nativePaneLab.splitHorizontal")}
					</button>
					<button type="button" onClick={() => setTree((current) => splitPane(current, current.activePaneId, "vertical"))} className={CONTROL_CLASS}>
						{t("nativePaneLab.splitVertical")}
					</button>
					<button
						type="button"
						disabled={paneIds.length === 1}
						onClick={() => setTree((current) => closePane(current, current.activePaneId))}
						className={`${CONTROL_CLASS} text-danger hover:text-danger hover:bg-danger/10`}
					>
						{t("nativePaneLab.close")}
					</button>
					<button type="button" onClick={() => setTree((current) => toggleZoom(current))} className={CONTROL_CLASS}>
						{t(tree.zoomedPaneId ? "nativePaneLab.unzoom" : "nativePaneLab.zoom")}
					</button>
					<span className="mx-1 h-5 border-l border-edge" aria-hidden="true" />
					<button type="button" aria-label={t("nativePaneLab.focusLeft")} onClick={() => setTree((current) => focusPane(current, "left"))} className={ICON_CONTROL_CLASS}>←</button>
					<button type="button" aria-label={t("nativePaneLab.focusUp")} onClick={() => setTree((current) => focusPane(current, "up"))} className={ICON_CONTROL_CLASS}>↑</button>
					<button type="button" aria-label={t("nativePaneLab.focusDown")} onClick={() => setTree((current) => focusPane(current, "down"))} className={ICON_CONTROL_CLASS}>↓</button>
					<button type="button" aria-label={t("nativePaneLab.focusRight")} onClick={() => setTree((current) => focusPane(current, "right"))} className={ICON_CONTROL_CLASS}>→</button>
					{parent && activeRatio !== null && (
						<input
							type="range"
							min={10}
							max={90}
							value={Math.round(activeRatio * 100)}
							aria-label={t("nativePaneLab.ratio", { paneId: tree.activePaneId })}
							onChange={(event) => {
								const activeShare = Number(event.target.value) / 100;
								setTree((current) => setSplitRatio(
									current,
									parent.branch.id,
									parent.side === "first" ? activeShare : 1 - activeShare,
								));
							}}
							className="w-24 accent-accent"
						/>
					)}
				</div>
				<div className={`flex items-center gap-1.5 ${narrow ? "overflow-x-auto pb-1" : "flex-wrap"}`}>
					<button type="button" onClick={() => setSavedSnapshot(serializeSplitTree(tree))} className={CONTROL_CLASS}>{t("nativePaneLab.save")}</button>
					<button type="button" onClick={() => {
						const restored = restoreSplitTree(savedSnapshot);
						if (restored) setTree(restored);
					}} className={CONTROL_CLASS}>{t("nativePaneLab.restore")}</button>
					<button type="button" onClick={() => setViewEpoch((value) => value + 1)} className={CONTROL_CLASS}>{t("nativePaneLab.remount")}</button>
					<button type="button" disabled={stressRunning} onClick={() => void runStress()} className={`${CONTROL_CLASS} ml-auto`}>
						{t(stressRunning ? "nativePaneLab.runningStress" : "nativePaneLab.runStress")}
					</button>
				</div>
				<p className="text-[11px] text-fg-muted">{t("nativePaneLab.keyboard")}</p>
			</div>

			{narrow && paneIds.length > 1 && !tree.zoomedPaneId && (
				<nav className="shrink-0 flex items-center justify-center gap-2 px-3 py-2 border-b border-edge bg-elevated" aria-label={t("nativePaneLab.pager", { current: activeIndex + 1, count: paneIds.length })}>
					<button type="button" aria-label={t("nativePaneLab.previous")} onClick={() => page(-1)} className={ICON_CONTROL_CLASS}>‹</button>
					<div className="flex items-center gap-1">
						{paneIds.map((paneId, index) => (
							<button
								key={paneId}
								type="button"
								aria-label={t("nativePaneLab.showPane", { index: index + 1 })}
								onClick={() => setTree((current) => activatePane(current, paneId))}
								className={`size-7 rounded text-xs font-semibold ${paneId === tree.activePaneId ? "bg-accent text-white" : "bg-raised text-fg-3 hover:bg-raised-hover"}`}
							>
								{index + 1}
							</button>
						))}
					</div>
					<span className="min-w-20 text-center text-xs font-semibold text-fg-2">
						{t("nativePaneLab.pager", { current: activeIndex + 1, count: paneIds.length })}
					</span>
					<button type="button" aria-label={t("nativePaneLab.next")} onClick={() => page(1)} className={ICON_CONTROL_CLASS}>›</button>
				</nav>
			)}

			<main className={`flex flex-1 min-h-0 p-2 ${narrow ? "min-h-[24rem]" : ""}`}>
				{tree.zoomedPaneId
					? renderPane(tree.zoomedPaneId)
					: narrow
						? renderPane(tree.activePaneId)
						: renderNode(tree.root)}
			</main>

			<footer className="shrink-0 px-3 py-2 border-t border-edge bg-raised text-[11px] text-fg-3" aria-live="polite">
				{stressCopy}
			</footer>
		</div>
	);
}
