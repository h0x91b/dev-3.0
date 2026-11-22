import { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo, type Dispatch, type DragEvent, type MutableRefObject } from "react";
import { toast } from "../toast";
import { confirm } from "../confirm";
import { confirmCustomColumnDelete } from "../utils/confirmCustomColumnDelete";
import type { CodingAgent, ColumnAgentConfig, Dev3RepoConfig, GitHubCliStatus, Label, Project, Task } from "../../shared/types";
import { ACTIVE_STATUSES, GIT_WORKFLOW_NOT_A_REPO_ERROR, gitWorkflowSwitchBlocker, hasGitWorkflow, repoConfigEnabled, STORAGE_TRACKED_CONFLICT_ERROR, storageSwitchBlocker } from "../../shared/types";
import { builtinCoordinatorPrompt, COORDINATOR_PROMPT, DEFAULT_PR_REVIEW_PROMPT, DEFAULT_REVIEW_AGENT_ID, DEFAULT_REVIEW_CONFIG_ID, DEFAULT_REVIEW_PROMPT, resolveArtifactTemplate, resolvePresetPrompt, type ProjectSettingsUpdate, type ResolvedArtifactTemplate } from "../../shared/types";
import { EXPLICIT_EMPTY_ARRAY_CONFIG_KEYS } from "../../shared/config-schema";
import { reloadProjectFolders } from "../project-folders";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import type { NavigationGuard } from "../navigation-guard";
import { useIsControlHidden } from "../hooks/useIsControlHidden";
import { genericFieldKeys } from "../components/project-settings/SchemaConfigFields";
import { CONFIG_BOOLEAN_DEFAULTS, encodeGitHubAccountValue, getEffectiveCompareRef, type ProjectConfigValues } from "../components/project-settings/config-values";
import type { ProjectSettingsTab } from "./registry";

function normalizeReviewPrompt(prompt: string): string {
	return prompt.trim() === DEFAULT_REVIEW_PROMPT ? "" : prompt.trim();
}

function normalizeLocalConfig(config: Dev3RepoConfig, inherited: Dev3RepoConfig): Dev3RepoConfig {
	const fallbackBaseBranch = inherited.defaultBaseBranch ?? "main";
	const defaultCompareRef = getEffectiveCompareRef(config, fallbackBaseBranch);
	return defaultCompareRef === undefined
		? config
		: { ...config, defaultCompareRef };
}


export type WorktreeSubTab = "repo" | "local";

/**
 * Strip empty strings from clonePaths, sparseCheckoutPaths and extraFolders before saving.
 * Only includes these fields if they were actually present in the input config —
 * avoids creating phantom `clonePaths: []` entries that shadow project-level values. See #378.
 */
function sanitizeConfigPaths<T extends Dev3RepoConfig>(config: T): T {
	const { defaultCompareRefMode: _legacyCompareRefMode, ...rest } = config as T & { defaultCompareRefMode?: string };
	const result = { ...rest } as T;
	if (rest.clonePaths !== undefined) {
		result.clonePaths = rest.clonePaths.filter((p) => p.trim() !== "");
	}
	if (rest.sparseCheckoutPaths !== undefined) {
		result.sparseCheckoutPaths = rest.sparseCheckoutPaths.filter((p) => p.trim() !== "");
	}
	if (rest.extraFolders !== undefined) {
		result.extraFolders = rest.extraFolders.filter((p) => p.trim() !== "");
	}
	return result;
}

export interface ProjectSettingsProps {
	projectId: string;
	projects: Project[];
	tasks: Task[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	navigationGuardRef?: MutableRefObject<NavigationGuard | null>;
	initialTab?: ProjectSettingsTab;
	initialWorktreeTaskId?: string;
}

/**
 * Project Settings' state and handlers, owned once by the page; every built-in tab body
 * reads it. Null while the project is unknown (the page shows "not found").
 */
export function useProjectSettingsController({
	projectId,
	projects,
	tasks,
	dispatch,
	initialTab,
	initialWorktreeTaskId,
}: Omit<ProjectSettingsProps, "navigate" | "navigationGuardRef">) {
	const t = useT();
	const project = projects.find((p) => p.id === projectId);

	// Ensure this project's tasks are loaded. Settings can be opened straight from
	// the dashboard gear without ever mounting ProjectView (which is the only other
	// loader), leaving `currentProjectTasks` empty/stale — which would show every
	// label count as 0 and empty the Worktree Config task list. Mirror ProjectView's
	// fetch so both are correct regardless of entry path.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const loaded = await api.request.getTasks({ projectId });
				if (!cancelled) dispatch({ type: "setTasks", projectId, tasks: loaded });
			} catch (err) {
				console.error("Failed to load tasks for project settings:", err);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [projectId, dispatch]);

