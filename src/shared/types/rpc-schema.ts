import type { InterfaceOnboardingRequest, InterfaceOnboardingResponse } from "../interface-onboarding";
import type { RPCSchema } from "electrobun/bun";
import type { ConversationMatch } from "../conversation-search-core";
import type { ImportConversationsResult, ImportableConversationView } from "../conversation-import-model";
import type { HandoffPreview, SpawnAgentResult } from "../conversation-handoff-model";
import type { TaskConversationView } from "../task-conversation-model";
import type { AgentRateLimitsReport } from "../rate-limits";
import type { AutoAccountPreview } from "../account-routing";
import type { AccountLoginState, AgentAccount, AgentAccountKind, AgentAccountsState, ClaudeSlotModels, PinnedClaudeLogin, ProjectClaudeLogin } from "../agent-accounts";
import type { TerminalBackendIdentity } from "../terminal-backend-identity";
import type { TaskPaneState, TaskPaneAction, TmuxCloseWindowResult } from "../task-panes";
import type { DeepLinkNav } from "../deep-link";
import type { ReviewComment, ReviewReplyAuthor } from "../review";
import type { TelemetryProfile } from "../telemetry-profile";
import type { AgentPromptDelivery } from "../agent-prompt-delivery";
import type { AgentMessageLogPage } from "../agent-message-log";
import type { NotificationLogPage } from "../notification-log";
import type { TaskPeekSnapshot } from "../task-peek";
import type { TaskSoundStatus } from "../task-sound-statuses";
import type { ChangelogEntry, UpdateChangelog, UpdatePopoverPreview } from "./changelog";
import type { TaskResetConsent, TaskResetResult, TaskStatus, WorktreeAccessState } from "./task-status";
import type { TaskPriority } from "./task-priority";
import type { TaskType } from "./task-type";
import type { Task } from "./task";
import type { ColumnAgentConfig, ColumnAgentFailureReason, ColumnAgentIdentity } from "./column-agents";
import type { AgentModelAvailability, CodingAgent } from "./coding-agents";
import type { AgentLiveModels } from "../agent-live-models";
import type { ExternalApp, FilePreviewResult, GlobalSettings, NativeTerminalAvailability, ResolvedTerminalPath, TaskTerminalBackendInfo, TipState } from "./global-settings";
import type { ModelCatalogView, ModelSidecarStatus, PxpipeProxyStatus } from "./model-routing";
import type { AutoConfigureResult, ConfigSourceEntry, Dev3RepoConfig, GitHubCliStatus, GitInitOffer, Project, ProjectSettingsUpdate, PrResolveFailureReason, ShellAvailability, ShellPromptPreview } from "./project";
import type { CustomColumn, Label } from "./labels-columns";
import type { Space, SpacesFile } from "./spaces";
import type { AgentCancellationRequest, AgentCompletionRequest, AgentLaunchChoice, AgentLaunchRequest, LaunchVariant, TaskDialogSubject } from "./agent-launch";
import type { ScheduledMessageTarget } from "./scheduled-messages";
import type { SharedArtifact, SharedImage } from "./shared-media";
import type { ScriptPlacement, ScriptRunner, ScriptSource, WorktreeScripts } from "./package-scripts";
import type { TaskSessionState } from "./task-lifecycle";
import type { Automation, AutomationDraft } from "./automations";
import type { NoteSource } from "./task-notes";
import type { BranchStatus, MergeRoute, TaskDiffMode, TaskDiffResponse, UnsavedWork } from "./git-status";
import type { PRCheckInfo, PRCIStatus, PRInfo, PRMergeState, PRReviewDecision, PRReviewState, RefreshTaskPrStatusResult, TaskPRCommentsPayload } from "./pull-requests";
import type { ExposedPort, PortInfo, ResourceUsage, SystemMemorySnapshot, WorktreeOrphanGroup } from "./system-resources";
import type { PtyThroughputStats, TmuxLayout, TmuxSessionInfo, TmuxWindowEntry } from "./tmux";
import type { DevServerStatus, DevServerSummary } from "./dev-server";
import type { RemoteAccessStatus, RemoteNetInterface } from "./remote";
import type { AgentCheckResult, AgentSkillInfo, HarnessReadinessReport, RequirementCheckResult, RosettaWarningInfo } from "./environment";
import type { ExplorerListing, FolderListing } from "./file-explorer";
import type { AgentUsageReport, ProductivityStats } from "./usage-stats";

export type RendererLogLevel = "debug" | "info" | "warn" | "error";

// ---- CLI socket protocol ----

export interface CliRequest {
	id: string;
	method: string;
	params: Record<string, unknown>;
	/**
	 * Endpoint token, sent only over the Windows loopback-TCP transport (a
	 * loopback port has none of a socket file's access control). Absent on every
	 * Unix-socket request, which keeps that wire format unchanged. See
	 * `src/shared/cli-endpoint.ts`.
	 */
	token?: string;
}

export interface CliResponse {
	id: string;
	ok: boolean;
	data?: unknown;
	error?: string;
}

// ---- RPC schema ----

