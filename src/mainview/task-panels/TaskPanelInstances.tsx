import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { useT } from "../i18n";
import { createPortal } from "react-dom";
import { CordisContext } from "../plugins/react";
import { SlotErrorBoundary } from "../plugins/SlotHost";
import type { SlotEntry } from "../plugins/slot-registry";
import { isBuiltinItem } from "../plugins/SlotItems";
import { closeTaskPanel, getTaskDocks, resolveActiveTab, getTaskDockSeat, getTaskDockSeatsVersion, subscribeTaskDocks } from "./dock-store";
import { getTaskPanelsRegistry, type TaskPanelDef, type TaskPanelPresentation } from "./registry";

function presentationOf(taskId: string, panelId: string, active: string | null): { presentation: TaskPanelPresentation; seat: HTMLElement | null } {
	const seat = getTaskDockSeat(taskId);
	if (seat === undefined) return { presentation: "offscreen", seat: null };
	if (seat === null) return { presentation: "undocked", seat: null };
	return { presentation: active === panelId ? "docked" : "inactive", seat };
}

function PanelInstance({ taskId, entry, presentation, seat, parking }: {
	taskId: string;
	entry: SlotEntry<TaskPanelDef>;
	presentation: TaskPanelPresentation;
	seat: HTMLElement | null;
	parking: HTMLElement;
}) {
	// One element for the instance's whole life, moved between the dock and the
	// parking lot: React never sees its portal container change, so the panel
	// keeps its state across tab switches, task switches and narrow/immersive flips.
	const [host] = useState(() => {
		const el = document.createElement("div");
		el.className = "h-full min-h-0 min-w-0 flex flex-col";
		el.dataset.taskPanel = entry.def.id;
		return el;
	});
	useLayoutEffect(() => {
		const target = seat ?? parking;
		if (target && host.parentElement !== target) target.appendChild(host);
		host.hidden = presentation !== "docked";
	}, [host, seat, parking, presentation]);
	useLayoutEffect(() => () => host.remove(), [host]);
	const Component = entry.def.component;
	const panelId = entry.def.id;
	return createPortal(
		<SlotErrorBoundary slot="taskPanels" resetKey={panelId} fallback={() => (isBuiltinItem(panelId) ? <PanelCrashed /> : <DropPanel taskId={taskId} panelId={panelId} />)}>
			<CordisContext.Provider value={entry.ctx}>
				<Component ctx={entry.ctx} taskId={taskId} presentation={presentation} close={() => closeTaskPanel(taskId, panelId)} />
			</CordisContext.Provider>
		</SlotErrorBoundary>,
		host,
	);
}

/** A crashed built-in keeps its tab and says so in the body (bible §5.12). */
function PanelCrashed() {
	const t = useT();
	return (
		<div role="alert" className="m-3 rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger">
			{t("taskDock.panelCrashed")}
		</div>
	);
}

/** A crashed extension panel vanishes from the dock: its tab closes. */
function DropPanel({ taskId, panelId }: { taskId: string; panelId: string }) {
	useEffect(() => closeTaskPanel(taskId, panelId), [taskId, panelId]);
	return null;
}

/**
 * Every open task panel, for every task, mounted once here at the app level. A
 * workspace pane only offers a seat (`TaskDock`); a panel whose task has no seat
 * waits hidden in the parking lot, still mounted.
 */
export default function TaskPanelInstances() {
	const registry = getTaskPanelsRegistry();
	const entries = useSyncExternalStore(registry.subscribe, registry.list);
	const docks = useSyncExternalStore(subscribeTaskDocks, getTaskDocks);
	useSyncExternalStore(subscribeTaskDocks, getTaskDockSeatsVersion);
	const [parking] = useState(() => {
		const el = document.createElement("div");
		el.hidden = true;
		el.dataset.testid = "task-panels-parking";
		return el;
	});
	useLayoutEffect(() => {
		document.body.appendChild(parking);
		return () => parking.remove();
	}, [parking]);
	const byId = new Map(entries.map((entry) => [entry.def.id, entry]));
	const instances = [];
	for (const [taskId, dock] of docks) {
		const active = resolveActiveTab(taskId, dock.open.filter((id) => byId.has(id)), dock.active);
		for (const panelId of dock.open) {
			const entry = byId.get(panelId);
			if (!entry) continue;
			const { presentation, seat } = presentationOf(taskId, panelId, active);
			instances.push(
				<PanelInstance key={`${taskId}\u0000${panelId}`} taskId={taskId} entry={entry} presentation={presentation} seat={seat} parking={parking} />,
			);
		}
	}
	return <>{instances}</>;
}
