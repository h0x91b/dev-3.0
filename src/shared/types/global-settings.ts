import type { ResourceLevels } from "./system-resources";
import type { TerminalBackendIdentity } from "../terminal-backend-identity";
import type { UpdateChannel } from "../update-channel";
import type { ShellFlavor } from "../posix-shell";
import type { FavoriteAgentConfig } from "./coding-agents";

// ---- External Apps ("Open in...") ----

export interface ExternalApp {
	id: string;
	name: string;
	macAppName: string; // name used with `open -a`
}

/** Well-known macOS apps for "Open in..." menus. */
export const DEFAULT_EXTERNAL_APPS: ExternalApp[] = [
	{ id: "finder", name: "Finder", macAppName: "Finder" },
	{ id: "vscode", name: "VS Code", macAppName: "Visual Studio Code" },
	{ id: "cursor", name: "Cursor", macAppName: "Cursor" },
	{ id: "ghostty", name: "Ghostty", macAppName: "Ghostty" },
	{ id: "iterm", name: "iTerm", macAppName: "iTerm" },
	{ id: "terminal", name: "Terminal", macAppName: "Terminal" },
	{ id: "intellij", name: "IntelliJ", macAppName: "IntelliJ IDEA" },
	{ id: "intellij-ultimate", name: "IntelliJ", macAppName: "IntelliJ IDEA Ultimate" },
	{ id: "intellij-ce", name: "IntelliJ", macAppName: "IntelliJ IDEA CE" },
	{ id: "pycharm", name: "PyCharm", macAppName: "PyCharm" },
	{ id: "zed", name: "Zed", macAppName: "Zed" },
	{ id: "sublime", name: "Sublime Text", macAppName: "Sublime Text" },
];

/**
 * What the GUI needs to render (and gate) a task's terminal-backend override:
 * the effective identity, whether the record carries it explicitly, and which
 * backend — if any — still owns a live session for the task.
 */
export interface TaskTerminalBackendInfo {
	backend: TerminalBackendIdentity;
	explicit: boolean;
	liveBackend: TerminalBackendIdentity | null;
}

/** Which terminal backends THIS machine's build can actually launch. */
export interface NativeTerminalAvailability {
	available: boolean;
	/**
	 * Whether tmux is a usable choice at all on the HOST platform. False on
	 * Windows, which ships no tmux runtime — the renderer must not offer it there,
	 * and browser-side platform sniffing would answer for the wrong machine.
	 */
	tmuxSupported: boolean;
	/** Provenance of the resolved host runtime; absent when unavailable. */
	origin?: string;
	/** Actionable reasons it could not be resolved; empty when available. */
	diagnostics: string[];
}

/**
 * Which tunnel exposes the remote-access server publicly.
 *
 * `provider: "custom"` runs the user's own CLI (ngrok, or any ngrok-like
 * service) instead of the built-in Cloudflare quick tunnel. The command is a
 * shell line with a `{port}` placeholder; the public URL is scraped from the
 * command's output — by default the first `https://…` URL it prints,
 * overridable with `urlPattern` for CLIs whose output contains other URLs.
 */
export interface RemoteTunnelSettings {
	provider: "cloudflare" | "custom";
	/** Shell command template, e.g. `ngrok http {port} --log stdout`. Required for `custom`. */
	command?: string;
	/** Optional regex matching the public URL in the command's output. */
	urlPattern?: string;
}

/** The two supported agent-traffic presentations. Both are shipped, neither is legacy. */
export type AgentTrafficExperiment = "1" | "2";
/** What an install with no recorded preference renders. */
export const DEFAULT_AGENT_TRAFFIC_EXPERIMENT: AgentTrafficExperiment = "2";

