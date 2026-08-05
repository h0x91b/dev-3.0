/**
 * Sensitive projects — the privacy verdict every surface asks.
 *
 * `Project.sensitive` marks a project the user must not show on camera. The flag
 * is inert on its own: it only bites while streamer mode is on, and then it does
 * three things — the project's name and its tasks are masked, the project cannot
 * be entered, and none of its notifications reach the user.
 *
 * The set of sensitive ids lives in this module (published by `App.tsx` from the
 * project list) so a surface that only knows a `projectId` — the tmux session
 * list, a notification payload — can ask without threading the project list
 * through its props.
 *
 * Threat model is streamer mode's (decision 161): a viewer of a recording, not
 * someone with the DOM open. Masking is CSS blur and the values stay in the DOM;
 * the routing block is what actually prevents the leak.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project } from "../shared/types";
import { isStreamerModeOn, useStreamerMode } from "./streamer-mode";

/** The blur class from index.css. Goes on the text container, never on the row. */
export const MASK_CLASS = "streamer-private";

export const SENSITIVE_PROJECTS_CHANGED_EVENT = "dev3:sensitiveProjectsChanged";

let sensitiveIds: ReadonlySet<string> = new Set();

export function isProjectSensitive(project: Project | null | undefined): boolean {
	return Boolean(project?.sensitive);
}

/** Publish the sensitive project ids. Called by `App.tsx` on every project change. */
export function setSensitiveProjectIds(ids: string[]): void {
	const next = new Set(ids);
	if (next.size === sensitiveIds.size && [...next].every((id) => sensitiveIds.has(id))) return;
	sensitiveIds = next;
	window.dispatchEvent(new Event(SENSITIVE_PROJECTS_CHANGED_EVENT));
}

export function getSensitiveProjectIds(): ReadonlySet<string> {
	return sensitiveIds;
}

/** A project, or just its id — surfaces have one or the other, never both. */
export type ProjectRef = Project | string | null | undefined;

export interface ProjectPrivacy {
	/** Whether streamer mode is on for this client. */
	streamerMode: boolean;
	/** True when the project is sensitive AND streamer mode is on. */
	isLocked: (ref: ProjectRef) => boolean;
	/** `"streamer-private"` when the project must be masked, else `""`. */
	maskClass: (ref: ProjectRef) => string;
}

/** Reactive privacy verdict. Re-renders on streamer toggles and flag changes. */
export function useProjectPrivacy(): ProjectPrivacy {
	const streamerMode = useStreamerMode();
	const [ids, setIds] = useState(sensitiveIds);
	useEffect(() => {
		function onChange() {
			setIds(sensitiveIds);
		}
		onChange();
		window.addEventListener(SENSITIVE_PROJECTS_CHANGED_EVENT, onChange);
		return () => window.removeEventListener(SENSITIVE_PROJECTS_CHANGED_EVENT, onChange);
	}, []);

	const isLocked = useCallback(
		(ref: ProjectRef) => {
			if (!streamerMode || !ref) return false;
			return typeof ref === "string" ? ids.has(ref) : Boolean(ref.sensitive);
		},
		[streamerMode, ids],
	);
	const maskClass = useCallback((ref: ProjectRef) => (isLocked(ref) ? MASK_CLASS : ""), [isLocked]);
	return useMemo(() => ({ streamerMode, isLocked, maskClass }), [streamerMode, isLocked, maskClass]);
}

/**
 * Non-reactive verdict for event handlers — a push that arrives for a locked
 * project must not reach the screen at all. The backend drops these too; this
 * closes the window where its last privacy report is still in flight.
 */
export function isProjectSilencedForDisplay(projectId: string | null | undefined): boolean {
	if (!projectId || !isStreamerModeOn()) return false;
	return sensitiveIds.has(projectId);
}
