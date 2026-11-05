import type { TFunction } from "./i18n";
import { api } from "./rpc";
import { toast } from "./toast";
import { formatRef, parseRefUri } from "../shared/task-refs";

export interface TaskRefActivateContext {
	t: TFunction;
	/** Project a bare `<seq:N>` / `<pr:N>` belongs to — the project of the text it sits in. */
	contextProjectId?: string;
	/** Task the text belongs to, so an error toast lands on it. */
	taskId?: string;
}

/**
 * Open a `<seq:N>` / `<pr:N>` reference from agent-written text: a task opens in
 * the app (on whichever board holds it), a PR opens on GitHub. The same path
 * serves the terminal, the task panel, the traffic view and markdown.
 */
export async function activateTaskPrRef(uri: string, ctx: TaskRefActivateContext): Promise<void> {
	const { t, contextProjectId, taskId } = ctx;
	const ref = parseRefUri(uri);
	const label = ref ? formatRef(ref) : uri;
	if (!ref) {
		toast.error(t("taskRef.notFound", { ref: label }), { taskId });
		return;
	}
	try {
		const resolved = await api.request.resolveTaskPrRef({ ref: uri, contextProjectId });
		if (!resolved) {
			toast.error(t("taskRef.notFound", { ref: label }), { taskId });
			return;
		}
		if (resolved.kind === "task") {
			window.dispatchEvent(new CustomEvent("rpc:openDeepLink", {
				detail: { kind: "task", taskId: resolved.taskId, projectId: resolved.projectId },
			}));
			return;
		}
		if (!resolved.url) {
			toast.error(t("taskRef.prUnknownRepo", { ref: label }), { taskId });
			return;
		}
		window.open(resolved.url, "_blank", "noopener,noreferrer");
	} catch (err) {
		toast.error(t("taskRef.openFailed", { ref: label, error: String(err) }), { taskId });
	}
}