export interface GlobalSettings {
	defaultAgentId: string;
	defaultConfigId: string;
	/**
	 * Secondary order inside a priority band, shared by the Kanban board and the
	 * Active Tasks sidebar. `oldest-first` floats the task whose status changed
	 * longest ago (the one most at risk of being forgotten); `newest-first` is the
	 * most-recently-used order. See sortTasks.ts.
	 */
	taskSortOrder: "oldest-first" | "newest-first";
	updateChannel: UpdateChannel;
	theme?: "dark" | "light" | "system";
	resolvedTheme?: "dark" | "light";
	/**
	 * The id PostHog buckets this install by, owned by bun so every renderer —
	 * desktop window and remote browser alike — reports the same one. Seeded once
	 * from the desktop renderer's own posthog-js id so existing installs keep
	 * their person instead of splitting into a second one.
	 */
	analyticsDistinctId?: string;
	/**
	 * Permanent, multi-use sign-in code for remote access. Typed into the
	 * browser's sign-in screen, never carried in a URL. Stored in plain text
	 * alongside the other settings — no system keychain (see the decision record
	 * `static-access-code-as-a-real-credential`). `DEV3_REMOTE_STATIC_CODE` wins
	 * over it for headless and Docker.
	 */
	staticAccessCode?: string;
	cloneBaseDirectory?: string;
	/** Last position of the Add Project dialog's auto-configure switch. Absent = off. */
	autoConfigureNewProjects?: boolean;
	customBinaryPaths?: Record<string, string>; // requirementId → custom binary path
	agentBinaryPaths?: Record<string, string>; // agentId → resolved binary path
	/**
	 * Paths the user typed into Settings -> Agents -> Custom path, kept apart
	 * from the auto-cached `agentBinaryPaths`: only the cache may be discarded
	 * when it stops naming the agent's base command. A deliberate override
	 * points wherever the user wants and is never second-guessed.
	 */
	agentCustomBinaryPaths?: Record<string, string>;
	/**
	 * Beta: reorder right-to-left text (Hebrew, Arabic) for display in terminal
	 * panes. Display-only — copied text keeps its logical order, while mouse
	 * selection and link hover on those lines stay logical too. On by default —
	 * absent means "never chose", and an explicit `false` is the user's opt-out,
	 * which must survive a restart.
	 */
	experimentalTerminalBidi?: boolean;
	/**
	 * Beta: the agent-traffic readout in the header and its 30-day log. On by
	 * default — absent means "never chose", and an explicit `false` is the user
	 * saying "off", which must survive a restart. While off the feature leaves no
	 * trace — no header control, no ⇧⌘M, no menu item, no palette command, no tip.
	 */
	experimentalAgentTraffic?: boolean;
	/**
	 * Record local macOS freeze diagnostics (host/renderer liveness journals plus
	 * bounded native stack samples under `~/.dev3.0/logs/freeze`). Off unless the
	 * key is an explicit `true`, and nothing is ever uploaded. The host applies a
	 * change straight away: turning it off stops the collector for this session
	 * too, not only for the next launch.
	 */
	freezeDiagnosticsEnabled?: boolean;
	/** Effective hidden ids, retained for older installed versions. */
	hiddenControls?: string[];
	/** Personal choices survive applying and removing the Simplified Mode preset. */
	personalHiddenControls?: string[];
	simplifiedMode?: boolean;
	/** Original installation cohort; manual transitions are tracked by the host. */
	simplifiedModeSource?: "fresh" | "existing";
	/**
	 * Which agent-traffic presentation the surface renders: `"1"` is the 3D orbit
	 * of planets, `"2"` the flat animated node graph. Absent means Experiment 2 —
	 * the default for a fresh install and for anyone upgrading, because having
	 * turned the feature on is not a choice of a presentation nobody was offered.
	 */
	agentTrafficExperiment?: AgentTrafficExperiment;
	/**
	 * Legacy keys of the removed low-battery feature. `lowBatteryEnabled: true` proves
	 * dev3 installed its files, so startup removes them and stores `false`; the rest is
	 * kept on disk so an older co-installed build keeps its own opt-out.
	 */
	lowBatteryEnabled?: boolean;
	lowBatteryDisabled?: boolean;
	lowBatteryAnnounced?: boolean;
	playSoundOnTaskComplete?: boolean;
	/**
	 * Chime when a task enters Your Review or User questions. Off unless an
	 * explicit `true`: those moves happen at the end of every agent turn.
	 */
	playSoundOnTaskNeedsYou?: boolean;
	externalApps?: ExternalApp[]; // user-configured apps for "Open in..." menus
	tipsDisabled?: boolean;
	/**
	 * Switch every telemetry channel off for this install. Default off (undefined ⇒
	 * telemetry runs). The host reads it at startup and injects the verdict into the
	 * HTML shell, because posthog-js initializes at module import — see
	 * src/bun/analytics-identity.ts and src/shared/telemetry-consent.ts.
	 *
	 * `DEV3_TELEMETRY=off` and `DO_NOT_TRACK=1` do the same thing from the
	 * environment and override this field's absence.
	 */
	telemetryDisabled?: boolean;
	/**
	 * Daily removal of finished tasks' diffs/logs older than 14 days
	 * (`src/bun/worktree-cleanup-scheduler.ts`). Default on; only an explicit
	 * false opts out.
	 */
	autoCleanupTaskHistory?: boolean;
	/**
	 * Set the first time the user opens help mode. Until then the header's `?`
	 * rests highlighted on the main screens — help mode is the product's only
	 * teaching channel, so a user who never finds the button never learns
	 * anything (bible §5.4). One-way: it is never set back to false.
	 */
	helpModeDiscovered?: boolean;
	/**
	 * Guided tours the user has finished or dismissed (ids from `mainview/tour.ts`).
	 * A tour auto-starts once and never again; skipping counts, because a wizard
	 * that returns after being waved off is worse than no wizard.
	 */
	completedTours?: string[];
	taskOpenMode?: "split" | "fullscreen"; // how active tasks open when clicked
	/**
	 * What Cmd/Ctrl+Click on a file path in terminal output does:
	 * in-app preview modal (default), OS default app, or reveal in the file
	 * manager. Browser/remote mode always previews in-app regardless.
	 */
	terminalPathOpenMode?: TerminalPathOpenMode;
	defaultDiffViewMode?: "split" | "unified" | "auto"; // default inline diff layout; "auto" picks based on screen size
	/**
	 * Where an HTML artifact opens: the right-hand docked panel beside the task
	 * terminal (default, undefined/false) or a centred popup over the task (true).
	 * The popup is the alternative for anyone whose UI freezes with the panel — it
	 * is not a fix for that freeze, whose cause is still unestablished.
	 */
	openArtifactsInPopup?: boolean;
	/**
	 * Which starter agents build human-facing reports from. Absent = the bundled
	 * dev3 template. `"off"` = free-form HTML; `"custom"` = the user's own folder
	 * ({@link artifactTemplatePath}). Reaches agents as `DEV3_ARTIFACT_TEMPLATE`.
	 */
	artifactTemplate?: "off" | "custom";
	/** The user's own starter folder for `"custom"`. Absent = `~/.dev3.0/artifact-template-custom`, seeded from the dev3 template. */
	artifactTemplatePath?: string;
	/**
	 * Let a headless `dev3 remote` box install updates on its own once browser and
	 * terminal activity are quiet. Default ON — the whole point is that nobody
	 * ever goes back to a terminal to type `brew upgrade`. Helper restarts preserve
	 * running agents; supervisor-owned restarts wait until no agent is at risk.
	 * Turn it off to hold a box on one build while investigating. Has no effect on
	 * the desktop app, which has its own updater.
	 */
	remoteSilentUpdate?: boolean;
	preventSleepWhileRunning?: boolean; // keep a sleep inhibitor running while the app is open
	skipQuitDialog?: boolean; // suppress the "tmux keeps running" quit confirmation
	/**
	 * Inherit the user's full exported login-shell environment into agent/MCP
	 * sessions (so env-based MCP servers, SDK keys, etc. set in `.zshrc`/`.bashrc`
	 * work). Default on; set to `false` to fall back to importing only the typed
	 * vars (PATH/LANG/...) for an isolated environment.
	 */
	importShellEnv?: boolean;
	/**
	 * Which POSIX shell dev3 runs in its terminals and generated wrapper
	 * scripts. Undefined ⇒ auto-detect (the user's login shell, else the first
	 * of zsh → bash → sh that is installed). Set it when the detected shell is
	 * not the one you want, or on a minimal Linux box that ships only `sh`.
	 * A chosen shell that is not installed falls back down the same order.
	 * Ignored on Windows, which runs PowerShell.
	 */
	terminalShell?: ShellFlavor;
	/**
	 * Darken every pane except the focused one in a tmux terminal, so the split
	 * that takes the keyboard is obvious. Default on; set to `false` to give all
	 * panes the same background and foreground. tmux backend only — the native
	 * backend never dimmed anything.
	 */
	dimInactivePanes?: boolean;
	/**
	 * A title bar above every tmux pane: its number (green while focused), a zoom
	 * marker, and the title a program set or `folder │ command`. Costs each pane one
	 * row, so default off. tmux backend only.
	 */
	paneTitles?: boolean;
	/**
	 * Ask "Close pane N?" before the close-pane shortcut kills a pane. Default off.
	 * The Close Pane picker never asks: picking the pane is the confirmation.
	 */
	confirmClosePane?: boolean;
	/**
	 * Prompt style for zsh shell panes: a `SHELL_PROMPT_STYLES` id, `"custom"`
	 * (zsh code in `shellPromptCustom`) or `"own"` (keep the user's `.zshrc`
	 * prompt). Undefined ⇒ the default style. Applies to newly opened panes.
	 */
	shellPrompt?: string;
	/** The user's own prompt code, used when `shellPrompt` is `"custom"`. */
	shellPromptCustom?: string;
	focusMode?: boolean; // when true, queue agent-initiated attention UI and viewer events until Focus Mode ends
	/**
	 * Track agent rate-limit windows (Claude via an injected statusLine wrapper,
	 * Codex via rollout files) and show the ambient header indicator.
	 * Default on; set to `false` to disable both the `--settings` statusLine
	 * injection and the indicator.
	 */
	agentRateLimitTracking?: boolean;
	/**
	 * Harnesses whose default for new launches is "Auto" — the usage-balanced
	 * router — instead of the registry's specific default account. The registry
	 * `activeId` stays untouched so older builds keep a valid default.
	 */
	autoAccountDefault?: { claude?: true; codex?: true };
	/**
	 * Remembered state of the Watch toggle in the launch/create-variant modal.
	 * When a task is launched, the toggle's on/off choice is persisted here and
	 * reused as the default for the next launch. Undefined → default to unwatched.
	 */
	watchByDefault?: boolean;
	/** When false, merged branches show a notice instead of a completion prompt. */
	suggestCompletingTasksAfterMerge?: boolean;
	/**
	 * Minutes the agent-launch dialog waits before approving itself, so a
	 * requesting agent is not blocked on a user who stepped away. `0` disables
	 * it and restores the answer-or-time-out behaviour. Undefined ⇒
	 * {@link DEFAULT_AGENT_LAUNCH_AUTO_APPROVE_MINUTES}. Deliberately not
	 * applied to the completion dialog: that one destroys a worktree.
	 */
	agentLaunchAutoApproveMinutes?: number;
	/** Where the CPU and disk readouts turn yellow / red. Sparse: absent keys use the defaults. */
	resourceLevels?: Partial<ResourceLevels>;
	/**
	 * When false, the Create-PR handoff stops asking the agent to append the
	 * deep link back to the originating task. Default on; the opt-out exists
	 * because a public PR would otherwise advertise that dev3 produced it.
	 */
	prOriginTaskLink?: boolean;
	/**
	 * One-time migration marker: when this is behind the app's current
	 * revision, built-in agent presets get their configuration order
	 * resynced to match the declared order in DEFAULT_AGENTS once, then
	 * this is bumped so the user's own future drag-reordering sticks again.
	 */
	agentsLayoutRevision?: number;
	/**
	 * Opt-in switch for the experimental local `pxpipe-proxy` token-saving proxy.
	 * Default off (undefined ⇒ disabled). While off, the "Fable 5 (cost trick)"
	 * preset is shown but disabled in the picker. Managed from the Global
	 * Settings "Token-saving proxy" section. See PxpipeProxyStatus.
	 */
	pxpipeProxyEnabled?: boolean;
	/**
	 * Bring-your-own-tunnel for remote access. Absent ⇒ the built-in Cloudflare
	 * quick tunnel. See RemoteTunnelSettings.
	 */
	remoteTunnel?: RemoteTunnelSettings;
	/**
	 * Pin the port the remote-access server listens on, so a tunnel ingress, a
	 * reverse proxy or a `tailscale serve` entry does not break on every launch.
	 * Absent ⇒ a random free port. `DEV3_REMOTE_PORT` still wins where it is set
	 * (the CLI's `--port`, the dev script) — but the desktop app cannot read it:
	 * every `DEV3_*` key is stripped out of the imported shell environment on
	 * purpose (SHELL_ENV_DENIED_PREFIXES), which left the GUI with no way to pin
	 * the port at all.
	 */
	remotePort?: number;
	/**
	 * Custom text the PR review preset in the create-task popup injects into the
	 * description. Absent/blank ⇒ the localized built-in prompt. A project can
	 * override it; see resolvePresetPrompt.
	 */
	reviewModePrompt?: string;
	/**
	 * Custom text the Coordinator preset in the create-task popup injects into
	 * the description. Absent/blank ⇒ the built-in COORDINATOR_PROMPT. A project
	 * can override it; see resolvePresetPrompt.
	 */
	coordinatorPrompt?: string;
	/**
	 * Cross-provider "favorite" agent configs shown as quick-pick chips on the
	 * launch picker (Launch/Retry, Spawn, Bug Hunters). Thin pointers, capped at
	 * MAX_FAVORITES with LFU-then-LRU eviction; ordered by uses then recency.
	 * See src/shared/favorites.ts. Undefined ⇒ none.
	 */
	favorites?: FavoriteAgentConfig[];
	/**
	 * User rebinds of app-level keyboard shortcuts, keyed by `keymap.ts` shortcut
	 * id. Sparse on purpose — only rows the user actually changed are stored, so a
	 * changed default still reaches everyone who left that row alone. A slot set to
	 * `null` means "deliberately unbound". See `src/mainview/keymap-store.ts`.
	 */
	keyboardShortcuts?: ShortcutOverrides;
}