export type AppRPCSchema = {
	bun: RPCSchema<{
		requests: {
			getProjects: {
				params: void;
				response: Project[];
			};
			reorderProjects: {
				params: { projectIds: string[] };
				response: Project[];
			};
			getSpaces: {
				params: Record<string, never>;
				response: SpacesFile;
			};
			createSpace: {
				params: { name: string; projectIds: string[] };
				response: Space;
			};
			renameSpace: {
				params: { spaceId: string; name: string };
				response: Space;
			};
			deleteSpace: {
				params: { spaceId: string };
				response: void;
			};
			setProjectSpaces: {
				params: { projectId: string; spaceIds: string[] };
				response: { file: SpacesFile; autoDeleted: Space[] };
			};
			setSpaceSensitive: {
				params: { spaceId: string; sensitive: boolean };
				response: Space;
			};
			reorderSpaces: {
				params: { order: string[] };
				response: SpacesFile;
			};
			reorderSpaceProjects: {
				params: { spaceId: string; projectIds: string[] };
				response: Space;
			};
			listDirectory: {
				params: { path?: string | null; includeFiles?: boolean; showHidden?: boolean };
				response: FolderListing;
			};
			/** One level of the file explorer tree, gated to the task worktree or project checkout. */
			listExplorerDirectory: {
				params: { projectId: string; taskId?: string | null; relPath?: string; insideIgnored?: boolean };
				response: ExplorerListing;
			};
			listAgentSkills: {
				params: { projectPath?: string | null };
				response: AgentSkillInfo[];
			};
			createCustomColumn: {
				params: { projectId: string; name: string; color?: string };
				response: CustomColumn;
			};
			updateCustomColumn: {
				params: { projectId: string; columnId: string; name?: string; color?: string; llmInstruction?: string; agentConfig?: ColumnAgentConfig | null };
				response: CustomColumn;
			};
			renameBuiltinColumn: {
				params: { projectId: string; status: TaskStatus; name: string | null };
				response: Project;
			};
			deleteCustomColumn: {
				params: { projectId: string; columnId: string };
				response: void;
			};
			moveTaskToCustomColumn: {
				params: { taskId: string; projectId: string; customColumnId: string | null };
				response: Task;
			};
			reorderColumns: {
				params: { projectId: string; columnOrder: string[] };
				response: Project;
			};
			reorderLabels: {
				params: { projectId: string; labelOrder: string[] };
				response: Project;
			};
			addProject: {
				/** `name` is optional: the backend derives it from the path, which is the
				 *  only side that knows how to spell a path on its own platform. */
				/** `autoConfigure` writes detected settings to `.dev3/config.local.json`; `autoConfigured` reports the outcome. */
				params: { path: string; name?: string; autoConfigure?: boolean };
				/** `gitInit` is set when the folder could be made a repo in place (needs the user's confirmation). */
				response: { ok: true; project: Project; autoConfigured?: AutoConfigureResult } | { ok: false; error: string; gitInit?: GitInitOffer };
			};
			cloneAndAddProject: {
				params: { url: string; baseDir: string; repoName?: string; progressId?: string; autoConfigure?: boolean };
				response: { ok: true; project: Project; autoConfigured?: AutoConfigureResult } | { ok: false; error: string };
			};
			createDirectory: {
				params: { parentPath: string; name: string };
				response: { ok: true; path: string } | { ok: false; error: string };
			};
			initAndAddProject: {
				/** `initNonEmpty`: the user confirmed initializing a folder that already has files. */
				params: { path: string; name?: string; initNonEmpty?: boolean; autoConfigure?: boolean };
				response: { ok: true; project: Project; gitInit?: GitInitOffer; autoConfigured?: AutoConfigureResult } | { ok: false; error: string; gitInit?: GitInitOffer };
			};
			/** Create (or re-open) the throwaway sandbox repo dev3 owns, under `~/.dev3.0/sandbox`. */
			createSandboxProject: {
				params: void;
				response: { ok: true; project: Project } | { ok: false; error: string };
			};
			/** Create a virtual "Operations" board (no git repo). Stored in virtual-projects.json. */
			addVirtualProject: {
				params: { name: string };
				response: { ok: true; project: Project } | { ok: false; error: string };
			};
			removeProject: {
				params: { projectId: string };
				response: void;
			};
			detectClonePaths: {
				params: { projectId: string };
				response: string[];
			};
			/** Resolve a task's effective project settings — the same worktree+main
			 *  `.dev3/` cascade a dev-server start or a setup run uses. */
			getResolvedProject: {
				params: { projectId: string; taskId: string };
				response: Project;
			};
			/** Load raw contents of .dev3/config.json and .dev3/config.local.json + app-level config. */
			getProjectConfigs: {
				params: { projectId: string; worktreePath?: string };
				response: { repo: Dev3RepoConfig; local: Dev3RepoConfig };
			};
			/** Check which .dev3/ config files exist in the project root. */
			getProjectConfigFiles: {
				params: { projectId: string };
				response: { hasRepoConfig: boolean; hasLocalConfig: boolean };
			};
			/**
			 * Resolve a "My template" folder (blank = the default one). With `seed`, a
			 * missing or empty folder is filled with a copy of the dev3 template; a
			 * folder that already holds files is never touched.
			 */
			prepareCustomArtifactTemplate: {
				params: { path?: string; seed?: boolean };
				response: { path: string; exists: boolean; seeded: boolean };
			};
			/** Update project settings in projects.json (scripts, clone paths, AI Review, etc.). */
			updateProjectSettings: {
				params: { projectId: string } & ProjectSettingsUpdate;
				response: Project;
			};
			/** Save to .dev3/config.json. When autoCommit is true, commits the change in the worktree. */
			saveRepoConfig: {
				params: { projectId: string; worktreePath?: string; autoCommit?: boolean } & Dev3RepoConfig;
				response: void;
			};
			/** Save to .dev3/config.local.json. */
			saveLocalConfig: {
				params: { projectId: string; worktreePath?: string } & Dev3RepoConfig;
				response: void;
			};
			/** Per-field source provenance (repo or local). */
			getRepoConfigSources: {
				params: { projectId: string; worktreePath?: string };
				response: ConfigSourceEntry[];
			};
			getGlobalSettings: {
				params: void;
				response: GlobalSettings;
			};
			getGitHubCliStatus: {
				params: void;
				response: GitHubCliStatus;
			};
			/** Which shells this machine has, and which one dev3 actually runs. */
			getShellAvailability: {
				params: void;
				response: ShellAvailability;
			};
			/** Render a zsh prompt style against a demo repo; also how custom code is validated. */
			previewShellPrompt: {
				params: { source: string; columns?: number };
				response: ShellPromptPreview;
			};
			saveGlobalSettings: {
				params: GlobalSettings;
				response: void;
			};
			/** Toggle an (agentId, configId) pair in the global favorites list —
			 *  add it (with LFU-then-LRU eviction once MAX_FAVORITES is reached) or
			 *  remove it if already present. Returns the updated settings so the
			 *  renderer can sync its in-memory copy. */
			toggleFavoriteAgent: {
				params: { agentId: string; configId: string };
				response: GlobalSettings;
			};
			/** Report live state of the local pxpipe token-saving proxy (npx
			 *  availability, port 47821 owner, whether our managed instance runs). */
			pxpipeProxyStatus: {
				params: void;
				response: PxpipeProxyStatus;
			};
			/** Spawn the local pxpipe proxy (`npx -y pxpipe-proxy`) if not already
			 *  running. Returns the fresh status. Throws on npx-missing / port
			 *  held by a foreign process. */
			pxpipeProxyStart: {
				params: void;
				response: PxpipeProxyStatus;
			};
			/** Stop our managed pxpipe proxy (kills the pid tree, frees the port). */
			pxpipeProxyStop: {
				params: void;
				response: PxpipeProxyStatus;
			};
			/** The model catalog as the renderer may see it (no credential values). */
			modelCatalogGet: {
				params: void;
				response: ModelCatalogView;
			};
			/** Replace the catalog's providers and models. A key travels only in
			 *  `providerKeys` (provider id → new key; omitted = keep, empty = drop).
			 *  Restarts the sidecar, because its config is read once at startup. */
			modelCatalogSave: {
				params: { catalog: ModelCatalogView; providerKeys?: Record<string, string> };
				response: ModelCatalogView;
			};
			/** One provider's stored key in plain text, for the settings field's reveal
			 *  control. Asked for per provider and only on an explicit click: a
			 *  credential crosses to the renderer when the user looks at it, never
			 *  because a screen happened to load. */
			modelCatalogRevealKey: {
				params: { providerId: string };
				response: { key: string };
			};
			/** Live state of the model-catalog proxy sidecar. */
			modelSidecarStatus: {
				params: void;
				response: ModelSidecarStatus;
			};
			/** Start the sidecar on demand (no-op when it is already up). */
			modelSidecarStart: {
				params: void;
				response: ModelSidecarStatus;
			};
			/** Stop the sidecar; running agent sessions lose their route. */
			modelSidecarStop: {
				params: void;
				response: ModelSidecarStatus;
			};
			/** Model ids the sidecar can actually serve, for the model-id combobox.
			 *  Throws when the sidecar cannot be reached — an empty list must never
			 *  be mistaken for "this provider has no models". */
			modelCatalogListModels: {
				params: { providerKey?: string };
				response: { models: string[] };
			};
			/** Symlink the bundled dev3 CLI to ~/.dev3.0/bin/dev3 (for dev/debug), and
			 *  arm a sibling `dev3-self` aimed at THIS instance (`selfInstance` is the
			 *  baked-in `--instance` value). `bin/dev3` stays instance-neutral so agent
			 *  hooks keep resolving as they do today. */
			installDev3Cli: {
				params: void;
				response: { installedFrom: string; selfShimPath: string; selfInstance: string };
			};
			getAgents: {
				params: void;
				response: CodingAgent[];
			};
			saveAgents: {
				params: { agents: CodingAgent[] };
				response: void;
			};
			/** Which of an agent's preset models the signed-in account cannot select,
			 *  by probing the CLI's model-list command (Codex/Cursor today). Best-effort:
			 *  returns `{ status: "unknown" }` when it cannot tell, so the picker never
			 *  hides a model on a failed probe. `accountId` selects the account to probe
			 *  (matching the launch's account resolution); omitted uses the active one.
			 *  Cached briefly; `refresh` re-probes. */
			getAgentAvailableModels: {
				params: { agentId: string; accountId?: string | null; refresh?: boolean };
				response: AgentModelAvailability;
			};
			/** Models the agent CLI reports for the selected account (omp today),
			 *  newest first — the providers that account signed in to, not every
			 *  provider with an API key in the environment. `unknown` when the CLI
			 *  cannot be asked; the picker then shows only its presets. Cached briefly. */
			getAgentLiveModels: {
				params: { agentId: string; accountId?: string | null; refresh?: boolean };
				response: AgentLiveModels;
			};
			getTasks: {
				params: { projectId: string };
				response: Task[];
			};
			getAllProjectTasks: {
				params: void;
				/** `tasks` is the ACTIVE set only. `todoCount` is the work sitting on
				 *  the board that this list therefore never shows, so a caller can say
				 *  what it is hiding instead of implying the project holds nothing else. */
				response: { projectId: string; tasks: Task[]; todoCount: number }[];
			};
			getProductivityStats: {
				params: void;
				response: ProductivityStats;
			};
			getAgentUsage: {
				params: void;
				response: AgentUsageReport;
			};
			getAgentRateLimits: {
				params: void;
				response: AgentRateLimitsReport;
			};
			/**
			 * Latest system-memory snapshot, or null before the first poll completes.
			 * Used for the header widget's first render and by the launch-time banner;
			 * live updates arrive on the `systemMemoryUpdated` push.
			 */
			getSystemMemory: {
				params: void;
				response: SystemMemorySnapshot | null;
			};
			/**
			 * Leftover processes inside worktrees of tasks with no live session.
			 * On demand only (breakdown open / startup) — it costs an `lsof` over the
			 * whole process table, which is why it is not part of the memory poll.
			 */
			scanWorktreeOrphans: {
				params: void;
				response: WorktreeOrphanGroup[];
			};
			/** Kill exactly the PIDs the user confirmed. Returns how many actually died. */
			killWorktreeOrphans: {
				params: { pids: number[] };
				response: { killed: number; leftovers: number };
			};
			/** Agent account switcher (multi-account per agent CLI, hot-swap without re-login). */
			listAgentAccounts: {
				params: void;
				response: AgentAccountsState;
			};
			/** The Claude login a project pins via `CLAUDE_CONFIG_DIR` in its env. */
			getProjectClaudeLogin: {
				params: { projectId: string };
				response: ProjectClaudeLogin;
			};
			/** Every login some project pins via `CLAUDE_CONFIG_DIR`, one per directory. */
			listPinnedClaudeLogins: {
				params: void;
				response: PinnedClaudeLogin[];
			};
			importAgentAccount: {
				params: { kind: AgentAccountKind };
				response: AgentAccount;
			};
			addAgentApiProfile: {
				params: { kind: AgentAccountKind; label?: string; baseUrl?: string; apiKey?: string; model?: string; slotModels?: ClaudeSlotModels; envText?: string };
				response: AgentAccount;
			};
			/** Editable snapshot of an API profile, including the (user's own) API key value for the masked form field. */
			getAgentApiProfileDraft: {
				params: { kind: AgentAccountKind; accountId: string };
				response: { label: string; baseUrl: string; apiKey: string; model: string; slotModels: ClaudeSlotModels; envText: string; hasApiKey: boolean };
			};
			updateAgentApiProfile: {
				params: { kind: AgentAccountKind; accountId: string; label?: string; baseUrl?: string; apiKey?: string; model?: string; slotModels?: ClaudeSlotModels; envText?: string };
				response: AgentAccount;
			};
			/** Start or join the in-app sign-in terminal for a managed account (one per CLI). */
			startAccountLogin: {
				params: { kind: AgentAccountKind; remoteViewer: boolean };
				response: AccountLoginState;
			};
			getAccountLogin: {
				params: { kind: AgentAccountKind };
				response: AccountLoginState | null;
			};
			restartAccountLogin: {
				params: { loginId: string; remoteViewer: boolean };
				response: AccountLoginState;
			};
			getAccountLoginPtyUrl: {
				params: { sessionKey: string };
				response: string;
			};
			/** Cancel a sign-in in progress or dismiss a finished one; stops only its own process. */
			closeAccountLogin: {
				params: { loginId: string };
				response: void;
			};
			/** `accountId: "auto"` makes the usage-balanced router the default (claude/codex). */
			setActiveAgentAccount: {
				params: { kind: AgentAccountKind; accountId: string | null };
				response: void;
			};
			/** What Auto would pick for a launch right now; null for a harness Auto cannot route. */
			previewAutoAccount: {
				params: { kind: AgentAccountKind; projectId?: string | null };
				response: AutoAccountPreview | null;
			};
			removeAgentAccount: {
				params: { kind: AgentAccountKind; accountId: string };
				response: void;
			};
			renameAgentAccount: {
				params: { kind: AgentAccountKind; accountId: string; label: string };
				response: void;
			};
			searchConversations: {
				params: { projectId: string; query: string; currentTaskId?: string | null; limit?: number; allStatuses?: boolean };
				response: ConversationMatch[];
			};
			/**
			 * One task's own agent conversation, newest session first and one page of
			 * turns at a time. Reads the live transcript while the worktree exists and
			 * dev3's archived dump afterwards; an empty `sessions` list means nothing
			 * readable was found, never that the task was silent.
			 */
			readTaskConversation: {
				params: {
					projectId: string;
					taskId: string;
					sessionKey?: string | null;
					/** Page backwards: the turns immediately before this turn index. */
					before?: number | null;
					limit?: number;
				};
				response: TaskConversationView;
			};
			/**
			 * Claude Code and Codex conversations that ran in this project's directory
			 * and belong to no dev3 task. Read-only: nothing is created and a decline
			 * is not recorded, so the same list comes back next time.
			 */
			scanImportableConversations: {
				params: { projectId: string };
				response: { conversations: ImportableConversationView[] };
			};
			/** Turn the selected conversations into ordinary tasks. Idempotent per session id. */
			importConversations: {
				params: { projectId: string; sessionIds: string[] };
				response: ImportConversationsResult;
			};
			/**
			 * Records that dev3 has now asked this project's owner about importing,
			 * once. Spends the single unprompted offer — every later import is asked
			 * for from Project Settings, the Project menu or the palette.
			 */
			markConversationImportOffered: {
				params: { projectId: string };
				response: { project: Project };
			};
			createTask: {
				/**
				 * Optional board title. Set when the description leads with a built-in
				 * prompt preamble, so the card is named after the user's own text
				 * instead of the first 80 characters of the preamble. Distinct from
				 * `renameTask`'s customTitle: this does NOT mark the title user-edited,
				 * so an agent may still rename it.
				 */
				params: { projectId: string; description: string; title?: string; status?: TaskStatus; existingBranch?: string; scratch?: boolean; draft?: boolean; opsWorkDir?: string; priority?: TaskPriority; taskType?: TaskType };
				response: Task;
			};
			hibernateTask: {
				// GUI-only, one gesture, no confirmation: kills the agent, the tmux
				// session and the dev server, keeps the worktree. `freedRssBytes` is the
				// last resource-monitor reading before the kill (up to one poll old),
				// so the toast can quote roughly how much memory came back.
				params: { taskId: string; projectId: string };
				response: { task: Task; freedRssBytes: number | null };
			};
			/** Effective terminal backend for one task, plus the live-session gate. */
			getTaskTerminalBackend: {
				params: { taskId: string; projectId: string };
				response: TaskTerminalBackendInfo;
			};
			/**
			 * Per-task override for the NEXT launch. Refused (throws) while either
			 * backend still owns a live session — dev3 never migrates live terminal
			 * state, and a refusal writes nothing on either side.
			 */
			setTaskTerminalBackend: {
				params: { taskId: string; projectId: string; backend: TerminalBackendIdentity };
				response: Task;
			};
			/** Non-throwing probe of this build's native terminal host. */
			getNativeTerminalAvailability: {
				params: void;
				response: NativeTerminalAvailability;
			};
			/**
			 * Machine-local backend for NEW tasks, from its own versioned sidecar
			 * (never settings.json — an older side-by-side build would delete an
			 * unknown key there). Null means no preference ⇒ platform default.
			 */
			getNewTaskTerminalBackend: {
				params: void;
				response: { backend: TerminalBackendIdentity | null };
			};
			setNewTaskTerminalBackend: {
				params: { backend: TerminalBackendIdentity };
				response: { backend: TerminalBackendIdentity };
			};
			setTaskPriority: {
				// Writes the priority to this task only (never its variant siblings);
				// returns the task when it changed, so open surfaces re-render live.
				params: { taskId: string; projectId: string; priority: TaskPriority };
				response: Task[];
			};
			setTaskHidden: {
				params: { taskId: string; projectId: string; hidden: boolean };
				response: Task[];
			};
			moveTask: {
				// `clientPlayedSound`: the initiating renderer owns this move's sound — it
				// played the completion/cancel chime optimistically, or the user moved
				// the card into Your Review / Has Questions themselves, which has
				// nothing to announce. The backend must NOT
				// also push `taskSound` (that push still reaches a window and every
				// attached remote browser, so the chime would play a second time on
				// the same machine). Unset for CLI / branch-merge / agent
				// approval, where no renderer played locally and the push is the sound.
				params: { taskId: string; projectId: string; newStatus: TaskStatus; force?: boolean; clientPlayedSound?: boolean };
				response: Task;
			};
			// View → Debug probe: fires the same `taskSound` push a real CLI /
			// merge-driven completion fires, with no task involved. `pushed` is false
			// when the completion-sound setting is off (the real push is gated too).
			debugEmitTaskSound: {
				params: { status: "completed" | "cancelled" };
				response: { pushed: boolean };
			};
			/**
			 * The one door to a destructive To Do reset from the UI, called only after
			 * the user confirmed it. `consent` is what the dialog showed; a task that
			 * moved on to another run since is refused with nothing deleted.
			 */
			resetTaskToTodo: {
				params: { taskId: string; projectId: string; consent: TaskResetConsent };
				response: TaskResetResult;
			};
			cancelTaskPreparation: {
				params: { taskId: string; projectId: string };
				response: Task;
			};
			deleteTask: {
				params: { taskId: string; projectId: string };
				response: void;
			};
			moveTaskToProject: {
				// Relocate a To Do task to another project (true move, same id). The
				// backend re-derives project-scoped fields; the response is the moved
				// task as it now lives in the target project.
				params: { taskId: string; fromProjectId: string; toProjectId: string };
				response: Task;
			};
			editTask: {
				// One optional-field update for a To Do task: whatever is present is
				// written, everything else is left alone. Saving a draft is a single
				// call (and therefore a single persisted write) rather than a create
				// followed by best-effort title/label follow-ups.
				// `draft: false` promotes a draft into an ordinary task and requires a
				// non-empty description; there is no way back to `draft: true`.
				params: {
					taskId: string;
					projectId: string;
					description?: string;
					customTitle?: string | null;
					priority?: TaskPriority;
					labelIds?: string[];
					existingBranch?: string | null;
					draft?: boolean;
				};
				response: Task;
			};
			renameTask: {
				params: { taskId: string; projectId: string; customTitle: string | null };
				response: Task;
			};
			setUserOverview: {
				params: { taskId: string; projectId: string; userOverview: string };
				response: Task;
			};
			clearUserOverview: {
				params: { taskId: string; projectId: string };
				response: Task;
			};
			spawnVariants: {
				params: {
					taskId: string;
					projectId: string;
					targetStatus: TaskStatus;
					variants: LaunchVariant[];
				};
				response: Task[];
			};
			addAttempts: {
				params: {
					taskId: string;
					projectId: string;
					variants: LaunchVariant[];
				};
				response: Task[];
			};
			prepareMergeCompletionPrompt: {
				params: { taskId: string; projectId: string; fingerprint?: string | null; force?: boolean };
				response: { shouldPrompt: boolean; fingerprint: string | null; shouldNotify?: boolean };
			};
			dismissMergeCompletionPrompt: {
				params: { taskId: string; projectId: string; fingerprint: string | null };
				response: Task;
			};
			getPtyUrl: {
				params: { taskId: string; resume?: boolean };
				// `hibernated` marks a recovery offer the user must accept explicitly:
				// a hibernated task is never auto-restored just by opening it.
				response:
					| { url: string }
					| { recoverable: true; sessionState: TaskSessionState; hibernated?: true };
			};
			getPanePtyUrl: {
				params: { taskId: string; paneId: string };
				/** `gone` when the pane's host is no longer attachable, so every viewer
				 *  converges on the exited state instead of a dead socket. */
				response: { url: string } | { gone: true };
			};
			resumeTask: {
				params: { taskId: string };
				response: string;
			};
			restartTask: {
				params: { taskId: string };
				response: string;
			};
			/**
			 * Re-run the project's `setupScript` in its own auxiliary pane, leaving the
			 * agent and every other pane untouched. Clears the previous setup verdict and
			 * arms a fresh watch, so a second failure raises the notice again.
			 */
			rerunSetupScript: {
				params: { taskId: string };
				response: void;
			};
			/** Drop a setup-failure verdict the user has acknowledged. */
			dismissSetupFailure: {
				params: { taskId: string };
				response: void;
			};
			/** Drop the clone-path failure list the user has acknowledged. */
			dismissCloneFailures: {
				params: { taskId: string };
				response: void;
			};
			getProjectPtyUrl: {
				params: { projectId: string };
				response: string;
			};
			destroyProjectTerminal: {
				params: { projectId: string };
				response: void;
			};
			/** Spawn a fresh scratch op in the built-in Operations board, launched with the default agent. */
			openQuickShell: {
				params: {};
				response: Task;
			};
			// `opId` is a renderer-minted correlation id, additive and optional. It is
			// what makes "the handler was never entered" provable: the renderer traces
			// the id when it sends, the handler traces it when it runs, so a request
			// that died in the bridge shows up as an id with only one side (seq 1407).
			// `env` is caller-supplied extra environment for the devScript. It loses
			// to the lifecycle DEV3_* vars and the assigned ports, and dev3-owned
			// names are dropped outright (see `sanitizeDevServerEnv`). Omitting it on
			// a start clears whatever the previous run was given.
			// `server` names ONE declared dev server; absent means the default
			// (`devScript`), or the only declared server when there is no default.
			// `all` fans the action out over every declared server instead.
			runDevServer: {
				params: { taskId: string; projectId: string; opId?: string; env?: Record<string, string>; server?: string; all?: boolean };
				response: DevServerStatus;
			};
			checkDevServer: {
				params: { taskId: string; projectId: string; opId?: string; server?: string };
				response: { running: boolean };
			};
			stopDevServer: {
				params: { taskId: string; projectId: string; opId?: string; server?: string; all?: boolean };
				response: DevServerStatus;
			};
			// Omitting `env` REUSES the extra env of the run being restarted, which is
			// what keeps the UI's Restart button on the same configuration.
			restartDevServer: {
				params: { taskId: string; projectId: string; env?: Record<string, string>; server?: string; all?: boolean };
				response: DevServerStatus;
			};
			getDevServerStatus: {
				params: { taskId: string; projectId: string };
				response: DevServerStatus;
			};
			parseRunnableScripts: {
				params: { taskId: string; projectId: string };
				response: WorktreeScripts;
			};
			runScript: {
				params: {
					taskId: string;
					projectId: string;
					scriptName: string;
					placement: ScriptPlacement;
					source: ScriptSource;
					runner?: ScriptRunner;
				};
				response: { ok: true };
			};
			openFileBrowser: {
				params: { taskId: string; projectId: string };
				response: { notInstalled: true; installCommand: string; linuxHint?: boolean } | void;
			};
			getBranchStatus: {
				params: { taskId: string; projectId: string; compareRef?: string; refresh?: boolean };
				response: BranchStatus;
			};
			getUnsavedWork: {
				params: { taskId: string; projectId: string };
				response: UnsavedWork;
			};
			refreshTaskPrStatus: {
				params: { taskId: string; projectId: string };
				response: RefreshTaskPrStatusResult;
			};
			getTaskDiff: {
				params: { taskId: string; projectId: string; mode: TaskDiffMode; compareRef?: string; compareLabel?: string; count?: number };
				response: TaskDiffResponse;
			};
			/**
			 * Read-only comment payload for the task's PR (review threads + top-level
			 * conversation), fetched via gh GraphQL and cached in-memory per task.
			 * `force` bypasses the cache (manual refresh). `null` = task has no PR.
			 */
			getTaskPrComments: {
				params: { taskId: string; projectId: string; force?: boolean };
				response: TaskPRCommentsPayload | null;
			};
			rebaseTask: {
				params: { taskId: string; projectId: string; compareRef?: string };
				response: void;
			};
			rebaseTaskViaAgent: {
				params: { taskId: string; projectId: string; compareRef?: string };
				response: { delivery: AgentPromptDelivery };
			};
			commitTaskViaAgent: {
				params: { taskId: string; projectId: string };
				response: { delivery: AgentPromptDelivery };
			};
			mergeTask: {
				params: { taskId: string; projectId: string; expectRoute?: MergeRoute; compareRef?: string };
				response: void;
			};
			pushTask: {
				params: { taskId: string; projectId: string };
				response: void;
			};
			createPullRequest: {
				params: { taskId: string; projectId: string; autoMerge?: boolean };
				response: { delivery: AgentPromptDelivery };
			};
			openPullRequest: {
				params: { taskId: string; projectId: string };
				response: void;
			};
			getTerminalPreview: {
				params: { taskId: string };
				response: string | null;
			};
			/**
			 * `unreadable` is a permission error (lost Full Disk Access), not a gone
			 * worktree — the renderer must never offer destructive recovery for it.
			 */
			checkWorktreeState: {
				params: { path: string; requireGit?: boolean };
				response: WorktreeAccessState;
			};
			checkForUpdate: {
				params: void;
				response: { updateAvailable: boolean; version: string; error?: string };
			};
			downloadUpdate: {
				params: void;
				response: { ok: boolean; error?: string };
			};
			applyUpdate: {
				params: void;
				/**
				 * `restarting: false` means the update is INSTALLED but this process is not
				 * going to be replaced — a headless server with nothing out there to relaunch
				 * it. The button has to stop spinning and say so, or it reads "Restarting…"
				 * forever for an update that already succeeded.
				 */
				response: { restarting: boolean; message?: string };
			};
			getUpdateRestartContext: {
				params: void;
				response: { headless: boolean; remoteActive: boolean; tasksInProgress: number };
			};
			saveLastRoute: {
				params: { route: string };
				response: void;
			};
			getLastRoute: {
				params: void;
				response: { route: string | null };
			};
			getAppVersion: {
				params: void;
				response: { version: string; channel: string; buildChannel: string };
			};
			/** Coarse, bucketed install facts for analytics — never names, paths or titles. */
			getTelemetryProfile: {
				params: void;
				response: TelemetryProfile;
			};
			checkSystemRequirements: {
				params: void;
				response: RequirementCheckResult[];
			};
			getRosettaWarning: {
				params: void;
				response: RosettaWarningInfo;
			};
			checkGhAvailable: {
				params: void;
				response: { available: boolean; notInstalled: boolean };
			};
			setCustomBinaryPath: {
				params: { requirementId: string; path: string };
				response: { ok: boolean };
			};
			checkAgentAvailability: {
				params: void;
				response: AgentCheckResult[];
			};
			/** Installed AND holding credentials — what the first-run sandbox is gated on. */
			checkHarnessReadiness: {
				params: void;
				response: HarnessReadinessReport;
			};
			setAgentBinaryPath: {
				params: { agentId: string; path: string };
				response: void;
			};
			getChangelogs: {
				params: void;
				response: ChangelogEntry[];
			};
			previewUpdatePopover: {
				params: void;
				response: UpdatePopoverPreview;
			};
			quitApp: {
				params: { dontShowAgain?: boolean } | void;
				response: void;
			};
			requestQuit: {
				params: void;
				response: void;
			};
			consumePendingQuitDialog: {
				params: void;
				response: boolean;
			};
			/**
			 * Read-and-clear a deep link (`dev3://…`) that arrived while the app sat
			 * window-less in the dock. The reopened renderer pulls it on mount and
			 * navigates — same pull-on-mount pattern as consumePendingQuitDialog.
			 */
			consumePendingDeepLinkNav: {
				params: void;
				response: DeepLinkNav | null;
			};
			/**
			 * Resolve a `dev3://…` URL the renderer found itself (a link clicked in
			 * terminal output) into the same navigation an inbound OS deep link
			 * produces. Null when the URL is malformed or its target is gone.
			 */
			resolveDeepLinkNav: {
				params: { url: string };
				response: DeepLinkNav | null;
			};
			openNewWindow: {
				params: void;
				response: void;
			};
			hideApp: {
				params: void;
				response: void;
			};
			getTaskPorts: {
				params: { taskId: string };
				response: PortInfo[];
			};
			getPortAllocations: {
				params: { taskId: string };
				response: number[];
			};
			listTmuxSessions: {
				params: void;
				response: TmuxSessionInfo[];
			};
			/**
			 * Ask the resource monitor for its fast tick while a surface shows CPU/RSS
			 * live (the tmux sessions popover). Lapses on its own, so a watcher that
			 * disappears — a closed browser tab in remote mode — cannot pin it on.
			 */
			setResourceMonitorBoost: {
				params: { active: boolean };
				response: void;
			};
			/** PTY read-vs-sent counters for the Debug → Terminal Performance overlay. */
			terminalPtyStats: {
				params: void;
				response: { sessions: Record<string, PtyThroughputStats> };
			};
			killTmuxSession: {
				params: { sessionName: string };
				response: void;
			};
			createLabel: {
				params: { projectId: string; name: string; color?: string };
				response: Label;
			};
			updateLabel: {
				params: { projectId: string; labelId: string; name?: string; color?: string };
				response: Label;
			};
			deleteLabel: {
				params: { projectId: string; labelId: string };
				response: void;
			};
			setTaskLabels: {
				params: { taskId: string; projectId: string; labelIds: string[] };
				response: Task;
			};
			markTaskSharedItemsRead: {
				params: { taskId: string; projectId: string; kind: "images" | "artifacts"; itemIds: string[] };
				response: Task;
			};
			toggleTaskWatch: {
				params: { taskId: string; projectId: string; watched: boolean };
				response: Task;
			};
			setTaskManualCompletion: {
				params: { taskId: string; projectId: string; manualCompletion: boolean };
				response: Task;
			};
			/**
			 * Own or disown the code a task is about ({@link Task.foreignCode}). Clearing
			 * it lets that branch's `.dev3` config and agent trust apply again — the
			 * user's call, taken with a warning, and it takes effect on the next launch.
			 */
			setTaskForeignCode: {
				params: { taskId: string; projectId: string; foreignCode: boolean };
				response: Task;
			};
			/** Persist a deferred launch on a todo task ("Start in…"). */
			scheduleTaskLaunch: {
				params: {
					taskId: string;
					projectId: string;
					/** ISO timestamp; must be in the future. */
					at: string;
					targetStatus: TaskStatus;
					variants: LaunchVariant[];
				};
				response: Task;
			};
			/** Clear a pending deferred launch without firing it. */
			cancelScheduledLaunch: {
				params: { taskId: string; projectId: string };
				response: Task;
			};
			/** Fire a pending deferred launch immediately (badge → "Start now"). */
			startScheduledLaunchNow: {
				params: { taskId: string; projectId: string };
				response: Task[];
			};
			/** Queue a scheduled message ("Send later") on a task with a live agent. */
			scheduleMessage: {
				params: {
					taskId: string;
					projectId: string;
					/** ISO timestamp; must be in the future. */
					at: string;
					text: string;
					target: ScheduledMessageTarget;
				};
				response: Task;
			};
			/** Remove one pending scheduled message without delivering it. */
			cancelScheduledMessage: {
				params: { taskId: string; projectId: string; messageId: string };
				response: Task;
			};
			/** Deliver a pending scheduled message immediately and remove it. */
			sendScheduledMessageNow: {
				params: { taskId: string; projectId: string; messageId: string };
				response: Task;
			};
			/**
			 * Type `text` + Enter into the task's live agent pane right now, without
			 * queueing (the diff viewer's per-thread "send to agent"). Throws when the
			 * task has no live agent session. Payloads over
			 * {@link AGENT_MESSAGE_SPILL_THRESHOLD_BYTES} are written to a file and the
			 * agent gets that path — `spilledPath` then names the file for the toast.
			 */
			sendAgentMessageNow: {
				params: { taskId: string; projectId: string; text: string };
				response: { spilledPath: string | null };
			};
			/**
			 * An artifact message: text a human submitted from inside an artifact,
			 * typed into that task's live agent pane wrapped in the
			 * `<dev3-artifact-message>` envelope. The viewer knows only the task, so
			 * the host finds its project itself. Throws when the task has no live
			 * agent session or its status is terminal.
			 */
			sendArtifactMessageToAgent: {
				params: { taskId: string; text: string; artifactTitle: string; version: number; versionCount: number };
				response: { spilledPath: string | null };
			};
			/** Review comments (`Task.review`): one RPC per mutation so an agent resolving through the CLI never races a whole-array write. */
			addReviewComment: {
				params: { taskId: string; projectId: string; comment: ReviewComment };
				response: Task;
			};
			updateReviewComment: {
				params: { taskId: string; projectId: string; commentId: string; body: string };
				response: Task;
			};
			deleteReviewComment: {
				params: { taskId: string; projectId: string; commentId: string };
				response: Task;
			};
			markReviewCommentsSent: {
				params: { taskId: string; projectId: string; commentIds: string[] };
				response: Task;
			};
			resolveReviewComment: {
				params: { taskId: string; projectId: string; commentId: string; by: ReviewReplyAuthor; reply?: string };
				response: Task;
			};
			reopenReviewComment: {
				params: { taskId: string; projectId: string; commentId: string };
				response: Task;
			};
			replyReviewComment: {
				params: { taskId: string; projectId: string; commentId: string; body: string; author: ReviewReplyAuthor };
				response: Task;
			};
			/** Drop every review comment of the task — the confirmed "Reset review". */
			clearTaskReview: {
				params: { taskId: string; projectId: string };
				response: Task;
			};
			/** One-shot import of a review a browser still holds in localStorage from before comments lived on the task. */
			importReviewComments: {
				params: { taskId: string; projectId: string; comments: ReviewComment[] };
				response: Task;
			};
			addTaskNote: {
				params: { taskId: string; projectId: string; content: string; source?: NoteSource };
				response: Task;
			};
			updateTaskNote: {
				params: { taskId: string; projectId: string; noteId: string; content: string };
				response: Task;
			};
			deleteTaskNote: {
				params: { taskId: string; projectId: string; noteId: string };
				response: Task;
			};
			/** Read the project's append-only message log, newest first. */
			readAgentMessageLog: {
				params: { projectId: string; limit?: number };
				response: AgentMessageLogPage;
			};
			/**
			 * Read the global `dev3 notify` archive, newest first.
			 *
			 * Deliberately not per project: a notification can be sent with no task and
			 * therefore no project, so splitting the stream by project would make
			 * "every notification, in order" unanswerable. `projectIds` narrows it, and
			 * a row with no project is always kept.
			 */
			readNotificationLog: {
				params: { limit?: number; projectIds?: string[] };
				response: NotificationLogPage;
			};
			taskPaneState: {
				params: { taskId: string };
				response: TaskPaneState;
			};
			/**
			 * Read-only terminal snapshot for ONE task, the same observation `dev3 peek`
			 * makes. `projectId` scopes the lookup so a cross-project surface can never
			 * resolve a seq-alike from the wrong board.
			 */
			peekTaskTerminal: {
				params: { taskId: string; projectId: string; pane?: string; lines?: number };
				response: TaskPeekSnapshot;
			};
			taskPaneAction: {
				params: { taskId: string; action: TaskPaneAction };
				response: TaskPaneState;
			};
			tmuxNewWindow: {
				params: { taskId: string };
				response: void;
			};
			tmuxCloseWindow: {
				params: { taskId: string; windowId?: string; force?: boolean };
				response: TmuxCloseWindowResult;
			};
			tmuxLayout: {
				params: { taskId: string };
				response: TmuxLayout;
			};
			tmuxWindowNavigate: {
				params: { taskId: string; step?: "next" | "prev"; windowId?: string };
				response: { windows: TmuxWindowEntry[] };
			};
			tmuxAltClickMoveCursor: {
				params: { taskId: string; col: number; row: number };
				response: { moved: boolean };
			};
			exitCopyModeAllPanes: {
				params: { taskId: string; typedKey?: boolean };
				response: { panesExited: number; panesKept: number };
			};
			tmuxPanesInMode: {
				params: { taskId: string };
				response: { inMode: boolean };
			};
			tmuxSearchUpdate: {
				params: { taskId: string; query: string; paneId?: string };
				response: { paneId: string | null; matches: number };
			};
			tmuxSearchStep: {
				params: { taskId: string; paneId: string; direction: "older" | "newer" };
				response: { matches: number };
			};
			tmuxSearchCancel: {
				params: { taskId: string; paneId: string };
				response: void;
			};
			copyTerminalSelection: {
				params: { taskId: string; text: string; mouseTracking: boolean };
				response: { ok: boolean; tool: string | null };
			};
			spawnAgentInTask: {
				params: {
					prompt?: string;
					taskId: string;
					projectId: string;
					agentId: string | null;
					configId: string | null;
					accountId?: string | null;
					handoff?: boolean;
				};
				response: SpawnAgentResult;
			};
			/** What a handoff from this task would retell, or null when nothing has. */
			previewTaskHandoff: {
				params: { taskId: string; projectId: string };
				response: HandoffPreview | null;
			};
			spawnBugHuntersInTask: {
				params: { taskId: string; projectId: string; agentId: string | null; configId: string | null; count: number; accountId?: string | null };
				response: { spawned: number };
			};
			pasteClipboardImage: {
				params: { projectId: string };
				response: { path: string } | null;
			};
			readImageBase64: {
				params: { path: string };
				response: { dataUrl: string } | null;
			};
			/** A streamable URL for a stored `dev3 show-video` clip: `url` for the desktop webview, `path` for the remote browser's own origin. */
			getSharedVideoUrl: {
				params: { path: string };
				response: { url: string; path: string } | null;
			};
			readArtifactContent: {
				params: { artifact: SharedArtifact };
				response: {
					html: string;
					assets: Array<{ name: string; mime: string; dataUrl: string }>;
					/** What the download button saves: one standalone HTML, or the ZIP when attachments need it. */
					downloadKind: "html" | "zip";
				};
			};
			readArtifactDownload: {
				params: { artifact: SharedArtifact };
				response: { fileName: string; mime: "application/zip" | "text/html"; base64: string };
			};
			openArtifactInBrowser: {
				params: { artifact: SharedArtifact };
				response: void;
			};
			/** Remote mode: a sandboxed tab link over the artifact's stored folder (served by the remote server). */
			createArtifactLink: {
				params: { artifact: SharedArtifact };
				response: { viewUrl: string };
			};
			openImageFile: {
				params: { path: string };
				response: void;
			};
			openFolder: {
				params: { path: string };
				response: void;
			};
			openInApp: {
				params: { appName: string; path: string };
				response: void;
			};
			/**
			 * Resolve path candidates detected in terminal output against the
			 * task's worktree (or the project directory for the project
			 * terminal). Only candidates that exist on disk resolve; the rest
			 * map to null so the renderer never linkifies dead paths.
			 */
			resolveTerminalPaths: {
				params: { taskId?: string; projectId?: string; paths: string[] };
				response: { resolved: Record<string, ResolvedTerminalPath | null> };
			};
			/** Open a terminal-linked path in the OS default app or reveal it in the file manager. */
			openTerminalPath: {
				params: { path: string; mode: "system" | "reveal" };
				response: void;
			};
			/** Read file content for the in-app terminal path preview modal. */
			readFilePreview: {
				params: { path: string };
				response: FilePreviewResult;
			};
			/** Mint a capability URL (served by the remote server) that opens a previewed file in a browser tab, or downloads it. */
			createFileLink: {
				params: { path: string; download?: boolean };
				response: { url: string };
			};
			/** Whether the server runs under WSL and can open files on that Windows desktop. */
			getWindowsHostOpen: {
				params: void;
				response: { available: boolean };
			};
			/** Open a previewed file with its Windows default app (WSL hosts only). */
			openFileOnWindowsHost: {
				params: { path: string };
				response: void;
			};
			/**
			 * Open a specific macOS System Settings pane. On non-darwin platforms
			 * this is a no-op and returns `{ ok: false }`. Used by the stuck-
			 * preparation modal to deep-link to Full Disk Access.
			 */
			openSystemSettings: {
				params: { pane: "fullDiskAccess" };
				response: { ok: boolean };
			};
			/**
			 * Resolved threshold (ms) for the stuck-preparation popover.
			 * Defaults to {@link STUCK_PREPARATION_FETCH_THRESHOLD_MS} and can be
			 * overridden by setting `DEV3_STUCK_PREP_THRESHOLD_SEC` when launching
			 * the app. Read once by the renderer on startup.
			 */
			getStuckPreparationThresholdMs: {
				params: void;
				response: { ms: number };
			};
			getAvailableApps: {
				params: void;
				response: ExternalApp[];
			};
			logRendererError: {
				params: { description: string; source: "error" | "unhandledrejection" };
				response: void;
			};
			/**
			 * Scoped renderer→backend diagnostic sink. The renderer's console does not
			 * reach ~/.dev3.0/logs, so a renderer-side symptom is otherwise invisible in
			 * the only record that survives a restart. `tag` namespaces each caller
			 * (e.g. "terminal-copy", "dev-server", "rpc-watchdog"). Deliberately NOT a
			 * general console bridge: every call site is a named investigation, and each
			 * one is expected to be removed when its investigation closes.
			 */
			logRendererDiagnostic: {
				params: {
					level: RendererLogLevel;
					tag: string;
					message: string;
					extra?: Record<string, string | number | boolean | null>;
				};
				response: void;
			};
			interfaceOnboarding: {
				params: InterfaceOnboardingRequest;
				response: InterfaceOnboardingResponse;
			};
			/**
			 * Liveness beat from a renderer, every ~2s. A wedged renderer cannot report
			 * on itself — every timer and error handler in it is dead too — so the
			 * backend judges the silence instead. See bun/renderer-watchdog.ts.
			 */
			rendererHeartbeat: {
				params: {
					clientId: string;
					sinceLastBeatMs: number;
					visible: boolean;
					/** The gap spans a hidden stretch, where throttling explains it. */
					hiddenSinceLastBeat: boolean;
					terminals: number;
					frameErrorPanes: number;
					/** A desktop window; a remote tab's silence is also what a dead link looks like. */
					desktop?: boolean;
					/** An artifact viewer is mounted. Coarse presence — never the document or its task. */
					artifactOpen?: boolean;
					/** Age of the last artifact open/close in this page load; null = none. */
					artifactIdleMs?: number | null;
					viewport?: { width: number; height: number; dpr: number };
					focused?: boolean;
					animationFrameAgeMs?: number | null;
				};
				response: void;
			};
			/**
			 * The window is going away on purpose (closed, reloaded, navigated). Without
			 * it the backend reads an ordinary close as the freeze it watches for.
			 */
			rendererHeartbeatStop: {
				params: { clientId: string };
				response: void;
			};
			/**
			 * One-shot: was the artifact popup turned on for the user because the
			 * previous session stopped responding with an artifact open? Reading it
			 * clears it, so the notice is shown once and never again.
			 */
			consumeArtifactFreezeNotice: {
				params: Record<string, never>;
				response: { freezeAt: number } | null;
			};
			listBranches: {
				params: { projectId: string };
				response: Array<{ name: string; isRemote: boolean }>;
			};
			fetchBranches: {
				params: { projectId: string; forkRef?: string };
				response: Array<{ name: string; isRemote: boolean }>;
			};
			resolvePrUrl: {
				params: { projectId: string; url: string };
				response: {
					ok: boolean;
					branch: string | null;
					number: number | null;
					title: string | null;
					isFork: boolean;
					error: string | null;
					/** Why it failed, for a message the user can act on. Absent on success. */
					reason?: PrResolveFailureReason;
					/** `owner/repo` the link points at, when it is a URL. */
					prRepo?: string | null;
					/** `owner/repo` of this project's GitHub remote, when it has one. */
					projectRepo?: string | null;
				};
			};
			getProjectCurrentBranch: {
				params: { projectId: string };
				response: { branch: string | null; isBaseBranch: boolean; isDirty: boolean; behindOrigin: number };
			};
			pullProjectMain: {
				params: { projectId: string };
				response: { ok: boolean; branch: string | null; output: string; error: string };
			};
			getTipState: {
				params: void;
				response: TipState;
			};
			updateTipState: {
				params: Partial<TipState>;
				response: TipState;
			};
			resetTipState: {
				params: void;
				response: TipState;
			};
			getProjectPRs: {
				params: { projectId: string };
				response: PRInfo[];
			};
			setTmuxTheme: {
				params: { theme: "dark" | "light"; preference?: "dark" | "light" | "system" };
				response: void;
			};
			/**
			 * PostHog feature-flag values, pushed by the Electrobun renderer every
			 * FEATURE_FLAG_REFRESH_MS. The bun process never queries PostHog itself
			 * and holds the last pushed value — see src/bun/feature-flags.ts.
			 */
			setFeatureFlags: {
				params: { flags: Record<string, boolean> };
				response: void;
			};
			/** Every declared flag with the value bun currently gates code on. */
			getFeatureFlags: {
				params: void;
				response: Record<string, boolean>;
			};
			/**
			 * The install-wide PostHog distinct id. `seed` is the calling renderer's
			 * own posthog-js id. Adopted when bun has none stored yet, or when the
			 * caller is `authoritative` — the desktop renderer, whose posthog-js
			 * identity outlives every attached browser and is the one flags are
			 * really evaluated against.
			 */
			resolveAnalyticsDistinctId: {
				params: { seed?: string; authoritative?: boolean };
				response: { distinctId: string };
			};
			/**
			 * Pushed by the renderer whenever the current route changes; the bun
			 * side uses it to rebuild the native menu so context-aware items
			 * (task / project / terminal) render disabled when irrelevant.
			 */
			updateMenuContext: {
				params: { hasTask: boolean; hasProject: boolean; hasTerminal: boolean };
				response: void;
			};
			checkCaffeinateAvailable: {
				params: void;
				response: { available: boolean };
			};
			/**
			 * Does the canary update feed carry a build for THIS machine? Derived from the
			 * publisher's own platform list, never from a runtime probe: a missing key in the
			 * release bucket answers 403, so a client could not tell "no build here" from "no
			 * permission". Asked of the host because browser-side platform sniffing would
			 * answer for the wrong machine.
			 */
			checkCanaryChannelAvailable: {
				params: void;
				response: { available: boolean };
			};
			/**
			 * Can THIS host's PRs carry a working `dev3://` back-link? True on macOS only —
			 * Windows and Linux register no handler for the scheme, so the link would be
			 * dead for whoever clicks it. Asked of the host because browser-side platform
			 * sniffing would answer for the machine holding the browser, not the one
			 * opening the PR.
			 */
			checkPrOriginTaskLinkSupported: {
				params: void;
				response: { supported: boolean };
			};
			/**
			 * Whether this machine can record freeze diagnostics at all (macOS only)
			 * and whether the collector is running right now. Asked of the host because
			 * a remote browser answers for its own machine, not the one that freezes.
			 */
			getFreezeDiagnosticsStatus: {
				params: void;
				response: { supported: boolean; running: boolean; directory: string };
			};
			getPreventSleepState: {
				params: void;
				response: { enabled: boolean; available: boolean; forcedByRemote: boolean };
			};
			setPreventSleep: {
				params: { enabled: boolean };
				response: { enabled: boolean };
			};
			uploadFileBase64: {
				params: { projectId: string; base64: string; filename?: string; mimeType?: string };
				response: { path: string } | null;
			};
			uploadImageBase64: {
				params: { projectId: string; base64: string; filename?: string; mimeType?: string };
				response: { path: string } | null;
			};
			getRemoteAccessQR: {
				params: { tunnel?: boolean; host?: string };
				response: { qrDataUrl: string; accessUrl: string; tunnelState: string; tunnelBinaryInstalled: boolean; tunnelProvider: "cloudflare" | "custom" | "misconfigured"; tunnelFailureReason: string | null; interfaces: RemoteNetInterface[]; selectedHost: string; staticCodeActive: boolean; signInLink: string | null; serverStatus: RemoteAccessStatus };
			};
			getRemoteAccessStatus: {
				params: void;
				response: RemoteAccessStatus;
			};
			retryRemoteAccess: {
				params: void;
				response: RemoteAccessStatus;
			};
			startTunnel: {
				params: void;
				response: { url: string | null; state: string };
			};
			stopTunnel: {
				params: void;
				response: void;
			};
			exposePort: {
				params: { taskId: string; port: number };
				response: ExposedPort;
			};
			exposePortsShared: {
				params: { taskId: string; ports: number[] };
				response: ExposedPort;
			};
			unexposePort: {
				params: { taskId: string; port: number };
				response: void;
			};
			unexposeShared: {
				params: { taskId: string };
				response: void;
			};
			listExposedPorts: {
				params: { taskId?: string };
				response: ExposedPort[];
			};
			getSshForwardCommand: {
				params: { ports: number[] };
				response: { command: string; hostGuess: string | null };
			};
			/**
			 * Renderer reports its window focus state so the backend can tell whether
			 * the app is in the foreground. Used to suppress notification click-to-open
			 * arming while the user is already looking at the app.
			 */
			setWindowForeground: {
				params: { focused: boolean };
				response: void;
			};
			/**
			 * Renderer reports the route context (task / project name, or the
			 * streamer-mode placeholder) so the native window title names what the
			 * window shows — the only way to tell several windows apart. Handled per
			 * window in `window-manager`; a no-op for remote browser clients, which
			 * already own their own tab title.
			 */
			setWindowTitleContext: {
				params: { context: string | null };
				response: void;
			};
			/**
			 * Renderer tells the backend when terminal immersive fullscreen owns the
			 * screen so agent notifications can queue until the user exits.
			 */
			setTerminalFocus: {
				params: { active: boolean };
				response: void;
			};
			/**
			 * Renderer reports which project board / task it is currently viewing.
			 * Background git pollers use this to poll the active board at full
			 * cadence while throttling every off-screen project heavily.
			 */
			setActiveContext: {
				params: { projectId: string | null; taskId: string | null };
				response: void;
			};
			/**
			 * Renderer reports its streamer-mode state together with the projects
			 * marked `sensitive`, so the backend can drop OS-level notifications the
			 * renderer cannot intercept. Streamer mode is per-client display state
			 * (localStorage), so the renderer is its only authority; with no client
			 * connected there is no screen to leak on and nothing is silenced.
			 */
			setStreamerPrivacy: {
				params: { streamerMode: boolean; sensitiveProjectIds: string[] };
				response: void;
			};
			/**
			 * Renderer answers an `agentCompletionRequested` dialog. Approval makes
			 * the blocked CLI request execute the move to `completed`; decline just
			 * releases it with a refusal.
			 */
			respondToAgentCompletionRequest: {
				params: { requestId: string; approved: boolean };
				response: void;
			};
			/**
			 * Completion dialogs that are still waiting for an answer. A renderer
			 * asks on connect, because `agentCompletionRequested` is a one-shot push:
			 * a window that reloads before answering would otherwise never see the
			 * dialog again, and the blocked agent's retry joins the same request
			 * rather than triggering a new push.
			 */
			listPendingCompletionRequests: {
				params: Record<string, never>;
				response: AgentCompletionRequest[];
			};
			/**
			 * Renderer answers an `agentCancellationRequested` dialog. Approval makes
			 * the blocked CLI request execute the move to `cancelled` — which throws
			 * the worktree and everything uncommitted in it away; decline just
			 * releases it with a refusal.
			 */
			respondToAgentCancellationRequest: {
				params: { requestId: string; approved: boolean };
				response: void;
			};
			/**
			 * Cancellation dialogs still waiting for an answer, replayed for the same
			 * reason as `listPendingCompletionRequests`: the push is one-shot and an
			 * agent's retry joins the pending request instead of re-pushing it.
			 */
			listPendingCancellationRequests: {
				params: Record<string, never>;
				response: AgentCancellationRequest[];
			};
			/**
			 * Renderer answers an `agentResetRequested` dialog. Approval resets the
			 * task to To Do (agent stopped, worktree and dev3 branch deleted).
			 */
			respondToAgentResetRequest: {
				params: { requestId: string; approved: boolean };
				response: void;
			};
			listPendingResetRequests: {
				params: Record<string, never>;
				response: AgentCancellationRequest[];
			};
			/**
			 * Renderer answers an `agentLaunchRequested` dialog. Approval hands back
			 * the variants + priority the user composed, and the blocked CLI request
			 * launches the task with them; decline releases it with a refusal.
			 */
			getPendingAgentLaunchRequests: { params: {}; response: AgentLaunchRequest[] };
			respondToAgentLaunchRequest: {
				params: {
					requestId: string;
					approved: boolean;
					launch?: AgentLaunchChoice;
				};
				response: void;
			};
			/**
			 * Mirror the dialog's current variants/priority pick into the pending
			 * request, so an auto-approval that fires while nobody is watching still
			 * launches with what the user last selected rather than the defaults.
			 */
			updateAgentLaunchChoice: {
				params: {
					requestId: string;
					launch: AgentLaunchChoice;
				};
				response: void;
			};
			/**
			 * Report that this dialog has reached the screen, restarting its
			 * countdown from now. Dialogs queue rather than stack, so a request that
			 * waited behind another must still get the whole delay in front of a
			 * human. Answers with the deadline to draw, which is the same one the
			 * bun-side timer will fire on.
			 */
			markAgentRequestShown: {
				params: { requestId: string };
				response: { autoApproveAt: number | null };
			};
			/**
			 * The user took the dialog over — stop the countdown for good. Called on
			 * the first real interaction (pointer, key, or an edited pick), never on
			 * mount or on a programmatic update, so an unattended dialog still
			 * launches on its own and an attended one waits for an explicit answer.
			 */
			holdAgentLaunchAutoApprove: {
				params: { requestId: string };
				response: void;
			};
			/**
			 * Cheap liveness probe for the desktop RPC bridge watchdog. The renderer
			 * pings this on wake/focus with a short timeout; a missed ping means the
			 * Electrobun localhost socket has jammed and the bridge needs recovery.
			 */
			ping: {
				params: void;
				response: { ok: true; t: number };
			};
			listAutomations: {
				params: { projectId: string };
				response: Automation[];
			};
			createAutomation: {
				params: { projectId: string } & AutomationDraft;
				response: Automation;
			};
			updateAutomation: {
				params: { projectId: string; automationId: string } & Partial<AutomationDraft>;
				response: Automation;
			};
			deleteAutomation: {
				params: { projectId: string; automationId: string };
				response: void;
			};
			/** Fire an automation immediately (does not consume/advance the schedule). */
			runAutomationNow: {
				params: { projectId: string; automationId: string };
				response: { taskId: string };
			};
		};
		messages: {
			taskUpdated: { projectId: string; task: Task };
			projectUpdated: { project: Project };
			/** A project registered outside the renderer (`dev3 projects add|clone`). */
			projectAdded: { project: Project };
			spacesUpdated: { file: SpacesFile };
			taskSound: { status: TaskSoundStatus; taskId: string };
			ptyDied: { taskId: string };
			/** A saved session was resumed — possibly from the CLI, so a recovery screen still on display must re-read. */
			taskTerminalResumed: { taskId: string; projectId: string };
			projectPtyDied: { projectId: string };
			/** An in-app account sign-in changed phase; `state: null` = it was closed. */
			accountLoginChanged: { kind: AgentAccountKind; state: AccountLoginState | null };
			terminalBell: { taskId: string };
			gitOpCompleted: { taskId: string; projectId: string; operation: string; ok: boolean };
			/**
			 * A downloaded update waits for a restart. `reminder` marks a repeat
			 * announcement of an already-announced version (the user postponed it),
			 * telling the renderer to re-show the prompt even though the version
			 * itself did not change.
			 */
			updateAvailable: { version: string; changelog?: UpdateChangelog; reminder?: boolean };
			branchMerged: { taskId: string; projectId: string; taskTitle: string; branchName: string; fingerprint: string | null; subject: TaskDialogSubject; shouldPrompt?: boolean; shouldNotify?: boolean };
			manualCompletionChanged: { taskId: string; projectId: string; manualCompletion: boolean; taskSeq?: number; taskTitle?: string; projectName?: string };
			/**
			 * A branch-merged completion prompt was resolved by declining it
			 * (`dismissMergeCompletionPrompt`). Lets other connected clients — a
			 * second window, or a remote browser served by the same app — close
			 * their still-open "Branch Merged" dialog. The accept path needs no
			 * dedicated event: it is covered by the `taskUpdated` push that moves
			 * the task to `completed` and drops its worktree.
			 */
			mergePromptResolved: { taskId: string; projectId: string; fingerprint: string | null };
			/**
			 * Emitted when an agent runs `dev3 task move --status completed`. The CLI
			 * blocks on the user's decision; the renderer shows an AI-styled confirm
			 * dialog and answers via `respondToAgentCompletionRequest`. `subject`
			 * carries the read-only task context shown in the dialog (overview lives
			 * on `subject.overview`).
			 */
			agentCompletionRequested: AgentCompletionRequest;
			/**
			 * Emitted when an agent runs `dev3 task move --status cancelled` — an
			 * agent cleaning up a task that should never have existed. The CLI blocks
			 * on the user's decision; the renderer shows the danger-styled cancel
			 * dialog (its own channel, so it can never be confused with the
			 * completion one) and answers via `respondToAgentCancellationRequest`.
			 */
			agentCancellationRequested: AgentCancellationRequest;
			/**
			 * Emitted when `dev3 task move --status todo` targets a task that needs a
			 * reset. Same danger dialog shape as cancellation, its own channel.
			 */
			agentResetRequested: AgentCancellationRequest;
			/**
			 * Emitted when an agent asks to set ANOTHER task running — either
			 * `dev3 task move --task <other> --status <active>` or
			 * `dev3 task create --scratch --run`. The CLI blocks on the user's
			 * decision; the renderer shows the launch dialog (task context + agent
			 * picker) and answers via `respondToAgentLaunchRequest`. `requesterSeq`
			 * names the asking task so the user can see who wants this.
			 */
			agentLaunchRequested: AgentLaunchRequest;
			/**
			 * An agent-initiated request (`complete` or `launch`) got its answer.
			 * Both dialogs are broadcast to every connected client, so the first
			 * answer has to close the copies open on the other windows / remote
			 * browsers — they can no longer decide anything.
			 */
			agentRequestResolved: { requestId: string; kind: "complete" | "cancel" | "reset" | "launch"; taskId: string; projectId: string };
			/**
			 * Somebody took a launch dialog over, so its auto-approval is off. The
			 * dialog is broadcast to every client, and a copy on another window would
			 * otherwise keep counting down to a launch that can no longer happen.
			 */
			agentLaunchAutoApproveHeld: { requestId: string };
			portsUpdated: { taskId: string; ports: PortInfo[] };
			/**
			 * Dev-server state for one task, pushed only when it changes. Feeds the
			 * dev control on the Kanban card, which is why it is a broadcast and not
			 * the per-task `getDevServerStatus` read the inspector uses.
			 */
			devServerUpdated: DevServerSummary;
			exposedPortsChanged: { taskId: string; ports: ExposedPort[] };
			/** Remote access came up, went down, or a retry changed the verdict. */
			remoteAccessStatusChanged: RemoteAccessStatus;
			resourceUsageUpdated: { taskId: string; usage: ResourceUsage };
			/**
			 * System-wide memory, sampled in the same resource-monitor tick as the
			 * per-task figures (so the dev3 subtotal and the system total are never
			 * from different moments). Throttled: only emitted when headroom moves
			 * meaningfully, the pressure/swapping signal changes, or the membership
			 * of either top list changes.
			 */
			systemMemoryUpdated: SystemMemorySnapshot;
			/**
			 * Fresh agent rate-limit data (Claude dump / Codex rollouts + monthly credits).
			 * Pushed by the rate-limit monitor whenever the parsed windows change.
			 */
			agentRateLimitsUpdated: AgentRateLimitsReport;
			updateDownloadProgress: { status: string; progress?: number };
			/**
			 * Live `git clone` output for the Add Project modal — the last few
			 * stderr lines, terminal-style (`\r` rewrites collapsed). Correlated
			 * by the `progressId` the renderer passed to `cloneAndAddProject`.
			 */
			cloneProgress: { progressId: string; lines: string[] };
			/**
			 * Emitted when a column-agent launch fails. `movedTo` is the column the task
			 * was parked in as a fallback (built-in AI Review only); absent means the task
			 * stayed put, which is what a custom column does.
			 */
			columnAgentFailed: {
				taskId: string;
				projectId: string;
				column: ColumnAgentIdentity;
				error: string;
				movedTo?: TaskStatus;
				reason?: ColumnAgentFailureReason;
			};
			/**
			 * Emitted when background worktree/PTY preparation for a task fails (e.g.
			 * empty repo, missing base branch). The task is reverted to todo so it is
			 * recoverable; the renderer surfaces this as a toast instead of leaving a
			 * misleading "[session ended]" terminal.
			 */
			taskPreparationFailed: { taskId: string; projectId: string; taskTitle: string; error: string };
			/** Emitted after a global preference is saved. */
			globalSettingsUpdated: GlobalSettings;
			/** Emitted after the agent presets are saved, carrying the merged list.
			 *  Surfaces that hold a long-lived snapshot (boards, launch pickers) would
			 *  otherwise keep offering presets the user just renamed or deleted. */
			agentsUpdated: CodingAgent[];
			/**
			 * Navigate from an inbound `dev3://…` deep link while a window is already
			 * open: jump to a task, open a project board, or open the Create Task
			 * modal prefilled with `text`. Cold-start (no window) uses the
			 * consumePendingDeepLinkNav pull instead — see decisions/144.
			 */
			openDeepLink: DeepLinkNav;
			/**
			 * CLI-initiated in-app toast (`dev3 notify`). When `taskId`/`projectId`
			 * are present the toast is clickable and navigates to that task.
			 */
			cliToast: {
				taskId: string | null;
				projectId: string | null;
				message: string;
				level: "info" | "success" | "error";
				/** Optional in-app toast lifetime in milliseconds; omitted uses the default. */
				durationMs?: number;
				/** Source-task context for the toast header (present when a task was resolved). */
				taskSeq?: number;
				taskTitle?: string;
				projectName?: string;
			};
			/**
			 * One agent typed a message into ANOTHER task's agent (`dev3 message` run
			 * inside a worktree). Its own channel, not `cliToast`, because the event has
			 * two identities: the toast states sender → receiver and clicks through to
			 * the receiver, whose terminal now holds the text. Sole emitter:
			 * `pushAgentMessage` in `src/bun/rpc-handlers/shared.ts`.
			 */
			/** A durable append completed; refresh the recipient project log, including failed attempts. */
			agentMessageLogChanged: { projectId: string };
			/**
			 * A notification row was appended to the global archive by THIS instance.
			 * No payload: the archive is one global stream, so there is nothing to
			 * scope the refresh to. Another instance's appends are not announced —
			 * that needs a filesystem watcher, which a read API does not.
			 */
			notificationLogChanged: Record<string, never>;
			agentMessage: {
				/** Receiving task — the click target, and the inbox that got the text. */
				taskId: string;
				projectId: string;
				toSeq: number;
				toTitle: string;
				/** Sending task's `seq` — also the reply address. */
				fromSeq: number;
				fromTitle?: string;
				/** Sending task's project, so the renderer can silence either side. */
				fromProjectId?: string;
				/** Sending task's id — the toast's way to the sender. Absent on a record queued before it existed. */
				fromTaskId?: string;
				/** Variant indices, so `#21-2` names the exact attempt on either side. */
				fromVariantIndex?: number;
				toVariantIndex?: number;
				/** One-line, length-clamped preview of what was sent. */
				preview: string;
			};
			/**
			 * CLI-initiated attention signal (`dev3 attention`). Lights the red bell
			 * badge on the task card with a hoverable `reason`, same surface the
			 * terminal bell uses. `clear: true` (`dev3 attention --clear`) lowers the
			 * badge and drops every accumulated reason instead of adding one.
			 */
			cliAttention: { taskId: string; reason: string; clear?: boolean };
			/**
			 * CLI-shared images (`dev3 show-image`). Carries the task's shared images
			 * so the renderer can raise the attention badge and open the lightbox
			 * (auto-open only when already viewing the task). Sole emitter:
			 * `pushCliShowImage` in `src/bun/rpc-handlers/shared.ts`.
			 */
			cliShowImage: {
				taskId: string;
				projectId: string;
				images: SharedImage[];
				newCount: number;
				/** Kind of the new arrivals (`dev3 show-video` sends "video"). Absent = images. */
				newKind?: "image" | "video";
				taskSeq?: number;
				taskTitle?: string;
				projectName?: string;
			};
			/**
			 * CLI-shared HTML artifacts (`dev3 show-artifact`). Same delivery model as
			 * {@link cliShowImage} but for portable HTML bundles.
			 */
			cliShowArtifact: {
				taskId: string;
				projectId: string;
				artifacts: SharedArtifact[];
				newCount: number;
				taskSeq?: number;
				taskTitle?: string;
				projectName?: string;
			};
			/**
			 * Browser Web Notification request. Mirrors a native OS notification
			 * (`dev3 notify --desktop`, watched-task status/event banners) for clients
			 * running in remote/browser mode, where `Utils.showNotification` is a no-op.
			 * The desktop WKWebView ignores it (native already fired); browsers show a
			 * `new Notification(...)`, or fall back to an in-app toast when the
			 * Notification API is unavailable (insecure LAN context) or not granted.
			 */
			webNotification: {
				taskId: string;
				projectId: string;
				/** Notification heading, e.g. "#804 Fix bug". */
				title: string;
				/** Notification body, e.g. a message or "In Progress → Review". */
				body: string;
				/** Toast-fallback variant when the Notification API can't be used. */
				level: "info" | "success" | "error";
				/** Source-task context for the fallback toast header. */
				taskSeq?: number;
				taskTitle?: string;
				projectName?: string;
			};
			/**
			 * CI/checks + PR-review state for a task's associated PR, emitted by the
			 * background PR poller (`checkOpenPRsForPromotion`). Drives the CI and
			 * review badges on the task card. Passive status — NOT gated by Focus
			 * Mode (only the bell/notification raised alongside it is).
			 */
			taskPrStatus: {
				projectId: string;
				taskId: string;
				prNumber: number | null;
				prUrl: string | null;
				autoMergeEnabled?: boolean | null;
				ciStatus: PRCIStatus | null;
				reviewState: PRReviewState | null;
				reviewDecision?: PRReviewDecision | null;
				unresolvedCount: number | null;
				mergeState: PRMergeState | null;
				checks: PRCheckInfo[];
				prTitle: string | null;
				isDraft: boolean | null;
			};
			/** An automation changed (CRUD, a run fired, nextRunAt advanced) — refresh the Automations panel. */
			automationsUpdated: { projectId: string };
			/**
			 * Occurrences were missed while the app was offline (detected at scheduler
			 * startup). Surfaced as a toast — missed runs are never silently skipped.
			 */
			automationRunsMissed: { projectId: string; automationId: string; automationName: string; missedCount: number; caughtUp: boolean };
		};
	}>;
	webview: RPCSchema<{
		requests: Record<string, never>;
		messages: {
			openCreateTaskModal: {};
			openAddProjectModal: {};
			navigateToSettings: {};
			navigateToGaugeDemo: {};
			navigateToViewportLab: {};
			terminalSoftReset: {};
			terminalHardReset: {};
			zoomIn: {};
			zoomOut: {};
			zoomReset: {};
			osc52Clipboard: { taskId: string; text: string; len: number };
			qrTokenConsumed: {};
			showRemoteAccessQR: { qrDataUrl: string; accessUrl: string; tunnelState: string; tunnelBinaryInstalled: boolean; tunnelProvider: "cloudflare" | "custom" | "misconfigured"; tunnelFailureReason?: string | null; autoStartTunnel?: boolean; staticCodeActive?: boolean; signInLink?: string | null };
			/**
			 * Universal menu-action dispatch. The bun side fires this whenever the
			 * native menu emits an `application-menu-clicked` event whose action is
			 * routed to the renderer (most of them are). The renderer's `menuRouter`
			 * picks it up and dispatches into the relevant flow (modal, navigation,
			 * RPC call, state mutation) based on its `current` view/task/project.
			 *
			 * Bun-side side effects (open external URL, dialog, display-popup) do
			 * not go through this channel — they execute in `src/bun/index.ts`.
			 */
			menuAction: { action: string };
			/**
			 * Ask the renderer to show the quit-confirmation dialog. Fired from the
			 * bun `before-quit` gate when a quit was requested (Cmd+Q, menu Quit, or
			 * closing the last window) and the user hasn't opted out. The actual quit
			 * only happens after the renderer confirms via `quitApp`.
			 */
			showQuitDialog: {};
			/** Open the in-app About modal (replaces the native About message box). */
			showAbout: { version: string; buildChannel?: string };
			/** Open the Debug → Feature Flags inspector. */
			showFeatureFlags: {};
			/** Show or hide the Debug → Terminal Performance overlay. */
			toggleTerminalPerf: {};
			/**
			 * Result of a manual "Check for Updates" menu action, surfaced as a toast.
			 * `available` updates flow through `updateAvailable` instead (header plaque).
			 */
			updateCheckOutcome: { status: "none" | "error" | "dev"; version?: string; detail?: string };
		};
	}>;
};
