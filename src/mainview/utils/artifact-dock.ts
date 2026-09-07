/**
 * The one docking slot the artifact viewer may render into.
 *
 * `TaskArtifactViewer` is mounted by `App` for every entry point, but in the
 * default presentation it has to appear *inside* the task workspace, to the
 * right of the terminal. React cannot reparent a subtree, so the viewer portals
 * into the element the workspace pane publishes here instead. Two consequences
 * that are the point of the module:
 *
 *  - Flipping "Open artifacts in a popup" while an artifact is open moves the
 *    same mounted viewer between presentations, so the loaded document, the
 *    selected version and an unsent form draft all survive the flip.
 *  - There is exactly one slot and exactly one viewer, so a task switch can
 *    never leave a second, hidden artifact instance behind.
 *
 * The pane owns the slot's lifetime: it sets the element on mount and clears it
 * on unmount. A cleared slot means "no dock available" and the viewer falls back
 * to the popup — which is what the archived-task modal and a toast for another
 * task rely on.
 */

type Listener = (el: HTMLElement | null) => void;

let dock: HTMLElement | null = null;
const listeners = new Set<Listener>();

export function setArtifactDock(el: HTMLElement | null): void {
	if (dock === el) return;
	dock = el;
	for (const listener of listeners) listener(dock);
}

export function getArtifactDock(): HTMLElement | null {
	return dock;
}

export function subscribeArtifactDock(listener: Listener): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}