/** Every shortcut has one main combo and one optional second way to press it. */
export type ShortcutSlot = "primary" | "alias";

/**
 * A user override for one shortcut. A slot that is absent keeps its default; a
 * slot set to `null` was deliberately emptied by the user. Bindings serialize as
 * `"<Mod|Meta|Ctrl|Alt|Shift>+…+<KeyboardEvent.code>"`, e.g. `"Mod+Shift+KeyP"` —
 * the string form keeps settings.json diffable and lets an unparsable entry be
 * dropped instead of corrupting the whole keymap.
 */
export interface ShortcutOverride {
	primary?: string | null;
	alias?: string | null;
}

/** Sparse: only shortcuts the user actually touched appear here. */
export type ShortcutOverrides = Record<string, ShortcutOverride>;

/** Behavior of Cmd/Ctrl+Click on a file path in terminal output. */
export type TerminalPathOpenMode = "preview" | "system" | "reveal";

/** A path candidate resolved against a task worktree / project directory. */
export interface ResolvedTerminalPath {
	/** Absolute, normalized path that exists on disk. */
	path: string;
	kind: "file" | "directory";
}

/**
 * Content of a file for the in-app terminal path preview modal. `text` is
 * capped (see FILE_PREVIEW_MAX_TEXT_BYTES); larger files report `too-large`
 * so the modal can offer external open instead of shipping megabytes over RPC.
 */
export type FilePreviewResult =
	| { kind: "text"; content: string; truncated: boolean; size: number }
	| { kind: "image"; dataUrl: string; size: number }
	/** Played from a `getFileMediaUrl` stream; the bytes never travel over RPC. */
	| { kind: "media"; media: "audio" | "video"; mime: string; size: number }
	| { kind: "binary"; size: number }
	| { kind: "too-large"; size: number }
	| { kind: "directory" }
	| { kind: "not-found" };

export interface TipState {
	snoozedUntil: number; // timestamp — all tips hidden until this time
	seen: Record<string, number>; // tipId → last-seen timestamp
	rotationIndex: number;
}
