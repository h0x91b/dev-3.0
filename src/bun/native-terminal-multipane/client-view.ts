/**
 * One client's view of a coordinator (seq 1283).
 *
 * Holds the client-local overlays — focus and zoom — over the coordinator's
 * shared pane set. Two views of the same coordinator stay independent: nothing
 * here touches the shared layout, another view, or a PTY. Resizing a PTY is the
 * writer's job and lives on the coordinator, deliberately not here.
 */

import {
	createClientPaneLayout,
	focusPane,
	reconcileClientPaneLayout,
	toggleZoom,
	unzoomPane,
	zoomPane,
	type ClientPaneLayout,
} from "../../shared/native-terminal-client-layout";
import { directionalFocusTarget } from "./focus-mapping";
import type { SplitDirection, SplitTree } from "../../shared/split-tree";

export class CoordinatorClientView {
	private state: ClientPaneLayout;

	constructor(
		readonly viewId: string,
		sharedPaneIds: readonly string[],
	) {
		this.state = createClientPaneLayout(sharedPaneIds);
	}

	get layout(): ClientPaneLayout {
		return this.state;
	}

	get focusedPaneId(): string | null {
		return this.state.focusedPaneId;
	}

	get zoomedPaneId(): string | null {
		return this.state.zoomedPaneId;
	}

	/** Fold a fresh observation of the shared pane set into this view. */
	observe(sharedPaneIds: readonly string[]): ClientPaneLayout {
		this.state = reconcileClientPaneLayout(this.state, sharedPaneIds);
		return this.state;
	}

	focus(paneId: string): ClientPaneLayout {
		this.state = focusPane(this.state, paneId);
		return this.state;
	}

	/** Move focus through the shared geometry without writing back to it. */
	focusDirection(tree: SplitTree, direction: SplitDirection): ClientPaneLayout {
		if (this.state.focusedPaneId === null) return this.state;
		return this.focus(directionalFocusTarget(tree, this.state.focusedPaneId, direction));
	}

	zoom(paneId: string | null = this.state.focusedPaneId): ClientPaneLayout {
		this.state = zoomPane(this.state, paneId);
		return this.state;
	}

	unzoom(): ClientPaneLayout {
		this.state = unzoomPane(this.state);
		return this.state;
	}

	toggleZoom(paneId: string | null = this.state.focusedPaneId): ClientPaneLayout {
		this.state = toggleZoom(this.state, paneId);
		return this.state;
	}
}
