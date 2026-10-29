import { useState, useEffect, useRef, useCallback, useMemo, type Dispatch, type DragEvent, type MutableRefObject } from "react";
import { toast } from "../toast";
import { confirm } from "../confirm";
import { confirmCustomColumnDelete } from "../utils/confirmCustomColumnDelete";
import type { CodingAgent, ColumnAgentConfig, CustomColumn, Dev3RepoConfig, GitHubCliStatus, Label, Project, Task } from "../../shared/types";
import { ACTIVE_STATUSES, GIT_WORKFLOW_NOT_A_REPO_ERROR, getTaskTitle, gitWorkflowSwitchBlocker, hasGitWorkflow, repoConfigEnabled } from "../../shared/types";
import { builtinCoordinatorPrompt, COORDINATOR_PROMPT, DEFAULT_PR_REVIEW_PROMPT, DEFAULT_REVIEW_AGENT_ID, DEFAULT_REVIEW_CONFIG_ID, DEFAULT_REVIEW_PROMPT, resolveArtifactTemplate, resolvePresetPrompt, type ArtifactTemplateMode, type ProjectSettingsUpdate, type ResolvedArtifactTemplate } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import AutomationsPanel from "./AutomationsPanel";
import SettingsSection from "./global-settings/SettingsSection";
import ArtifactTemplateFolderField from "./global-settings/ArtifactTemplateFolderField";
import { ARTIFACT_TEMPLATE_MODE_LABELS } from "./global-settings/BehaviorSettingsSection";
import ProjectSpacesField from "./ProjectSpacesField";
import ImportConversationsModal from "./ImportConversationsModal";
import type { NavigationGuard } from "../navigation-guard";
import { useIsControlHidden } from "../hooks/useIsControlHidden";
import { BackIcon } from "./HeaderIcons";
import { ConfigForm } from "./project-settings/ConfigForm";
import { CustomColumnRow } from "./project-settings/CustomColumnRow";
import { LabelRow } from "./project-settings/LabelRow";
import { ProjectNameField } from "./project-settings/ProjectNameField";
import { CONFIG_BOOLEAN_DEFAULTS, decodeGitHubAccountValue, encodeGitHubAccountValue, formatGitHubAccountLabel, getEffectiveCompareRef, type ProjectConfigValues } from "./project-settings/config-values";
import { AddRowButton, EmptyHint, ToggleSwitch, WarningNote } from "./project-settings/fields";
import { AutoAccountExclusions } from "./project-settings/AutoAccountExclusions";

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

// ---- Main component ----

type ConfigTab = "global" | "project" | "worktree" | "automations";

type WorktreeSubTab = "repo" | "local";