	// labelId → number of project tasks (any status) carrying it. Shown as a
	// quiet count badge next to each label in the Labels settings list.
	const labelTaskCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const task of tasks) {
			for (const id of task.labelIds ?? []) {
				counts.set(id, (counts.get(id) ?? 0) + 1);
			}
		}
		return counts;
	}, [tasks]);

	// Operations boards only have the Board tab (no git → no Project/Worktree
	// config); never let a deep-linked initialTab strand them on a hidden git tab.
	const [importingConversations, setImportingConversations] = useState(false);
	const [activeTab, setActiveTab] = useState<ProjectSettingsTab>(
		project?.kind === "virtual"
			? (initialTab === "automations" ? "automations" : "global")
			: initialTab === "worktree" && project && !hasGitWorkflow(project)
				? "global"
				: (initialTab ?? "global"),
	);
	// The "automations-tab" control (§5.10, typically via the Simplify View
	// preset) hides this tab; never strand the user on it.
	const automationsTabHidden = useIsControlHidden("automations-tab");
	const labelCreationHidden = useIsControlHidden("label-creation");
	useEffect(() => {
		if (automationsTabHidden) {
			setActiveTab((tab) => (tab === "automations" ? "global" : tab));
		}
	}, [automationsTabHidden]);

	// ---- Project tab state (reads/writes projects.json) ----
	const projectConfigFromProject = useCallback((p: Project): ProjectConfigValues => ({
		setupScript: p.setupScript,
		setupScriptLaunchMode: p.setupScriptLaunchMode,
		devScript: p.devScript,
		devServers: p.devServers,
		cleanupScript: p.cleanupScript,
		clonePaths: p.clonePaths,
		defaultBaseBranch: p.defaultBaseBranch,
		defaultCompareRef: getEffectiveCompareRef(
			p,
			p.defaultBaseBranch,
			p.defaultCompareRef ?? p.defaultBaseBranch,
		),
		githubAuthHost: p.githubAuthHost ?? null,
		githubAuthLogin: p.githubAuthLogin ?? null,
		autoReviewEnabled: p.autoReviewEnabled,
		peerReviewEnabled: p.peerReviewEnabled,
		sparseCheckoutEnabled: p.sparseCheckoutEnabled,
		sparseCheckoutPaths: p.sparseCheckoutPaths,
		extraFolders: p.extraFolders,
		env: p.env,
	}), []);
	const [projectConfig, setProjectConfig] = useState<ProjectConfigValues>(() => project ? projectConfigFromProject(project) : {});
	const [savingProject, setSavingProject] = useState(false);
	const loadedProjectConfig = useRef<ProjectConfigValues>(project ? projectConfigFromProject(project) : {});

	// ---- Worktree tab state ----
	const [worktreeSubTab, setWorktreeSubTab] = useState<WorktreeSubTab>("repo");
	const [selectedWorktreeTaskId, setSelectedWorktreeTaskId] = useState<string | null>(initialWorktreeTaskId ?? null);
	const [wtRepoConfig, setWtRepoConfig] = useState<Dev3RepoConfig>({});
	const [wtLocalConfig, setWtLocalConfig] = useState<Dev3RepoConfig>({});
	const [savingWtRepo, setSavingWtRepo] = useState(false);
	const [savingWtLocal, setSavingWtLocal] = useState(false);
	// Tracks whether the current selected worktree's configs loaded successfully.
	// When false (load in flight or failed), writes are unsafe because the form
	// may still hold the previous task's values. Prevents M2·B: stale config
	// being persisted into a different worktree after a load failure.
	const [wtConfigLoadState, setWtConfigLoadState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
	const loadedWtRepoConfig = useRef<Dev3RepoConfig>({});
	const loadedWtLocalConfig = useRef<Dev3RepoConfig>({});

	// ---- Global tab state ----
	const [labelSaving, setLabelSaving] = useState<string | null>(null);
	const [columnSaving, setColumnSaving] = useState<string | null>(null);
	// Label drag-reorder transient state (source id + current drop indicator).
	const [draggedLabelId, setDraggedLabelId] = useState<string | null>(null);
	const [labelDropTarget, setLabelDropTarget] = useState<{ labelId: string; side: "before" | "after" } | null>(null);
	const [githubStatus, setGitHubStatus] = useState<GitHubCliStatus | null>(null);

	// A visible env textarea holding unparseable lines blocks saving that tab. The
	// editor owns this flag for its own lifetime — it reports on mount and clears
	// on unmount, so switching tabs or config layers needs no reset here.
	const [envTextError, setEnvTextError] = useState(false);

	// ---- Config file presence (for override warning on Project Config tab) ----
	const [configFileOverride, setConfigFileOverride] = useState<string | null>(null);
	const refreshConfigFileOverride = useCallback(async () => {
		const { hasRepoConfig: hasRepo, hasLocalConfig: hasLocal } = await api.request.getProjectConfigFiles({ projectId });
		setConfigFileOverride(hasLocal ? ".dev3/config.local.json" : hasRepo ? ".dev3/config.json" : null);
	}, [projectId]);
	useEffect(() => {
		if (project) refreshConfigFileOverride().catch(() => {});
	}, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		api.request.getGitHubCliStatus().then(setGitHubStatus).catch(() => {});
	}, []);

	// AI Review state (stored as builtinColumnAgents["review-by-ai"])
	const reviewConfig = project?.builtinColumnAgents?.["review-by-ai"];
	const [aiReviewAgentId, setAiReviewAgentId] = useState(reviewConfig?.agentId ?? DEFAULT_REVIEW_AGENT_ID);
	const [aiReviewConfigId, setAiReviewConfigId] = useState(reviewConfig?.configId ?? DEFAULT_REVIEW_CONFIG_ID);
	const [aiReviewPrompt, setAiReviewPrompt] = useState(reviewConfig?.prompt || DEFAULT_REVIEW_PROMPT);
	const initialAiReviewRef = useRef({
		agentId: reviewConfig?.agentId ?? DEFAULT_REVIEW_AGENT_ID,
		configId: reviewConfig?.configId ?? DEFAULT_REVIEW_CONFIG_ID,
		prompt: reviewConfig?.prompt || DEFAULT_REVIEW_PROMPT,
	});
	const [availableAgents, setAvailableAgents] = useState<CodingAgent[]>([]);

	// Review-toggle prompt: blank = inherit the global setting (itself falling back
	// to the localized built-in text).
	const [reviewModePrompt, setReviewModePrompt] = useState(project?.reviewModePrompt ?? "");
	const initialReviewModePromptRef = useRef(project?.reviewModePrompt ?? "");
	const [coordinatorPrompt, setCoordinatorPrompt] = useState(project?.coordinatorPrompt ?? "");
	const initialCoordinatorPromptRef = useRef(project?.coordinatorPrompt ?? "");
	const [globalCoordinatorPrompt, setGlobalCoordinatorPrompt] = useState<string | undefined>(undefined);
	const [globalReviewModePrompt, setGlobalReviewModePrompt] = useState<string | undefined>(undefined);
	const inheritedReviewModePrompt = resolvePresetPrompt(undefined, globalReviewModePrompt, DEFAULT_PR_REVIEW_PROMPT);
	const [globalArtifactTemplate, setGlobalArtifactTemplate] = useState<ResolvedArtifactTemplate>({ mode: "on" });
	const inheritedCoordinatorPrompt = resolvePresetPrompt(undefined, globalCoordinatorPrompt, project ? builtinCoordinatorPrompt(project) : COORDINATOR_PROMPT);

	// Load available agents
	useEffect(() => {
		api.request.getAgents().then(setAvailableAgents).catch(() => {});
		api.request.getGlobalSettings().then((s) => {
			setGlobalReviewModePrompt(s.reviewModePrompt);
			setGlobalCoordinatorPrompt(s.coordinatorPrompt);
			setGlobalArtifactTemplate(resolveArtifactTemplate({}, s));
		}).catch(() => {});
	}, []);

	// Tasks with active worktrees
	const worktreeTasks = tasks.filter((t) => t.worktreePath && ACTIVE_STATUSES.includes(t.status));

	// Auto-select first worktree task
	useEffect(() => {
		if (!selectedWorktreeTaskId && worktreeTasks.length > 0) {
			setSelectedWorktreeTaskId(worktreeTasks[0].id);
		}
	}, [worktreeTasks.length]); // eslint-disable-line react-hooks/exhaustive-deps

	// Load worktree configs when task selection changes
	const selectedTask = tasks.find((t) => t.id === selectedWorktreeTaskId);
	useEffect(() => {
		if (!selectedTask?.worktreePath) {
			setWtConfigLoadState("idle");
			return;
		}
		// Clear the form before the request so stale values from the previous
		// task cannot bleed into the new worktree. If the request fails, the
		// form stays empty and Save is disabled until the load succeeds.
		setWtConfigLoadState("loading");
		setWtRepoConfig({});
		setWtLocalConfig({});
		loadedWtRepoConfig.current = {};
		loadedWtLocalConfig.current = {};

		const worktreePath = selectedTask.worktreePath;
		let cancelled = false;

		api.request.getProjectConfigs({ projectId, worktreePath }).then(({ repo, local }) => {
			if (cancelled) return;
			const normalizedRepo = normalizeLocalConfig(repo, {
				defaultBaseBranch: project?.defaultBaseBranch ?? "main",
			});
			const normalizedLocal = normalizeLocalConfig(
				local,
				normalizedRepo.defaultBaseBranch ? normalizedRepo : {
					defaultBaseBranch: project?.defaultBaseBranch ?? "main",
				},
			);
			setWtRepoConfig(normalizedRepo);
			setWtLocalConfig(normalizedLocal);
			loadedWtRepoConfig.current = normalizedRepo;
			loadedWtLocalConfig.current = normalizedLocal;
			setWtConfigLoadState("loaded");
		}).catch(() => {
			if (cancelled) return;
			setWtConfigLoadState("error");
		});

		return () => {
			cancelled = true;
		};
	}, [selectedWorktreeTaskId, selectedTask?.worktreePath, project?.defaultBaseBranch]); // eslint-disable-line react-hooks/exhaustive-deps

	const configsEqual = useCallback((a: Dev3RepoConfig, b: Dev3RepoConfig) => {
		const stringKeys: (keyof Dev3RepoConfig)[] = [
			"setupScript",
			"setupScriptLaunchMode",
			"devScript",
			"cleanupScript",
			"defaultBaseBranch",
			"defaultCompareRef",
		];
		for (const key of stringKeys) {
			if ((a[key] ?? "") !== (b[key] ?? "")) return false;
		}
		for (const [key, defaultValue] of Object.entries(CONFIG_BOOLEAN_DEFAULTS) as Array<[keyof typeof CONFIG_BOOLEAN_DEFAULTS, boolean]>) {
			if ((a[key] ?? defaultValue) !== (b[key] ?? defaultValue)) return false;
		}
		const arrA = (a.clonePaths ?? []).join("\0");
		const arrB = (b.clonePaths ?? []).join("\0");
		if (arrA !== arrB) return false;
		const spA = (a.sparseCheckoutPaths ?? []).join("\0");
		const spB = (b.sparseCheckoutPaths ?? []).join("\0");
		if (spA !== spB) return false;
		// Schema-rendered fields have no hand-written comparison; an empty list equals unset,
		// except where the schema gives [] its own meaning (it hides a lower layer's list).
		for (const key of genericFieldKeys()) {
			const explicitEmpty = EXPLICIT_EMPTY_ARRAY_CONFIG_KEYS.has(key);
			const normalized = (v: unknown) => (!explicitEmpty && Array.isArray(v) && v.length === 0 ? undefined : v);
			if (JSON.stringify(normalized(a[key]) ?? null) !== JSON.stringify(normalized(b[key]) ?? null)) return false;
		}
		// Compare devServers: a row edit must count as an unsaved change.
		if (JSON.stringify(a.devServers ?? {}) !== JSON.stringify(b.devServers ?? {})) return false;
		// Compare builtinColumnAgents
		const bcaA = JSON.stringify(a.builtinColumnAgents ?? {});
		const bcaB = JSON.stringify(b.builtinColumnAgents ?? {});
		if (bcaA !== bcaB) return false;
		if ((a.portCount ?? 0) !== (b.portCount ?? 0)) return false;
		if (JSON.stringify(a.env ?? {}) !== JSON.stringify(b.env ?? {})) return false;
		return true;
	}, []);

	const projectConfigsEqual = useCallback((a: ProjectConfigValues, b: ProjectConfigValues) => {
		return configsEqual(a, b)
			&& (a.githubAuthHost ?? "") === (b.githubAuthHost ?? "")
			&& (a.githubAuthLogin ?? "") === (b.githubAuthLogin ?? "");
	}, [configsEqual]);

	// The form holds values resolved with the repo files on or off. When that flag
	// flips outside this tab (`dev3 projects set useRepoConfig`, another window), the
	// values are stale, and saving them would copy one resolution into the other.
	// Reseed from the pushed project, as handleToggleUseRepoConfig does, and say so
	// when that drops unsaved edits.
	const seededUseRepoConfig = useRef(project ? repoConfigEnabled(project) : true);
	const projectUseRepoConfig = project ? repoConfigEnabled(project) : true;
	useEffect(() => {
		if (!project || projectUseRepoConfig === seededUseRepoConfig.current) return;
		seededUseRepoConfig.current = projectUseRepoConfig;
		const hadEdits = !projectConfigsEqual(projectConfig, loadedProjectConfig.current);
		const reseeded = projectConfigFromProject(project);
		setProjectConfig(reseeded);
		loadedProjectConfig.current = reseeded;
		refreshConfigFileOverride().catch(() => {});
		if (hadEdits) toast.warning(t("projectSettings.useRepoConfigChangedElsewhere"), { projectId });
	}, [projectUseRepoConfig]); // eslint-disable-line react-hooks/exhaustive-deps

	const isReviewModePromptDirty = useCallback(
		() => reviewModePrompt.trim() !== initialReviewModePromptRef.current.trim()
			|| coordinatorPrompt.trim() !== initialCoordinatorPromptRef.current.trim(),
		[reviewModePrompt, coordinatorPrompt],
	);

	const isAiReviewDirty = useCallback(() => {
		const init = initialAiReviewRef.current;
		return aiReviewAgentId !== init.agentId || aiReviewConfigId !== init.configId || aiReviewPrompt !== init.prompt;
	}, [aiReviewAgentId, aiReviewConfigId, aiReviewPrompt]);

	// The form is seeded by useState, which only runs on mount — re-sync when the
	// project's effective review config changes (initial load, save, push update).
	// Unsaved edits win: never clobber what the user is in the middle of typing.
	const reviewConfigKey = JSON.stringify(reviewConfig ?? null);
	useEffect(() => {
		if (isAiReviewDirty()) return;
		const next = {
			agentId: reviewConfig?.agentId ?? DEFAULT_REVIEW_AGENT_ID,
			configId: reviewConfig?.configId ?? DEFAULT_REVIEW_CONFIG_ID,
			prompt: reviewConfig?.prompt || DEFAULT_REVIEW_PROMPT,
		};
		setAiReviewAgentId(next.agentId);
		setAiReviewConfigId(next.configId);
		setAiReviewPrompt(next.prompt);
		initialAiReviewRef.current = next;
	}, [reviewConfigKey]); // eslint-disable-line react-hooks/exhaustive-deps


	if (!project) return null;

	// ---- Global tab handlers ----
	// Saves on toggle — the Board tab has no Save button. The flag lives on the
	// project record (not .dev3/config.json): it is this machine's privacy call,
	// not something to commit into the repo.
	// Display name only: the path stays put, so every worktree, data dir and
	// slug derived from it survives the rename untouched.
	async function handleRenameProject(name: string): Promise<boolean> {
		try {
			const updated = await api.request.updateProjectSettings({ projectId, name });
			dispatch({ type: "updateProject", project: updated });
			return true;
		} catch (err) {
			toast.error(t("projectSettings.failedSave", { error: String(err) }), { projectId });
			return false;
		}
	}

	async function handleArtifactTemplateChange(next: Pick<ProjectSettingsUpdate, "artifactTemplate" | "artifactTemplatePath">) {
		try {
			const updated = await api.request.updateProjectSettings({ projectId, ...next });
			if (next.artifactTemplate === "custom") {
				const path = updated.artifactTemplatePath || globalArtifactTemplate.path;
				api.request.prepareCustomArtifactTemplate({ path, seed: true }).catch(() => {});
			}
			dispatch({ type: "updateProject", project: updated });
		} catch (err) {
			toast.error(t("projectSettings.failedSave", { error: String(err) }), { projectId });
		}
	}

	async function handleAutoAccountExclusions(next: string[]) {
		if (!project) return;
		try {
			const updated = await api.request.updateProjectSettings({ projectId, autoAccountExclusions: next });
			dispatch({ type: "updateProject", project: updated });
		} catch (err) {
			toast.error(t("projectSettings.failedSave", { error: String(err) }), { projectId });
		}
	}

	async function handleBoardCopyChange(change: { boardCopy?: boolean; boardCopyMessages?: boolean }) {
		if (!project) return;
		try {
			const updated = await api.request.updateProjectSettings({ projectId, ...change });
			dispatch({ type: "updateProject", project: updated });
		} catch (err) {
			toast.error(t("projectSettings.failedSave", { error: String(err) }), { projectId });
		}
	}

	async function handleToggleGitWorkflow(next: boolean) {
		if (!project) return;
		const blocker = gitWorkflowSwitchBlocker(project, tasks);
		if (blocker?.reason === "live-tasks") {
			toast.error(t.plural("projectSettings.gitWorkflowBlocked", blocker.count), { projectId });
			return;
		}
		try {
			const updated = await api.request.updateProjectSettings({ projectId, gitWorkflow: next });
			dispatch({ type: "updateProject", project: updated });
		} catch (err) {
			// Retrying cannot fix a folder without git, so say what will.
			toast.error(String(err).includes(GIT_WORKFLOW_NOT_A_REPO_ERROR)
				? t("projectSettings.gitWorkflowNotRepo")
				: t("projectSettings.failedSave", { error: String(err) }), { projectId });
		}
	}

	async function handleToggleStorage(next: "project" | "home") {
		if (!project) return;
		const blocker = storageSwitchBlocker(project, tasks);
		if (blocker?.reason === "live-tasks") {
			toast.error(t.plural("projectStorage.blocked", blocker.count), { projectId });
			return;
		}
		try {
			const updated = await api.request.updateProjectSettings({ projectId, storageRoot: next });
			dispatch({ type: "updateProject", project: updated });
		} catch (err) {
			toast.error(String(err).includes(STORAGE_TRACKED_CONFLICT_ERROR)
				? t("projectStorage.trackedConflict")
				: t("projectStorage.copyFailed", { error: String(err) }), { projectId });
		}
	}

	async function handleToggleSensitive(next: boolean) {
		if (!project) return;
		try {
			const updated = await api.request.updateProjectSettings({ projectId, sensitive: next });
			dispatch({ type: "updateProject", project: updated });
		} catch (err) {
			toast.error(t("projectSettings.failedSave", { error: String(err) }), { projectId });
		}
	}

	/**
	 * Saved on its own, carrying nothing but the flag — the form below still holds
	 * values resolved WITH the repo files, and sending those along would copy a
	 * repo-provided script into projects.json as the user switches the repo off.
	 * The handler answers with the re-resolved project, which reseeds the form.
	 */
	async function handleToggleUseRepoConfig(next: boolean) {
		if (!project) return;
		// Unsaved edits in this tab were typed against the OLD resolution, so they
		// cannot survive the flip. Say that out loud instead of dropping them.
		if (!projectConfigsEqual(projectConfig, loadedProjectConfig.current)) {
			const ok = await confirm({
				title: t("projectSettings.useRepoConfigDiscardTitle"),
				message: t("projectSettings.useRepoConfigDiscardMessage"),
				confirmLabel: t("unsavedChanges.discard"),
			});
			if (!ok) return;
		}
		// Set before the request: its projectUpdated push can land first, and the
		// reseed effect must not treat this tab's own flip as an outside one.
		const seededBefore = seededUseRepoConfig.current;
		seededUseRepoConfig.current = next;
		try {
			const updated = await api.request.updateProjectSettings({ projectId, useRepoConfig: next });
			dispatch({ type: "updateProject", project: updated });
			const reseeded = projectConfigFromProject(updated);
			setProjectConfig(reseeded);
			loadedProjectConfig.current = reseeded;
			await refreshConfigFileOverride();
		} catch (err) {
			seededUseRepoConfig.current = seededBefore;
			toast.error(t("projectSettings.failedSave", { error: String(err) }), { projectId });
		}
	}

	async function handleAddLabel() {
		if (!project) return;
		setLabelSaving("new");
		try {
			const label = await api.request.createLabel({ projectId, name: "New label" });
			const updated: Project = { ...project, labels: [...(project.labels ?? []), label] };
			dispatch({ type: "updateProject", project: updated });
		} catch (err) {
			toast.error(t("labels.failedCreate", { error: String(err) }), { projectId });
		}
		setLabelSaving(null);
	}

	async function handleUpdateLabel(labelId: string, name: string, color: string) {
		if (!project) return;
		setLabelSaving(labelId);
		try {
			const label = await api.request.updateLabel({ projectId, labelId, name, color });
			const updated: Project = {
				...project,
				labels: (project.labels ?? []).map((l) => (l.id === labelId ? label : l)),
			};
			dispatch({ type: "updateProject", project: updated });
		} catch (err) {
			toast.error(t("labels.failedUpdate", { error: String(err) }), { projectId });
		}
		setLabelSaving(null);
	}

	async function handleDeleteLabel(labelId: string) {
		if (!project) return;
		// Deleting a label detaches it from every task carrying it, and there is
		// no undo — always ask, and say how many tasks are affected.
		const label = (project.labels ?? []).find((l) => l.id === labelId);
		const taskCount = labelTaskCounts.get(labelId) ?? 0;
		const confirmed = await confirm({
			title: t("labels.deleteConfirmTitle"),
			message: taskCount > 0
				? t.plural("labels.deleteConfirmMessage", taskCount, { name: label?.name ?? "" })
				: t("labels.deleteConfirmMessageUnused", { name: label?.name ?? "" }),
			confirmLabel: t("labels.deleteLabel"),
			danger: true,
		});
		if (!confirmed) return;
		setLabelSaving(labelId);
		try {
			await api.request.deleteLabel({ projectId, labelId });
			const updated: Project = {
				...project,
				labels: (project.labels ?? []).filter((l) => l.id !== labelId),
			};
			dispatch({ type: "updateProject", project: updated });
		} catch (err) {
			toast.error(t("labels.failedDelete", { error: String(err) }), { projectId });
		}
		setLabelSaving(null);
	}

	// Persist a new label order: optimistic reorder locally, then fire the RPC
	// (mirrors the custom-column / project reorder pattern). Server also pushes
	// projectUpdated so other surfaces (picker, cards) resync.
	function commitLabelOrder(labelOrder: string[]) {
		if (!project) return;
		const byId = new Map((project.labels ?? []).map((l) => [l.id, l]));
		const reordered = labelOrder.map((id) => byId.get(id)).filter((l): l is Label => l !== undefined);
		dispatch({ type: "updateProject", project: { ...project, labels: reordered } });
		api.request.reorderLabels({ projectId, labelOrder }).catch((err) => {
			toast.error(t("labels.failedReorder", { error: String(err) }), { projectId });
		});
	}

	// Move `sourceId` to the position of `targetId` (before/after) and persist.
	function reorderLabelTo(sourceId: string, targetId: string, side: "before" | "after") {
		if (!project || sourceId === targetId) return;
		const ids = (project.labels ?? []).map((l) => l.id);
		const fromIndex = ids.indexOf(sourceId);
		if (fromIndex === -1) return;
		ids.splice(fromIndex, 1);
		const targetIndex = ids.indexOf(targetId);
		if (targetIndex === -1) return;
		ids.splice(side === "after" ? targetIndex + 1 : targetIndex, 0, sourceId);
		commitLabelOrder(ids);
	}

	function moveLabelByStep(labelId: string, step: -1 | 1) {
		const labels = project?.labels ?? [];
		const index = labels.findIndex((l) => l.id === labelId);
		const target = labels[index + step];
		if (!target) return;
		reorderLabelTo(labelId, target.id, step < 0 ? "before" : "after");
	}

	function handleLabelDragOver(event: DragEvent<HTMLDivElement>, labelId: string) {
		if (!draggedLabelId || draggedLabelId === labelId) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		const rect = event.currentTarget.getBoundingClientRect();
		const side: "before" | "after" = event.clientY > rect.top + rect.height / 2 ? "after" : "before";
		setLabelDropTarget({ labelId, side });
	}

	function handleLabelDrop(event: DragEvent<HTMLDivElement>, labelId: string) {
		event.preventDefault();
		const sourceId = draggedLabelId;
		const side = labelDropTarget?.labelId === labelId ? labelDropTarget.side : "before";
		setDraggedLabelId(null);
		setLabelDropTarget(null);
		if (sourceId) reorderLabelTo(sourceId, labelId, side);
	}

	async function handleAddColumn() {
		if (!project) return;
		setColumnSaving("new");
		try {
			const column = await api.request.createCustomColumn({ projectId, name: t("customColumns.defaultName") });
			const updated: Project = { ...project, customColumns: [...(project.customColumns ?? []), column] };
			dispatch({ type: "updateProject", project: updated });
		} catch (err) {
			toast.error(t("customColumns.failedCreate", { error: String(err) }), { projectId });
		}
		setColumnSaving(null);
	}

	async function handleUpdateColumn(columnId: string, name: string, color: string, llmInstruction: string, agentConfig?: ColumnAgentConfig | null) {
		if (!project) return;
		setColumnSaving(columnId);
		try {
			const column = await api.request.updateCustomColumn({ projectId, columnId, name, color, llmInstruction, agentConfig });
			const updated: Project = {
				...project,
				customColumns: (project.customColumns ?? []).map((c) => (c.id === columnId ? column : c)),
			};
			dispatch({ type: "updateProject", project: updated });
		} catch (err) {
			toast.error(t("customColumns.failedUpdate", { error: String(err) }), { projectId });
		}
		setColumnSaving(null);
	}

	async function handleDeleteColumn(columnId: string) {
		if (!project) return;
		const column = (project.customColumns ?? []).find((c) => c.id === columnId);
		if (!column || !(await confirmCustomColumnDelete(column, tasks, t))) return;
		setColumnSaving(columnId);
		try {
			await api.request.deleteCustomColumn({ projectId, columnId });
			const updated: Project = {
				...project,
				customColumns: (project.customColumns ?? []).filter((c) => c.id !== columnId),
			};
			dispatch({ type: "updateProject", project: updated });
		} catch (err) {
			toast.error(t("customColumns.failedDelete", { error: String(err) }), { projectId });
		}
		setColumnSaving(null);
	}

	// ---- Project tab save (app-level config) ----
	async function handleSaveProjectConfig() {
		setSavingProject(true);
		try {
			const builtinColumnAgents: Record<string, ColumnAgentConfig> = {
				"review-by-ai": {
					agentId: aiReviewAgentId,
					configId: aiReviewConfigId,
					prompt: normalizeReviewPrompt(aiReviewPrompt),
				},
			};
			const toSave = {
				...sanitizeConfigPaths(projectConfig),
				builtinColumnAgents,
			};
			// Kept out of `toSave` so it never enters the config-equality baseline —
			// it lives on the project record, not in .dev3/config.json.
			const updated = await api.request.updateProjectSettings({
				projectId,
				...toSave,
				reviewModePrompt: reviewModePrompt.trim() ? reviewModePrompt : "",
				coordinatorPrompt: coordinatorPrompt.trim() ? coordinatorPrompt : "",
			});
			dispatch({ type: "updateProject", project: updated });
			loadedProjectConfig.current = toSave;
			setProjectConfig(toSave);
			initialAiReviewRef.current = { agentId: aiReviewAgentId, configId: aiReviewConfigId, prompt: aiReviewPrompt };
			initialReviewModePromptRef.current = reviewModePrompt;
			initialCoordinatorPromptRef.current = coordinatorPrompt;
		} catch (err) {
			toast.error(t("projectSettings.failedSave", { error: String(err) }), { projectId });
		}
		setSavingProject(false);
	}

	// ---- Worktree tab saves ----
	async function handleSaveWtRepo() {
		if (!selectedTask?.worktreePath) return;
		// Never save when the current config hasn't finished loading: the form
		// may still hold values belonging to a previous selection.
		if (wtConfigLoadState !== "loaded") return;
		setSavingWtRepo(true);
		try {
			const toSave = sanitizeConfigPaths(wtRepoConfig);
			await api.request.saveRepoConfig({ projectId, worktreePath: selectedTask.worktreePath, autoCommit: true, ...toSave });
			loadedWtRepoConfig.current = toSave;
			reloadProjectFolders(projectId);
			const updatedProjects = await api.request.getProjects();
			for (const p of updatedProjects) dispatch({ type: "updateProject", project: p });
		} catch (err) {
			toast.error(t("projectSettings.failedSave", { error: String(err) }), { projectId });
		}
		setSavingWtRepo(false);
	}

	async function handleSaveWtLocal() {
		if (!selectedTask?.worktreePath) return;
		if (wtConfigLoadState !== "loaded") return;
		setSavingWtLocal(true);
		try {
			const toSave = sanitizeConfigPaths(wtLocalConfig);
			await api.request.saveLocalConfig({ projectId, worktreePath: selectedTask.worktreePath, ...toSave });
			loadedWtLocalConfig.current = toSave;
			reloadProjectFolders(projectId);
			const updatedProjects = await api.request.getProjects();
			for (const p of updatedProjects) dispatch({ type: "updateProject", project: p });
		} catch (err) {
			toast.error(t("projectSettings.failedSave", { error: String(err) }), { projectId });
		}
		setSavingWtLocal(false);
	}

	// Keep the ref in sync for the navigation guard
	const saving = savingProject || savingWtRepo || savingWtLocal;
	const githubAccounts = githubStatus?.accounts ?? [];
	const activeGitHubAccount = githubAccounts.find((account) => account.active) ?? null;
	const selectedGitHubValue = projectConfig.githubAuthHost && projectConfig.githubAuthLogin
		? encodeGitHubAccountValue({ host: projectConfig.githubAuthHost, login: projectConfig.githubAuthLogin })
		: "";
	const selectedGitHubMissing = !!selectedGitHubValue
		&& !githubAccounts.some((account) => encodeGitHubAccountValue(account) === selectedGitHubValue);

	const projectDirty = !projectConfigsEqual(projectConfig, loadedProjectConfig.current) || isAiReviewDirty() || isReviewModePromptDirty();
	const worktreeDirty = worktreeSubTab === "repo"
		? !configsEqual(wtRepoConfig, loadedWtRepoConfig.current)
		: !configsEqual(wtLocalConfig, loadedWtLocalConfig.current);

	function discardProjectConfig() {
		setProjectConfig(loadedProjectConfig.current);
		const initial = initialAiReviewRef.current;
		setAiReviewAgentId(initial.agentId);
		setAiReviewConfigId(initial.configId);
		setAiReviewPrompt(initial.prompt);
	}

	function discardWorktreeConfig() {
		if (worktreeSubTab === "repo") setWtRepoConfig(loadedWtRepoConfig.current);
		else setWtLocalConfig(loadedWtLocalConfig.current);
	}

	async function saveWorktreeConfig() {
		if (worktreeSubTab === "repo") await handleSaveWtRepo();
		else await handleSaveWtLocal();
	}

	return {
		project,
		t,
		projectId,
		projects,
		tasks,
		dispatch,
		initialTab,
		initialWorktreeTaskId,
		labelTaskCounts,
		importingConversations,
		setImportingConversations,
		activeTab,
		setActiveTab,
		automationsTabHidden,
		labelCreationHidden,
		projectConfigFromProject,
		projectConfig,
		setProjectConfig,
		savingProject,
		setSavingProject,
		loadedProjectConfig,
		worktreeSubTab,
		setWorktreeSubTab,
		selectedWorktreeTaskId,
		setSelectedWorktreeTaskId,
		wtRepoConfig,
		setWtRepoConfig,
		wtLocalConfig,
		setWtLocalConfig,
		savingWtRepo,
		setSavingWtRepo,
		savingWtLocal,
		setSavingWtLocal,
		wtConfigLoadState,
		setWtConfigLoadState,
		loadedWtRepoConfig,
		loadedWtLocalConfig,
		labelSaving,
		setLabelSaving,
		columnSaving,
		setColumnSaving,
		draggedLabelId,
		setDraggedLabelId,
		labelDropTarget,
		setLabelDropTarget,
		githubStatus,
		setGitHubStatus,
		envTextError,
		setEnvTextError,
		configFileOverride,
		setConfigFileOverride,
		refreshConfigFileOverride,
		reviewConfig,
		aiReviewAgentId,
		setAiReviewAgentId,
		aiReviewConfigId,
		setAiReviewConfigId,
		aiReviewPrompt,
		setAiReviewPrompt,
		initialAiReviewRef,
		availableAgents,
		setAvailableAgents,
		reviewModePrompt,
		setReviewModePrompt,
		initialReviewModePromptRef,
		coordinatorPrompt,
		setCoordinatorPrompt,
		initialCoordinatorPromptRef,
		globalCoordinatorPrompt,
		setGlobalCoordinatorPrompt,
		globalReviewModePrompt,
		setGlobalReviewModePrompt,
		inheritedReviewModePrompt,
		globalArtifactTemplate,
		setGlobalArtifactTemplate,
		inheritedCoordinatorPrompt,
		worktreeTasks,
		selectedTask,
		configsEqual,
		projectConfigsEqual,
		seededUseRepoConfig,
		projectUseRepoConfig,
		isReviewModePromptDirty,
		isAiReviewDirty,
		reviewConfigKey,
		handleRenameProject,
		handleArtifactTemplateChange,
		handleAutoAccountExclusions,
		handleBoardCopyChange,
		handleToggleGitWorkflow,
		handleToggleStorage,
		handleToggleSensitive,
		handleToggleUseRepoConfig,
		handleAddLabel,
		handleUpdateLabel,
		handleDeleteLabel,
		commitLabelOrder,
		reorderLabelTo,
		moveLabelByStep,
		handleLabelDragOver,
		handleLabelDrop,
		handleAddColumn,
		handleUpdateColumn,
		handleDeleteColumn,
		handleSaveProjectConfig,
		handleSaveWtRepo,
		handleSaveWtLocal,
		saving,
		githubAccounts,
		activeGitHubAccount,
		selectedGitHubValue,
		selectedGitHubMissing,
		projectDirty,
		worktreeDirty,
		discardProjectConfig,
		discardWorktreeConfig,
		saveWorktreeConfig,
	};
}

export type ProjectSettingsController = NonNullable<ReturnType<typeof useProjectSettingsController>>;

export const ProjectSettingsControllerContext = createContext<ProjectSettingsController | null>(null);

export function useProjectSettingsContext(): ProjectSettingsController {
	const controller = useContext(ProjectSettingsControllerContext);
	if (!controller) throw new Error("useProjectSettingsContext() outside the Project Settings page");
	return controller;
}