/**
 * Strip empty strings from clonePaths and sparseCheckoutPaths before saving.
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
	return result;
}

interface ProjectSettingsProps {
	projectId: string;
	projects: Project[];
	tasks: Task[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	navigationGuardRef?: MutableRefObject<NavigationGuard | null>;
	initialTab?: ConfigTab;
	initialWorktreeTaskId?: string;
}

function ProjectSettings({
	projectId,
	projects,
	tasks,
	dispatch,
	navigate: _navigate,
	navigationGuardRef,
	initialTab,
	initialWorktreeTaskId,
}: ProjectSettingsProps) {
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
	const [activeTab, setActiveTab] = useState<ConfigTab>(
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
	useEffect(() => {
		if (project) {
			api.request.getProjectConfigFiles({ projectId }).then(({ hasRepoConfig: hasRepo, hasLocalConfig: hasLocal }) => {
				if (hasLocal) setConfigFileOverride(".dev3/config.local.json");
				else if (hasRepo) setConfigFileOverride(".dev3/config.json");
				else setConfigFileOverride(null);
			}).catch(() => {});
		}
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

	const isDirty = useCallback(() => {
		if (activeTab === "project") {
			return !projectConfigsEqual(projectConfig, loadedProjectConfig.current) || isAiReviewDirty() || isReviewModePromptDirty();
		}
		if (activeTab === "worktree") {
			if (worktreeSubTab === "repo") return !configsEqual(wtRepoConfig, loadedWtRepoConfig.current);
			return !configsEqual(wtLocalConfig, loadedWtLocalConfig.current);
		}
		return false; // Global tab uses immediate save
	}, [activeTab, worktreeSubTab, projectConfig, wtRepoConfig, wtLocalConfig, projectConfigsEqual, configsEqual, isAiReviewDirty, isReviewModePromptDirty]);

	const handleSaveRef = useRef<() => Promise<void>>(async () => {});

	// Register navigation guard
	useEffect(() => {
		if (navigationGuardRef) {
			navigationGuardRef.current = {
				isDirty,
				onSave: () => handleSaveRef.current(),
			};
		}
		return () => {
			if (navigationGuardRef) navigationGuardRef.current = null;
		};
	}, [isDirty]); // eslint-disable-line react-hooks/exhaustive-deps

	if (!project) {
		return (
			<div className="h-full w-full flex items-center justify-center">
				<span className="text-danger text-base">{t("project.notFound")}</span>
			</div>
		);
	}

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
		try {
			const updated = await api.request.updateProjectSettings({ projectId, useRepoConfig: next });
			dispatch({ type: "updateProject", project: updated });
			const reseeded = projectConfigFromProject(updated);
			setProjectConfig(reseeded);
			loadedProjectConfig.current = reseeded;
			const files = await api.request.getProjectConfigFiles({ projectId });
			setConfigFileOverride(files.hasLocalConfig
				? ".dev3/config.local.json"
				: files.hasRepoConfig ? ".dev3/config.json" : null);
		} catch (err) {
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
			const updatedProjects = await api.request.getProjects();
			for (const p of updatedProjects) dispatch({ type: "updateProject", project: p });
		} catch (err) {
			toast.error(t("projectSettings.failedSave", { error: String(err) }), { projectId });
		}
		setSavingWtLocal(false);
	}

	// Keep the ref in sync for the navigation guard
	handleSaveRef.current = async () => {
		if (envTextError) return;
		if (activeTab === "project") await handleSaveProjectConfig();
		else if (activeTab === "worktree") {
			if (worktreeSubTab === "repo") await handleSaveWtRepo();
			else await handleSaveWtLocal();
		}
	};
	const tabButtonProps = (tab: ConfigTab) => ({
		role: "tab",
		"aria-selected": activeTab === tab,
		tabIndex: activeTab === tab ? 0 : -1,
		onClick: () => setActiveTab(tab),
		className: `flex-1 px-4 py-2 text-sm font-medium rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/60 transition-[color,background-color,box-shadow,transform] duration-150 ease-out active:scale-[0.98] ${
			activeTab === tab
				? "bg-accent-fill text-white shadow-sm"
				: "text-fg-3 hover:text-fg-2 hover:bg-elevated"
		}`,
	});

	function handleMainTabListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
		const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
		const currentIndex = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
		let nextIndex = currentIndex;
		if (e.key === "ArrowRight" || e.key === "ArrowDown") {
			nextIndex = (currentIndex + 1) % tabs.length;
			e.preventDefault();
		} else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
			nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
			e.preventDefault();
		} else if (e.key === "Home") {
			nextIndex = 0;
			e.preventDefault();
		} else if (e.key === "End") {
			nextIndex = tabs.length - 1;
			e.preventDefault();
		} else {
			return;
		}
		tabs[nextIndex].focus();
		tabs[nextIndex].click();
	}

	const dirty = isDirty();
	const saving = savingProject || savingWtRepo || savingWtLocal;
	const githubAccounts = githubStatus?.accounts ?? [];
	const activeGitHubAccount = githubAccounts.find((account) => account.active) ?? null;
	const selectedGitHubValue = projectConfig.githubAuthHost && projectConfig.githubAuthLogin
		? encodeGitHubAccountValue({ host: projectConfig.githubAuthHost, login: projectConfig.githubAuthLogin })
		: "";
	const selectedGitHubMissing = !!selectedGitHubValue
		&& !githubAccounts.some((account) => encodeGitHubAccountValue(account) === selectedGitHubValue);

	function handleDiscardCurrentTab() {
		if (activeTab === "project") {
			setProjectConfig(loadedProjectConfig.current);
			const initial = initialAiReviewRef.current;
			setAiReviewAgentId(initial.agentId);
			setAiReviewConfigId(initial.configId);
			setAiReviewPrompt(initial.prompt);
			return;
		}
		if (activeTab === "worktree") {
			if (worktreeSubTab === "repo") {
				setWtRepoConfig(loadedWtRepoConfig.current);
				return;
			}
			setWtLocalConfig(loadedWtLocalConfig.current);
		}
	}

	return (
		<div className="h-full w-full flex flex-col">
			<div className="flex-1 overflow-y-auto p-7">
				<div className="max-w-3xl mx-auto bg-raised/80 backdrop-blur-sm border border-edge/50 rounded-2xl p-6 space-y-7">

					{/* Back button when navigated from a task */}
					{initialWorktreeTaskId && (() => {
						const backTask = tasks.find((t) => t.id === initialWorktreeTaskId);
						return backTask ? (
							<button
								type="button"
								onClick={() => _navigate({ screen: "project", projectId, activeTaskId: initialWorktreeTaskId })}
								className="header-anim flex items-center gap-1.5 text-fg-3 hover:text-fg-2 text-sm transition-colors -mt-1 -mb-3"
							>
								<BackIcon className="w-3.5 h-3.5 flex-shrink-0" />
								<span className="truncate max-w-xs">{getTaskTitle(backTask)}</span>
							</button>
						) : null;
					})()}

					{/* 3-tab selector */}
					<div>
						<div role="tablist" aria-label={t("projectSettings.tabsAria")} className="flex gap-1 bg-elevated/50 rounded-xl p-1 mb-1" onKeyDown={handleMainTabListKeyDown}>
							<button type="button" {...tabButtonProps("global")}>
								{t("projectSettings.tabGlobal")}
							</button>
							{/* Operations boards have no git repo — the Project/Worktree config
							    tabs are git-only, so hide them and keep just the Board tab. */}
							{project.kind !== "virtual" && (
								<button type="button" {...tabButtonProps("project")}>
									{t("projectSettings.tabProject")}
								</button>
							)}
							{/* Worktree settings mean nothing once the git workflow is off. */}
							{hasGitWorkflow(project) && (
								<button type="button" {...tabButtonProps("worktree")}>
									{t("projectSettings.tabWorktree")}
								</button>
							)}
							{!automationsTabHidden && (
								<button type="button" {...tabButtonProps("automations")}>
									{t("automations.tabLabel")}
								</button>
							)}
						</div>
						<p className="text-fg-muted text-xs px-1">
							{activeTab === "global" && t("projectSettings.tabGlobalDesc")}
							{activeTab === "project" && (repoConfigEnabled(project)
								? t("projectSettings.tabProjectDesc")
								: t("projectSettings.tabProjectDescNoRepo"))}
							{activeTab === "worktree" && t("projectSettings.tabWorktreeDesc")}
							{activeTab === "automations" && t("automations.tabDesc")}
						</p>
					</div>

					{/* ======== Automations tab ======== */}
					{activeTab === "automations" && !automationsTabHidden && (
						<div data-help-id="project-settings.automations">
							<AutomationsPanel project={project} />
						</div>
					)}

					{/* ======== Global tab ======== */}
					{activeTab === "global" && (
						<div data-help-id="project-settings.board">
							<SettingsSection
								title={t("projectSettings.projectName")}
								description={t("projectSettings.projectNameDesc")}
							>
							<ProjectNameField project={project} onRename={handleRenameProject} />
							</SettingsSection>

							<SettingsSection
								title={t("customColumns.settingsTitle")}
								description={t("customColumns.settingsDesc")}
							>
							<div>
								<div className="space-y-2">
									{(project.customColumns ?? []).map((col: CustomColumn) => (
										<CustomColumnRow
											key={col.id}
											column={col}
											saving={columnSaving === col.id}
											onUpdate={(name, color, llmInstruction, agentConfig) => handleUpdateColumn(col.id, name, color, llmInstruction, agentConfig)}
											onDelete={() => handleDeleteColumn(col.id)}
											availableAgents={availableAgents}
											projectId={projectId}
										/>
									))}
									{(project.customColumns ?? []).length === 0 && (
										<EmptyHint>
											{t("customColumns.noColumns")}
											<span className="block text-xs mt-1">{t("customColumns.noColumnsHint")}</span>
										</EmptyHint>
									)}
								</div>
								<AddRowButton onClick={handleAddColumn} disabled={columnSaving !== null}>
									{t("customColumns.addColumn")}
								</AddRowButton>
							</div>
							</SettingsSection>

							<SettingsSection
								title={t("labels.settingsTitle")}
								description={t("labels.settingsDesc")}
							>
							<div>
								<div className="space-y-2">
									{(project.labels ?? []).map((label: Label, index: number) => (
										<LabelRow
											key={label.id}
											label={label}
											saving={labelSaving === label.id}
											onUpdate={(name, color) => handleUpdateLabel(label.id, name, color)}
											onDelete={() => handleDeleteLabel(label.id)}
											nameLabel={t("labels.labelName")}
											deleteLabel={t("labels.deleteLabel")}
											taskCount={labelTaskCounts.get(label.id) ?? 0}
											reorderEnabled={(project.labels ?? []).length > 1}
											dragged={draggedLabelId === label.id}
											dropSide={labelDropTarget?.labelId === label.id ? labelDropTarget.side : null}
											isFirst={index === 0}
											isLast={index === (project.labels ?? []).length - 1}
											onDragStart={() => setDraggedLabelId(label.id)}
											onDragOver={(e) => handleLabelDragOver(e, label.id)}
											onDragLeave={() => setLabelDropTarget((cur) => (cur?.labelId === label.id ? null : cur))}
											onDrop={(e) => handleLabelDrop(e, label.id)}
											onDragEnd={() => {
												setDraggedLabelId(null);
												setLabelDropTarget(null);
											}}
											onMoveUp={() => moveLabelByStep(label.id, -1)}
											onMoveDown={() => moveLabelByStep(label.id, 1)}
										/>
									))}
									{(project.labels ?? []).length === 0 && (
										<EmptyHint>{t("labels.noLabels")}</EmptyHint>
									)}
								</div>
								{!labelCreationHidden && (
									<AddRowButton onClick={handleAddLabel} disabled={labelSaving !== null}>
										{t("labels.addLabel")}
									</AddRowButton>
								)}
							</div>
							</SettingsSection>

							<SettingsSection
								title={t("spaces.sectionTitle")}
								description={t("spaces.sectionDesc")}
							>
							<ProjectSpacesField projectId={project.id} />
							</SettingsSection>

							{hasGitWorkflow(project) && (
								<SettingsSection
									title={t("boardCopy.sectionTitle")}
									description={t("boardCopy.sectionDesc")}
								>
								<div className="space-y-4">
									<div className="flex items-center justify-between gap-4">
										<div>
											<span className="block text-fg text-sm font-semibold mb-1">{t("boardCopy.toggle")}</span>
											<p className="text-fg-3 text-sm">{t("boardCopy.toggleHint")}</p>
										</div>
										<ToggleSwitch
											checked={project.boardCopy === true}
											ariaLabel={t("boardCopy.toggle")}
											onToggle={() => void handleBoardCopyChange({ boardCopy: project.boardCopy !== true })}
										/>
									</div>
									{project.boardCopy === true && (
										<div className="flex items-center justify-between gap-4">
											<div>
												<span className="block text-fg text-sm font-semibold mb-1">{t("boardCopy.messages")}</span>
												<p className="text-fg-3 text-sm">{t("boardCopy.messagesHint")}</p>
											</div>
											<ToggleSwitch
												checked={project.boardCopyMessages === true}
												ariaLabel={t("boardCopy.messages")}
												onToggle={() => void handleBoardCopyChange({ boardCopyMessages: project.boardCopyMessages !== true })}
											/>
										</div>
									)}
								</div>
								</SettingsSection>
							)}

							{project.kind !== "virtual" && (
								<SettingsSection
									title={t("projectSettings.importConversations")}
									description={t("projectSettings.importConversationsDesc")}
								>
								<button
									type="button"
									onClick={() => setImportingConversations(true)}
									className="px-4 py-2 bg-raised border border-edge rounded-xl text-fg-2 text-sm hover:border-edge-active hover:text-fg transition-colors"
								>
									{t("projectSettings.importConversationsBtn")}
								</button>
								</SettingsSection>
							)}

							{project.kind !== "virtual" && (
								<SettingsSection
									title={t("projectSettings.groupGitWorkflow")}
									description={t("projectSettings.groupGitWorkflowDesc")}
								>
								<div className="flex items-center justify-between gap-4">
									<div>
										<span className="block text-fg text-sm font-semibold mb-1">
											{t("projectSettings.gitWorkflow")}
										</span>
										<p className="text-fg-3 text-sm">
											{hasGitWorkflow(project)
												? t("projectSettings.gitWorkflowOnHint")
												: t("projectSettings.gitWorkflowOffHint")}
										</p>
									</div>
									<ToggleSwitch
										checked={hasGitWorkflow(project)}
										ariaLabel={t("projectSettings.gitWorkflow")}
										onToggle={() => void handleToggleGitWorkflow(!hasGitWorkflow(project))}
									/>
								</div>
								</SettingsSection>
							)}

							<SettingsSection
								title={t("projectSettings.artifactTemplate")}
								description={t("projectSettings.artifactTemplateDesc")}
							>
							<select
								id="project-artifact-template"
								aria-label={t("projectSettings.artifactTemplate")}
								value={project.artifactTemplate ?? "inherit"}
								onChange={(e) => void handleArtifactTemplateChange({ artifactTemplate: e.target.value as ArtifactTemplateMode | "inherit" })}
								className="w-full sm:w-auto px-3 py-2 bg-raised border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors"
							>
								<option value="inherit">
									{t("projectSettings.artifactTemplateInherit", { value: t(ARTIFACT_TEMPLATE_MODE_LABELS[globalArtifactTemplate.mode]) })}
								</option>
								{(["on", "off", "custom"] as const).map((mode) => (
									<option key={mode} value={mode}>{t(ARTIFACT_TEMPLATE_MODE_LABELS[mode])}</option>
								))}
							</select>
							{project.artifactTemplate === "custom" && (
								<div className="mt-4">
									<ArtifactTemplateFolderField
										value={project.artifactTemplatePath ?? ""}
										placeholderPath={globalArtifactTemplate.path}
										projectId={projectId}
										onChange={(path) => void handleArtifactTemplateChange({ artifactTemplatePath: path })}
									/>
								</div>
							)}
							</SettingsSection>

							<AutoAccountExclusions project={project} onSave={(next) => void handleAutoAccountExclusions(next)} />

							<SettingsSection
								title={t("projectSettings.groupPrivacy")}
								description={t("projectSettings.groupPrivacyDesc")}
							>
							<div className="flex items-center justify-between gap-4">
								<div>
									<span className="block text-fg text-sm font-semibold mb-1">
										{t("projectSettings.sensitive")}
									</span>
									<p className="text-fg-3 text-sm">
										{t("projectSettings.sensitiveDesc")}
									</p>
								</div>
								<ToggleSwitch
									checked={project.sensitive ?? false}
									ariaLabel={t("projectSettings.sensitive")}
									onToggle={() => void handleToggleSensitive(!(project.sensitive ?? false))}
								/>
							</div>
							</SettingsSection>
						</div>
					)}

					{/* ======== Project tab ======== */}
					{activeTab === "project" && (project.kind === "virtual" ? (
						<p className="text-fg-muted text-sm italic">{t("projectSettings.virtualNoGitConfig")}</p>
					) : (
						<div className="space-y-7" data-help-id="project-settings.project">
							<SettingsSection
								title={t("projectSettings.groupRepoConfig")}
								description={t("projectSettings.groupRepoConfigDesc")}
							>
							<div className="flex items-center justify-between gap-4">
								<div>
									<span className="block text-fg text-sm font-semibold mb-1">
										{t("projectSettings.useRepoConfig")}
									</span>
									<p className="text-fg-3 text-sm">
										{repoConfigEnabled(project)
											? t("projectSettings.useRepoConfigOnHint")
											: t("projectSettings.useRepoConfigOffHint")}
									</p>
								</div>
								<ToggleSwitch
									checked={repoConfigEnabled(project)}
									ariaLabel={t("projectSettings.useRepoConfig")}
									onToggle={() => void handleToggleUseRepoConfig(!repoConfigEnabled(project))}
								/>
							</div>
							</SettingsSection>

							{!repoConfigEnabled(project) ? (
								<WarningNote>
									{configFileOverride
										? t("projectSettings.repoConfigIgnoredWithFile", { file: configFileOverride })
										: t("projectSettings.repoConfigIgnored")}
								</WarningNote>
							) : configFileOverride && (
								<WarningNote>
									{configFileOverride.includes("local")
										? t("projectSettings.projectOverriddenByLocal", { file: configFileOverride })
										: t("projectSettings.projectOverriddenByRepo", { file: configFileOverride })}
								</WarningNote>
							)}
							<ConfigForm
								config={projectConfig}
								onChange={setProjectConfig}
								projectId={projectId}
								projectPath={project.path}
								envStorageScope="project"
								onEnvErrorChange={setEnvTextError}
							/>

							<SettingsSection
								title={t("projectSettings.groupIntegrations")}
								description={t("projectSettings.groupIntegrationsDesc")}
							>
							<div className="space-y-2">
								<div>
									<label htmlFor="project-github-account" className="block text-fg text-sm font-semibold mb-1">
										{t("projectSettings.githubAccount")}
									</label>
									<p className="text-fg-3 text-sm">
										{t("projectSettings.githubAccountDesc")}
									</p>
								</div>
								<select
									id="project-github-account"
									aria-label={t("projectSettings.githubAccount")}
									value={selectedGitHubValue}
									onChange={(event) => {
										const nextValue = event.target.value;
										setProjectConfig((current) => ({
											...current,
											...(nextValue
												? decodeGitHubAccountValue(nextValue)
												: { githubAuthHost: null, githubAuthLogin: null }),
										}));
									}}
									disabled={githubStatus?.authStatus !== "authenticated"}
									className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm outline-none focus:border-accent/40 transition-colors disabled:opacity-60 disabled:cursor-not-allowed streamer-private"
								>
									<option value="">
										{activeGitHubAccount
											? t("projectSettings.githubAccountUseActive", {
												account: formatGitHubAccountLabel(activeGitHubAccount, githubAccounts),
											})
											: t("projectSettings.githubAccountUseActiveUnknown")}
									</option>
									{githubAccounts.map((account) => (
										<option key={encodeGitHubAccountValue(account)} value={encodeGitHubAccountValue(account)}>
											{formatGitHubAccountLabel(account, githubAccounts)}
										</option>
									))}
								</select>
								{githubStatus?.authStatus === "not_installed" && (
									<p className="text-fg-muted text-xs">
										{t("projectSettings.githubAccountNotInstalled")}
									</p>
								)}
								{githubStatus?.authStatus === "not_authenticated" && (
									<p className="text-fg-muted text-xs">
										{t("projectSettings.githubAccountNotAuthenticated")}
									</p>
								)}
								{selectedGitHubMissing && (
									<p className="text-danger text-xs">
										{t("projectSettings.githubAccountMissing")}
									</p>
								)}
							</div>

							{/* AI Review Column */}
							<div className="space-y-4">
								<div>
									<span className="block text-fg text-sm font-semibold mb-1">
										{t("projectSettings.aiReview")}
									</span>
									<p className="text-fg-3 text-sm">
										{t("projectSettings.aiReviewDesc")}
									</p>
								</div>
								<div className="space-y-3 pl-1">
									<div className="flex items-center gap-3">
										<label htmlFor="ai-review-agent" className="text-fg-2 text-sm w-28 flex-shrink-0">{t("projectSettings.aiReviewAgent")}</label>
										<select
											id="ai-review-agent"
											value={aiReviewAgentId}
											onChange={(e) => {
												setAiReviewAgentId(e.target.value);
												const agent = availableAgents.find((a) => a.id === e.target.value);
												if (agent?.configurations?.length) {
													setAiReviewConfigId(agent.configurations[0].id);
												}
											}}
											className="flex-1 px-3 py-2 bg-raised border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors"
										>
											{availableAgents.map((a) => (
												<option key={a.id} value={a.id}>{a.name}</option>
											))}
										</select>
									</div>
									<div className="flex items-center gap-3">
										<label htmlFor="ai-review-config" className="text-fg-2 text-sm w-28 flex-shrink-0">{t("projectSettings.aiReviewConfig")}</label>
										<select
											id="ai-review-config"
											value={aiReviewConfigId}
											onChange={(e) => setAiReviewConfigId(e.target.value)}
											className="flex-1 px-3 py-2 bg-raised border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors"
										>
											{(availableAgents.find((a) => a.id === aiReviewAgentId)?.configurations ?? []).map((c) => (
												<option key={c.id} value={c.id}>{c.name || c.id}</option>
											))}
										</select>
									</div>
									<div>
										<label htmlFor="ai-review-prompt" className="block text-fg-2 text-sm mb-2">{t("projectSettings.aiReviewPrompt")}</label>
										<textarea
											id="ai-review-prompt"
											value={aiReviewPrompt}
											onChange={(e) => setAiReviewPrompt(e.target.value)}
											rows={5}
											placeholder={t("projectSettings.aiReviewPromptPlaceholder")}
											autoCapitalize="off"
											autoCorrect="off"
											spellCheck={false}
											className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
										/>
									</div>
								</div>
							</div>

							{/* Review toggle prompt (create-task popup) */}
							<div className="space-y-4">
								<div>
									<span className="block text-fg text-sm font-semibold mb-1">
										{t("projectSettings.reviewModePrompt")}
									</span>
									<p className="text-fg-3 text-sm">
										{t("projectSettings.reviewModePromptDesc")}
									</p>
								</div>
								<div className="space-y-3 pl-1">
									<textarea
										id="project-review-mode-prompt"
										aria-label={t("projectSettings.reviewModePrompt")}
										value={reviewModePrompt}
										onChange={(e) => setReviewModePrompt(e.target.value)}
										rows={8}
										placeholder={inheritedReviewModePrompt}
										autoCapitalize="off"
										autoCorrect="off"
										spellCheck={false}
										className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
									/>
									<div className="flex items-center gap-3">
										<button
											type="button"
											onClick={() => setReviewModePrompt(reviewModePrompt.trim() ? "" : inheritedReviewModePrompt)}
											className="text-sm text-fg-3 hover:text-accent transition-colors px-3 py-1.5 rounded-lg border border-edge hover:border-accent/30"
										>
											{reviewModePrompt.trim()
												? t("projectSettings.reviewModePromptReset")
												: t("projectSettings.reviewModePromptCopyInherited")}
										</button>
										<span className="text-fg-muted text-xs">
											{reviewModePrompt.trim()
												? t("projectSettings.reviewModePromptOverride")
												: t("projectSettings.reviewModePromptInherited")}
										</span>
									</div>
								</div>
							</div>
							{/* Coordinator task-type prompt (create-task popup) */}
							<div className="space-y-4">
								<div>
									<span className="block text-fg text-sm font-semibold mb-1">
										{t("projectSettings.coordinatorPrompt")}
									</span>
									<p className="text-fg-3 text-sm">
										{t("projectSettings.coordinatorPromptDesc")}
									</p>
								</div>
								<div className="space-y-3 pl-1">
									<textarea
										id="project-coordinator-prompt"
										aria-label={t("projectSettings.coordinatorPrompt")}
										value={coordinatorPrompt}
										onChange={(e) => setCoordinatorPrompt(e.target.value)}
										rows={8}
										placeholder={inheritedCoordinatorPrompt}
										autoCapitalize="off"
										autoCorrect="off"
										spellCheck={false}
										className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
									/>
									<div className="flex items-center gap-3">
										<button
											type="button"
											onClick={() => setCoordinatorPrompt(coordinatorPrompt.trim() ? "" : inheritedCoordinatorPrompt)}
											className="text-sm text-fg-3 hover:text-accent transition-colors px-3 py-1.5 rounded-lg border border-edge hover:border-accent/30"
										>
											{coordinatorPrompt.trim()
												? t("projectSettings.coordinatorPromptReset")
												: t("projectSettings.coordinatorPromptCopyInherited")}
										</button>
										<span className="text-fg-muted text-xs">
											{coordinatorPrompt.trim()
												? t("projectSettings.coordinatorPromptOverride")
												: t("projectSettings.coordinatorPromptInherited")}
										</span>
									</div>
								</div>
							</div>
							</SettingsSection>
						</div>
					))}

					{/* ======== Worktree tab ======== */}
					{activeTab === "worktree" && hasGitWorkflow(project) && (
						<div className="space-y-7" data-help-id="project-settings.worktree">
							{/* The tab stays visible and explains itself: a tab that vanishes
							    when a setting flips reads as a bug, not as a consequence. */}
							{!repoConfigEnabled(project) ? (
								<WarningNote>{t("projectSettings.worktreeRepoConfigIgnored")}</WarningNote>
							) : worktreeTasks.length === 0 ? (
								<div className="flex flex-col items-center gap-3 py-8 text-center">
									<span className="text-2xl leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF013"}</span>
									<p className="text-fg-muted text-sm max-w-sm">{t("projectSettings.noActiveWorktrees")}</p>
								</div>
							) : (
								<>
									{/* How it works */}
									<div className="px-3 py-2.5 bg-elevated/60 border border-edge/40 rounded-lg">
										<p className="text-fg-3 text-xs leading-relaxed">{t("projectSettings.worktreeHowItWorks")}</p>
									</div>

									{/* Task selector */}
									<div>
										<label htmlFor="worktree-task-selector" className="block text-fg-3 text-xs mb-1">{t("projectSettings.worktreeSelector")}</label>
										<select
											id="worktree-task-selector"
											value={selectedWorktreeTaskId ?? ""}
											onChange={(e) => setSelectedWorktreeTaskId(e.target.value)}
											className="w-full px-3 py-2 bg-elevated border border-edge rounded-lg text-fg text-sm outline-none focus:border-accent/40 transition-colors"
										>
											{worktreeTasks.map((task) => (
												<option key={task.id} value={task.id}>
													{getTaskTitle(task)}
												</option>
											))}
										</select>
									</div>

									{/* Repo / Local sub-tabs */}
									<div>
										<div role="tablist" aria-label={t("projectSettings.worktreeSubTabsAria")} className="flex gap-1 bg-elevated/50 rounded-xl p-1 mb-1" onKeyDown={handleMainTabListKeyDown}>
											{([
												{ id: "repo" as WorktreeSubTab, label: t("projectSettings.worktreeRepoTab") },
												{ id: "local" as WorktreeSubTab, label: t("projectSettings.worktreeLocalTab") },
											]).map((tab) => (
												<button
													key={tab.id}
													type="button"
													role="tab"
													aria-selected={worktreeSubTab === tab.id}
													tabIndex={worktreeSubTab === tab.id ? 0 : -1}
													onClick={() => setWorktreeSubTab(tab.id)}
													className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/60 transition-[color,background-color,box-shadow,transform] duration-150 ease-out active:scale-[0.98] ${
														worktreeSubTab === tab.id
															? "bg-accent-fill text-white shadow-sm"
															: "text-fg-3 hover:text-fg-2 hover:bg-elevated"
													}`}
												>
													{tab.label}
												</button>
											))}
										</div>
										<p className="text-fg-muted text-xs px-1">
											{worktreeSubTab === "repo"
												? t("projectSettings.worktreeRepoDesc")
												: t("projectSettings.worktreeLocalDesc")}
										</p>
									</div>

									{worktreeSubTab === "repo" ? (
										<ConfigForm
											key={worktreeSubTab}
											config={wtRepoConfig}
											onChange={setWtRepoConfig}
											projectId={projectId}
											projectPath={selectedTask?.worktreePath ?? project.path}
											envStorageScope="repo"
											onEnvErrorChange={setEnvTextError}
										/>
									) : (
										<ConfigForm
											key={worktreeSubTab}
											config={wtLocalConfig}
											onChange={setWtLocalConfig}
											inherited={wtRepoConfig}
											projectId={projectId}
											projectPath={selectedTask?.worktreePath ?? project.path}
											envStorageScope="local"
											onEnvErrorChange={setEnvTextError}
										/>
									)}
								</>
							)}
						</div>
					)}

				</div>
			</div>
			{dirty && (
				<div role="status" className="border-t border-edge/60 bg-overlay/95 backdrop-blur px-7 py-4 motion-safe:animate-slide-up">
					<div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
						<p className="text-sm text-fg-2">{t("unsavedChanges.banner")}</p>
						<div className="flex items-center gap-3">
							<button
								type="button"
								onClick={handleDiscardCurrentTab}
								className="px-4 py-2 text-sm font-medium rounded-xl text-fg-2 outline-none hover:text-fg hover:bg-overlay-hover focus-visible:ring-2 focus-visible:ring-accent/50 transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96]"
							>
								{t("unsavedChanges.discard")}
							</button>
							<button
								type="button"
								onClick={() => handleSaveRef.current()}
								disabled={saving || envTextError}
								className="px-5 py-2.5 bg-accent-fill text-white text-sm font-semibold rounded-xl outline-none hover:bg-accent-fill-hover focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-base disabled:opacity-50 shadow-lg shadow-accent/20 transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.96]"
							>
								{saving ? t("projectSettings.saving") : t("unsavedChanges.save")}
							</button>
						</div>
					</div>
				</div>
			)}
			{importingConversations && (
				<ImportConversationsModal project={project} onClose={() => setImportingConversations(false)} />
			)}
		</div>
	);
}

export default ProjectSettings;
