import { useState, useEffect, useRef, useCallback, useMemo, type Dispatch, type DragEvent, type MutableRefObject, type ReactNode } from "react";
import { toast } from "../toast";
import { confirm } from "../confirm";
import type { CodingAgent, ColumnAgentConfig, CustomColumn, Dev3RepoConfig, GitHubAccount, GitHubCliStatus, Label, Project, SetupScriptLaunchMode, Task } from "../../shared/types";
import { ACTIVE_STATUSES, getTaskTitle } from "../../shared/types";
import { hasEnvLineBreak, parseEnvText, serializeEnvText } from "../../shared/env-text";
import { CUSTOM_COLUMN_INSTRUCTION_MAX_CHARS, DEFAULT_REVIEW_AGENT_ID, DEFAULT_REVIEW_CONFIG_ID, DEFAULT_REVIEW_PROMPT, resolveReviewModePrompt } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { ListEditor } from "./ListEditor";
import AgentConfigPicker from "./AgentConfigPicker";
import AutomationsPanel from "./AutomationsPanel";
import ColorSwatchPicker from "./ColorSwatchPicker";
import SettingsSection from "./global-settings/SettingsSection";
import { matchesBranchQuery } from "./BranchSelector";
import type { NavigationGuard } from "../navigation-guard";

const CONFIG_BOOLEAN_DEFAULTS = {
	autoReviewEnabled: false,
	peerReviewEnabled: true,
	sparseCheckoutEnabled: false,
} as const;

type ProjectConfigValues = Dev3RepoConfig & {
	githubAuthHost?: string | null;
	githubAuthLogin?: string | null;
};

function normalizeReviewPrompt(prompt: string): string {
	return prompt.trim() === DEFAULT_REVIEW_PROMPT ? "" : prompt.trim();
}

/** Label + description + control, in the shape GlobalSettings uses. */
function Field({ title, description, children }: { title: string; description: string; children: ReactNode }) {
	return (
		<div>
			<span className="block text-fg text-sm font-semibold mb-2">{title}</span>
			<p className="text-fg-3 text-sm mb-3">{description}</p>
			{children}
		</div>
	);
}

/** Quiet placeholder shown where a list has nothing in it yet. */
function EmptyHint({ children }: { children: ReactNode }) {
	return (
		<p className="px-3 py-4 text-center text-fg-muted text-sm border border-dashed border-edge rounded-xl">
			{children}
		</p>
	);
}

/** "+ Add …" action that closes a settings list. */
function AddRowButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="mt-3 px-2.5 py-1.5 -ml-2.5 rounded-lg text-sm text-accent font-medium outline-none hover:bg-accent/10 focus-visible:ring-2 focus-visible:ring-accent/50 transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96] disabled:opacity-50"
		>
			{children}
		</button>
	);
}

/** Amber caution note for a setting whose consequences are easy to miss. */
function WarningNote({ children }: { children: ReactNode }) {
	return (
		<div className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5">
			<span className="mt-0.5 flex-shrink-0 text-warning text-base">&#9888;</span>
			<p className="text-fg-2 text-xs leading-relaxed">{children}</p>
		</div>
	);
}

/**
 * The screen's only switch. Kept local (rather than reusing
 * global-settings/SettingsToggle) because these switches sit right-aligned
 * against a label+description block instead of carrying their own text.
 */
function ToggleSwitch({
	checked,
	ariaLabel,
	onToggle,
	size = "md",
}: {
	checked: boolean;
	ariaLabel: string;
	onToggle: () => void;
	size?: "sm" | "md";
}) {
	const track = size === "sm" ? "w-8 h-5" : "w-10 h-6";
	const knob = size === "sm" ? "w-4 h-4" : "w-5 h-5";
	const shift = size === "sm" ? "translate-x-3" : "translate-x-4";
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={ariaLabel}
			onClick={onToggle}
			className={`relative flex-shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-base ${track} ${
				checked ? "bg-accent" : "bg-edge-active"
			}`}
		>
			<span
				className={`absolute top-0.5 left-0.5 rounded-full bg-white shadow transition-transform duration-150 ease-out ${knob} ${
					checked ? shift : "translate-x-0"
				}`}
			/>
		</button>
	);
}

interface LabelRowProps {
	label: Label;
	saving: boolean;
	onUpdate: (name: string, color: string) => void;
	onDelete: () => void;
	nameLabel: string;
	deleteLabel: string;
	/** Number of project tasks currently carrying this label (any status). */
	taskCount: number;
	// ---- Reorder ----
	/** Whether reorder affordances are active (disabled while any label saves). */
	reorderEnabled: boolean;
	/** This row is the current drag source (dimmed). */
	dragged: boolean;
	/** Show the accent drop line on this edge while a sibling is dragged over. */
	dropSide: "before" | "after" | null;
	isFirst: boolean;
	isLast: boolean;
	onDragStart: () => void;
	onDragOver: (event: DragEvent<HTMLDivElement>) => void;
	onDragLeave: () => void;
	onDrop: (event: DragEvent<HTMLDivElement>) => void;
	onDragEnd: () => void;
	onMoveUp: () => void;
	onMoveDown: () => void;
}

function LabelRow({
	label,
	saving,
	onUpdate,
	onDelete,
	nameLabel,
	deleteLabel,
	taskCount,
	reorderEnabled,
	dragged,
	dropSide,
	isFirst,
	isLast,
	onDragStart,
	onDragOver,
	onDragLeave,
	onDrop,
	onDragEnd,
	onMoveUp,
	onMoveDown,
}: LabelRowProps) {
	const t = useT();
	const [name, setName] = useState(label.name);
	const [color, setColor] = useState(label.color);

	function commitUpdate(newName = name, newColor = color) {
		if (newName.trim() && (newName !== label.name || newColor !== label.color)) {
			onUpdate(newName.trim(), newColor);
		}
	}

	const canDrag = reorderEnabled && !saving;

	return (
		<div
			className={`group relative flex items-center gap-1.5 p-2 pl-1.5 bg-elevated rounded-xl border border-edge hover:border-edge-active transition-[opacity,border-color] duration-150 ease-out ${dragged ? "opacity-50" : ""}`}
			onDragOver={onDragOver}
			onDragLeave={onDragLeave}
			onDrop={onDrop}
		>
			{dropSide === "before" && <div className="absolute -top-1 left-3 right-3 h-0.5 bg-accent rounded-full z-10 pointer-events-none" />}
			{dropSide === "after" && <div className="absolute -bottom-1 left-3 right-3 h-0.5 bg-accent rounded-full z-10 pointer-events-none" />}
			{/* Reorder cluster — grip drags, arrows step (keyboard/touch fallback).
			    Arrows are hover/focus-revealed from `md` up; below that there is no
			    hover, so they stay visible to keep reorder reachable by touch. */}
			<div className="flex items-center gap-0.5 flex-shrink-0">
				<button
					type="button"
					draggable={canDrag}
					onDragStart={(e) => {
						if (!canDrag) return;
						e.dataTransfer.effectAllowed = "move";
						onDragStart();
					}}
					onDragEnd={onDragEnd}
					disabled={!canDrag}
					className="text-fg-muted hover:text-fg transition-colors p-1 rounded-lg hover:bg-raised-hover outline-none focus-visible:ring-2 focus-visible:ring-accent/60 cursor-grab active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
					title={t("labels.dragToReorder")}
					aria-label={t("labels.dragToReorder")}
				>
					<span className="text-base leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F01DB}"}</span>
				</button>
				<div className="flex items-center gap-0.5 transition-opacity duration-150 ease-out md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
					<button
						type="button"
						onClick={onMoveUp}
						disabled={!reorderEnabled || saving || isFirst}
						className="text-fg-muted hover:text-fg transition-[color,background-color,opacity] duration-150 ease-out p-1 rounded-lg hover:bg-raised-hover outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-30 disabled:hover:text-fg-muted disabled:hover:bg-transparent"
						title={t("labels.moveUp")}
						aria-label={t("labels.moveUp")}
					>
						<span className="text-sm-plus leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF062"}</span>
					</button>
					<button
						type="button"
						onClick={onMoveDown}
						disabled={!reorderEnabled || saving || isLast}
						className="text-fg-muted hover:text-fg transition-[color,background-color,opacity] duration-150 ease-out p-1 rounded-lg hover:bg-raised-hover outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-30 disabled:hover:text-fg-muted disabled:hover:bg-transparent"
						title={t("labels.moveDown")}
						aria-label={t("labels.moveDown")}
					>
						<span className="text-sm-plus leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF063"}</span>
					</button>
				</div>
			</div>
			{/* The current-colour dot is the palette trigger */}
			<ColorSwatchPicker
				value={color}
				disabled={saving}
				label={t("labels.colorPicker")}
				onChange={(next) => {
					setColor(next);
					commitUpdate(name, next);
				}}
			/>
			{/* Name input */}
			<input
				type="text"
				value={name}
				onChange={(e) => setName(e.target.value)}
				onBlur={() => commitUpdate()}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.currentTarget.blur();
					}
				}}
				aria-label={nameLabel}
				placeholder={nameLabel}
				disabled={saving}
				className="flex-1 min-w-0 px-2 py-1 bg-transparent border border-transparent rounded-lg text-fg text-sm outline-none placeholder-fg-muted transition-colors hover:border-edge focus:border-accent/40 focus:bg-base"
			/>
			{/* Task-count badge: how many project tasks carry this label. Quiet,
			    read-only; dimmed at 0 to flag an unused label. */}
			<span
				className={`flex-shrink-0 text-xs font-medium tabular-nums px-1.5 py-0.5 rounded-full bg-base ${
					taskCount === 0 ? "text-fg-muted" : "text-fg-3"
				}`}
				title={t.plural("labels.taskCount", taskCount)}
				aria-label={t.plural("labels.taskCount", taskCount)}
			>
				{taskCount}
			</span>
			{/* Delete */}
			<button
				type="button"
				onClick={onDelete}
				disabled={saving}
				className="grid place-items-center w-7 h-7 rounded-lg text-fg-3 hover:text-danger hover:bg-danger/10 outline-none focus-visible:ring-2 focus-visible:ring-danger/50 transition-colors flex-shrink-0"
				title={deleteLabel}
				aria-label={deleteLabel}
			>
				<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
					<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		</div>
	);
}

interface CustomColumnRowProps {
	column: CustomColumn;
	saving: boolean;
	onUpdate: (name: string, color: string, llmInstruction: string, agentConfig?: ColumnAgentConfig | null) => void;
	onDelete: () => void;
	availableAgents: CodingAgent[];
}

function CustomColumnRow({ column, saving, onUpdate, onDelete, availableAgents }: CustomColumnRowProps) {
	const t = useT();
	const [name, setName] = useState(column.name);
	const [color, setColor] = useState(column.color);
	const [llmInstruction, setLlmInstruction] = useState(column.llmInstruction);
	const [agentEnabled, setAgentEnabled] = useState(!!column.agentConfig);
	const [agentId, setAgentId] = useState(column.agentConfig?.agentId ?? "builtin-claude");
	const [configId, setConfigId] = useState(column.agentConfig?.configId ?? "claude-default");
	const [agentPrompt, setAgentPrompt] = useState(column.agentConfig?.prompt ?? "");

	function buildAgentConfig(): ColumnAgentConfig | null {
		if (!agentEnabled) return null;
		return { agentId, configId, prompt: agentPrompt };
	}

	function commitUpdate(newName = name, newColor = color, newInstruction = llmInstruction, newAgentConfig?: ColumnAgentConfig | null) {
		const trimmedName = newName.trim();
		if (!trimmedName) return;
		// An instruction past the limit is rejected by the agent side, so never
		// persist it — the counter turns red and explains why nothing saved.
		if (newInstruction.length > CUSTOM_COLUMN_INSTRUCTION_MAX_CHARS) return;
		onUpdate(trimmedName, newColor, newInstruction, newAgentConfig !== undefined ? newAgentConfig : buildAgentConfig());
	}

	const isOverLimit = llmInstruction.length > CUSTOM_COLUMN_INSTRUCTION_MAX_CHARS;

	return (
		<div className="p-3 bg-elevated rounded-xl border border-edge space-y-3">
			{/* Name + color + delete */}
			<div>
				<div className="flex items-center justify-between mb-1">
					<span className="text-fg-3 text-xs">{t("customColumns.columnName")}</span>
					<button
						type="button"
						onClick={onDelete}
						disabled={saving}
						className="grid place-items-center w-7 h-7 rounded-lg text-fg-3 hover:text-danger hover:bg-danger/10 outline-none focus-visible:ring-2 focus-visible:ring-danger/50 transition-colors"
						title={t("customColumns.deleteColumn")}
						aria-label={t("customColumns.deleteColumn")}
					>
						<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>
				<div className="flex items-center gap-1.5">
					<ColorSwatchPicker
						value={color}
						disabled={saving}
						label={t("customColumns.colorPicker")}
						onChange={(next) => { setColor(next); commitUpdate(name, next, llmInstruction); }}
					/>
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						onBlur={() => commitUpdate()}
						onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
						aria-label={t("customColumns.columnName")}
						placeholder={t("customColumns.columnName")}
						disabled={saving}
						className="flex-1 px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/40 transition-colors min-w-0"
					/>
				</div>
			</div>
			{/* LLM instruction */}
			<div>
				<label htmlFor={`column-instruction-${column.id}`} className="block text-fg-3 text-xs mb-1">{t("customColumns.llmInstruction")}</label>
				<textarea
					id={`column-instruction-${column.id}`}
					value={llmInstruction}
					onChange={(e) => setLlmInstruction(e.target.value)}
					onBlur={() => commitUpdate()}
					placeholder={t("customColumns.llmInstructionPlaceholder")}
					disabled={saving}
					rows={2}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					aria-invalid={isOverLimit}
					aria-describedby={`column-instruction-count-${column.id}`}
					className={`w-full px-3 py-2 bg-base border rounded-lg text-fg-2 text-xs placeholder-fg-muted outline-none transition-colors resize-none ${
						isOverLimit ? "border-danger focus:border-danger" : "border-edge focus:border-accent/40"
					}`}
				/>
				<div
					id={`column-instruction-count-${column.id}`}
					aria-live="polite"
					className={`text-right text-xs mt-0.5 tabular-nums ${isOverLimit ? "text-danger" : "text-fg-muted"}`}
				>
					{t("customColumns.charCount", { count: String(llmInstruction.length), max: String(CUSTOM_COLUMN_INSTRUCTION_MAX_CHARS) })}
					{isOverLimit && <span className="ml-2">{t("customColumns.charCountOverLimit")}</span>}
				</div>
			</div>
			{/* Column Agent */}
			<div className="border-t border-edge/50 pt-3">
				<div className="flex items-center justify-between gap-3 mb-2">
					<div>
						<span className="block text-fg-3 text-xs font-medium">{t("columnAgent.title")}</span>
						<p className="text-fg-muted text-dense">{t("columnAgent.desc")}</p>
					</div>
					<ToggleSwitch
						checked={agentEnabled}
						ariaLabel={t("columnAgent.enable")}
						size="sm"
						onToggle={() => {
							const next = !agentEnabled;
							setAgentEnabled(next);
							commitUpdate(name, color, llmInstruction, next ? { agentId, configId, prompt: agentPrompt } : null);
						}}
					/>
				</div>
				{agentEnabled && (
					<div className="space-y-2 pl-1">
						<AgentConfigPicker
							idPrefix={`column-agent-${column.id}`}
							agents={availableAgents}
							agentId={agentId}
							configId={configId}
							onChange={(next) => {
								const nextAgentId = next.agentId ?? "builtin-claude";
								const nextConfigId = next.configId ?? "claude-default";
								setAgentId(nextAgentId);
								setConfigId(nextConfigId);
								// State updates are async, so persist with the fresh pair
								// rather than relying on the (stale) state values.
								commitUpdate(name, color, llmInstruction, { agentId: nextAgentId, configId: nextConfigId, prompt: agentPrompt });
							}}
						/>
						<div>
							<label htmlFor={`column-agent-prompt-${column.id}`} className="block text-fg-3 text-xs mb-1">{t("columnAgent.prompt")}</label>
							<textarea
								id={`column-agent-prompt-${column.id}`}
								value={agentPrompt}
								onChange={(e) => setAgentPrompt(e.target.value)}
								onBlur={() => commitUpdate()}
								placeholder={t("columnAgent.promptPlaceholder")}
								disabled={saving}
								rows={3}
								autoCapitalize="off"
								autoCorrect="off"
								spellCheck={false}
								className="w-full px-2 py-1.5 bg-base border border-edge rounded-lg text-fg-2 text-xs placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y font-mono"
							/>
							<p className="text-fg-muted text-nano mt-1">{t("columnAgent.hint")}</p>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

// ---- Env vars editor (dotenv-style textarea backed by config.env) ----

type EnvStorageScope = "project" | "repo" | "local";

function envWithoutLineBreaks(env: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(env).filter(([, value]) => !hasEnvLineBreak(value)));
}

function EnvVarsEditor({ env, storageScope, onChange, onErrorChange }: {
	env: Record<string, string> | undefined;
	storageScope: EnvStorageScope;
	onChange: (env: Record<string, string> | undefined) => void;
	onErrorChange?: (hasError: boolean) => void;
}) {
	const t = useT();
	const lineBreakEntries = Object.entries(env ?? {}).filter(([, value]) => hasEnvLineBreak(value));
	const [text, setText] = useState(() => serializeEnvText(envWithoutLineBreaks(env ?? {})));
	const [errorLines, setErrorLines] = useState<number[]>([]);
	// Tracks the env value this editor last emitted (or was initialized from);
	// an external change (tab switch, async config load) reinitializes the text.
	const emittedRef = useRef(JSON.stringify(env ?? {}));

	useEffect(() => {
		const incoming = JSON.stringify(env ?? {});
		if (incoming !== emittedRef.current) {
			emittedRef.current = incoming;
			setText(serializeEnvText(envWithoutLineBreaks(env ?? {})));
			setErrorLines([]);
		}
	}, [env]); // eslint-disable-line react-hooks/exhaustive-deps

	// The cleanup clears the parent's gate on unmount (config-layer switch): child
	// effects run before parent ones, so a parent-side reset would overwrite the
	// value this editor just reported for the layer it mounted with.
	useEffect(() => {
		onErrorChange?.(errorLines.length > 0 || lineBreakEntries.length > 0);
		return () => onErrorChange?.(false);
	}, [errorLines.length, lineBreakEntries.length, onErrorChange]);

	function handleChange(next: string) {
		setText(next);
		const { env: parsed, errors } = parseEnvText(next);
		setErrorLines(errors.map((e) => e.line));
		if (errors.length === 0) {
			// Always emit an object (never undefined): the save handlers skip
			// undefined params, which would make a cleared env impossible to persist.
			const preserved = Object.fromEntries(lineBreakEntries);
			const updated = { ...preserved, ...parsed };
			emittedRef.current = JSON.stringify(updated);
			onChange(updated);
		}
	}

	function removeLineBreakEntry(key: string) {
		const updated = { ...(env ?? {}) };
		delete updated[key];
		emittedRef.current = JSON.stringify(updated);
		onChange(updated);
	}

	return (
		<div>
			<p className="block text-fg text-sm font-semibold mb-2">
				{t("projectSettings.envVars")}
			</p>
			<p className="text-fg-3 text-sm mb-3">
				{t("projectSettings.envVarsDesc")}
			</p>
			{storageScope === "repo" ? (
				<div role="note" className="mb-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-danger-strong">
					<span aria-hidden="true" className="shrink-0 text-sm leading-5">&#9888;</span>
					<p className="text-xs leading-5">{t("projectSettings.envVarsRepoWarning")}</p>
				</div>
			) : (
				<p className="mb-3 text-xs leading-5 text-fg-3">
					{t(storageScope === "project"
						? "projectSettings.envVarsProjectNotice"
						: "projectSettings.envVarsLocalNotice")}
				</p>
			)}
			<textarea
				value={text}
				onChange={(e) => handleChange(e.target.value)}
				rows={4}
				placeholder={t("projectSettings.envVarsPlaceholder")}
				aria-label={t("projectSettings.envVars")}
				autoCapitalize="off"
				autoCorrect="off"
				spellCheck={false}
				className={`w-full px-4 py-3 bg-raised border rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none transition-colors resize-y ${
					errorLines.length > 0 ? "border-danger/60 focus:border-danger" : "border-edge focus:border-accent/40"
				}`}
			/>
			{lineBreakEntries.length > 0 && (
				<div role="note" className="mt-2 rounded-lg border border-edge bg-elevated/50 px-3 py-2.5">
					<p className="text-xs font-medium text-fg-2">
						{t("projectSettings.envVarsLineBreakTitle")}
					</p>
					<p className="mt-1 text-xs leading-5 text-fg-3">
						{t("projectSettings.envVarsLineBreakDesc")}
					</p>
					<div className="mt-2 divide-y divide-edge/60">
						{lineBreakEntries.map(([key]) => (
							<div key={key} className="flex min-w-0 items-center justify-between gap-3 py-1.5">
								<code className="min-w-0 break-all text-xs text-fg-2">{key}</code>
								<button
									type="button"
									onClick={() => removeLineBreakEntry(key)}
									aria-label={t("projectSettings.envVarsRemoveLineBreakAria", { key })}
									className="shrink-0 rounded px-2 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
								>
									{t("projectSettings.envVarsRemoveLineBreak")}
								</button>
							</div>
						))}
					</div>
				</div>
			)}
			{errorLines.length > 0 && (
				<p className="text-danger text-sm mt-2">
					{t("projectSettings.envVarsInvalidLines", { lines: errorLines.join(", ") })}
				</p>
			)}
		</div>
	);
}

// ---- Config form (shared between Repo and Local tabs) ----

interface ConfigFormProps {
	config: Dev3RepoConfig;
	onChange: (config: Dev3RepoConfig) => void;
	/** For each field, the inherited value from the lower-priority layer (shown as placeholder). */
	inherited?: Dev3RepoConfig;
	/** Show auto-detect for clone paths */
	projectId: string;
	/** Project path for "Open in Finder" on sparse checkout */
	projectPath?: string;
	/** Destination that owns env values, used for storage-specific safety copy. */
	envStorageScope: EnvStorageScope;
	/** Reports whether the env textarea currently holds unparseable lines. */
	onEnvErrorChange?: (hasError: boolean) => void;
}

interface BranchInfo {
	name: string;
	isRemote: boolean;
}

interface BranchPickerProps {
	projectId: string;
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
	label: string;
	includeRemote: boolean;
}

function BranchPicker({
	projectId,
	value,
	onChange,
	placeholder,
	label,
	includeRemote,
}: BranchPickerProps) {
	const t = useT();
	const [branches, setBranches] = useState<BranchInfo[]>([]);
	const [branchesLoaded, setBranchesLoaded] = useState(false);
	const [dropdownOpen, setDropdownOpen] = useState(false);
	const [editing, setEditing] = useState(false);
	const [query, setQuery] = useState("");
	const dropdownRef = useRef<HTMLDivElement>(null);

	const loadBranches = useCallback(async () => {
		if (branchesLoaded) return;
		try {
			const result = await api.request.listBranches({ projectId });
			setBranches(result);
			setBranchesLoaded(true);
		} catch {
			setBranchesLoaded(true);
		}
	}, [branchesLoaded, projectId]);

	useEffect(() => {
		function handleClickOutside(event: MouseEvent) {
			if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
				setDropdownOpen(false);
				setEditing(false);
				setQuery("");
			}
		}

		if (dropdownOpen) {
			document.addEventListener("mousedown", handleClickOutside);
			return () => document.removeEventListener("mousedown", handleClickOutside);
		}
	}, [dropdownOpen]);

	const filteredBranches = branches.filter((branch) =>
		(includeRemote || !branch.isRemote) && matchesBranchQuery(branch.name, query),
	);
	const localBranches = filteredBranches.filter((branch) => !branch.isRemote);
	const remoteBranches = filteredBranches.filter((branch) => branch.isRemote);
	const inputValue = editing ? query : value;

	return (
		<div className="relative" ref={dropdownRef}>
			<input
				type="text"
				value={inputValue}
				onFocus={() => {
					loadBranches();
					setEditing(true);
					setQuery("");
					setDropdownOpen(true);
				}}
				onChange={(event) => {
					setEditing(true);
					setQuery(event.target.value);
					setDropdownOpen(true);
				}}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						setDropdownOpen(false);
						setEditing(false);
						setQuery("");
					}
				}}
				aria-label={label}
				placeholder={placeholder}
				autoCapitalize="off"
				autoCorrect="off"
				spellCheck={false}
				className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
			/>
			{dropdownOpen && (
				<div className="absolute z-10 mt-1 w-full max-h-56 overflow-y-auto bg-overlay border border-edge rounded-xl shadow-lg">
					{localBranches.length > 0 && (
						<>
							<div className="px-3 py-1 text-dense font-semibold text-fg-muted uppercase tracking-wider">
								{t("createTask.branchLocal")}
							</div>
							{localBranches.map((branch) => (
								<button
									key={branch.name}
									type="button"
									onMouseDown={(event) => event.preventDefault()}
									onClick={() => {
										onChange(branch.name);
										setDropdownOpen(false);
										setEditing(false);
										setQuery("");
									}}
									className="w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-raised-hover transition-colors truncate"
								>
									{branch.name}
								</button>
							))}
						</>
					)}

					{includeRemote && remoteBranches.length > 0 && (
						<>
							<div className="px-3 py-1 text-dense font-semibold text-fg-muted uppercase tracking-wider">
								{t("createTask.branchRemote")}
							</div>
							{remoteBranches.map((branch) => (
								<button
									key={branch.name}
									type="button"
									onMouseDown={(event) => event.preventDefault()}
									onClick={() => {
										onChange(branch.name);
										setDropdownOpen(false);
										setEditing(false);
										setQuery("");
									}}
									className="w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-raised-hover transition-colors truncate"
								>
									{branch.name}
								</button>
							))}
						</>
					)}

					{filteredBranches.length === 0 && (
						<div className="px-3 py-2 text-sm text-fg-muted">
							{t("createTask.branchNoneFound")}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function getEffectiveCompareRef(config: Dev3RepoConfig, fallbackBaseBranch: string, fallbackCompareRef?: string): string | undefined {
	if (config.defaultCompareRef !== undefined) return config.defaultCompareRef;
	if (config.defaultCompareRefMode === "local") return config.defaultBaseBranch ?? fallbackBaseBranch;
	if (config.defaultCompareRefMode === "remote") return `origin/${config.defaultBaseBranch ?? fallbackBaseBranch}`;
	return fallbackCompareRef;
}

function encodeGitHubAccountValue(account: Pick<GitHubAccount, "host" | "login">): string {
	return `${account.host}\t${account.login}`;
}

function decodeGitHubAccountValue(value: string): Pick<ProjectConfigValues, "githubAuthHost" | "githubAuthLogin"> {
	const [host, login] = value.split("\t");
	return {
		githubAuthHost: host || null,
		githubAuthLogin: login || null,
	};
}

function formatGitHubAccountLabel(account: GitHubAccount, accounts: GitHubAccount[]): string {
	const multipleHosts = new Set(accounts.map((item) => item.host)).size > 1;
	return multipleHosts ? `${account.login} @ ${account.host}` : account.login;
}

function normalizeLocalConfig(config: Dev3RepoConfig, inherited: Dev3RepoConfig): Dev3RepoConfig {
	const fallbackBaseBranch = inherited.defaultBaseBranch ?? "main";
	const defaultCompareRef = getEffectiveCompareRef(config, fallbackBaseBranch);
	return defaultCompareRef === undefined
		? config
		: { ...config, defaultCompareRef };
}

function ConfigForm({ config, onChange, inherited, projectId, projectPath, envStorageScope, onEnvErrorChange }: ConfigFormProps) {
	const t = useT();
	const [detecting, setDetecting] = useState(false);
	const [detectFeedback, setDetectFeedback] = useState<string | null>(null);
	const setupScriptLaunchMode = config.setupScriptLaunchMode ?? inherited?.setupScriptLaunchMode ?? "parallel";

	function update(field: keyof Dev3RepoConfig, value: Dev3RepoConfig[keyof Dev3RepoConfig]) {
		onChange({ ...config, [field]: value });
	}

	async function runAutoDetect() {
		setDetecting(true);
		setDetectFeedback(null);
		try {
			const detected = await api.request.detectClonePaths({ projectId });
			if (detected.length > 0) {
				const existing = new Set(config.clonePaths ?? []);
				const merged = [...(config.clonePaths ?? []), ...detected.filter((p) => !existing.has(p))];
				update("clonePaths", merged);
				setDetectFeedback(t.plural("projectSettings.autoDetectFound", detected.length));
			} else {
				setDetectFeedback(t("projectSettings.autoDetectNone"));
			}
		} catch {
			setDetectFeedback(t("projectSettings.autoDetectNone"));
		}
		setDetecting(false);
	}

	function inheritedHint(field: keyof Dev3RepoConfig): string {
		const val = inherited?.[field];
		if (val === undefined || val === null) return "";
		if (Array.isArray(val)) return val.join(", ") || "";
		return String(val);
	}

	return (
		<div>
			<SettingsSection
				title={t("projectSettings.groupScripts")}
				description={t("projectSettings.groupScriptsDesc")}
			>
			{/* Setup Script */}
			<Field title={t("projectSettings.setupScript")} description={t("projectSettings.setupScriptDesc")}>
				<textarea
					value={config.setupScript ?? ""}
					onChange={(e) => update("setupScript", e.target.value)}
					rows={4}
					placeholder={inheritedHint("setupScript") || "bun install"}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					aria-label={t("projectSettings.setupScript")}
					className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
				/>
			</Field>

			<div>
				<fieldset>
					<legend className="block text-fg text-sm font-semibold mb-2">
						{t("projectSettings.setupScriptLaunchMode")}
					</legend>
					<p className="text-fg-3 text-sm mb-3">
						{t("projectSettings.setupScriptLaunchModeDesc")}
					</p>
					<div role="radiogroup" aria-label={t("projectSettings.setupScriptLaunchMode")} className="grid gap-3 sm:grid-cols-2">
						{([
							{
								value: "parallel",
								title: t("projectSettings.setupScriptLaunchModeParallel"),
								description: t("projectSettings.setupScriptLaunchModeParallelDesc"),
							},
							{
								value: "blocking",
								title: t("projectSettings.setupScriptLaunchModeBlocking"),
								description: t("projectSettings.setupScriptLaunchModeBlockingDesc"),
							},
						] as const).map((option) => {
							const checked = setupScriptLaunchMode === option.value;
							return (
								<button
									key={option.value}
									type="button"
									role="radio"
									aria-checked={checked}
									aria-label={option.title}
									tabIndex={checked ? 0 : -1}
									onClick={() => update("setupScriptLaunchMode", option.value as SetupScriptLaunchMode)}
									onKeyDown={(event) => {
										if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(event.key)) return;
										event.preventDefault();
										update("setupScriptLaunchMode", (option.value === "parallel" ? "blocking" : "parallel") as SetupScriptLaunchMode);
										const siblings = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
										siblings?.[option.value === "parallel" ? 1 : 0]?.focus();
									}}
									className={`rounded-xl border p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 ${
										checked
											? "border-accent/60 bg-accent/10"
											: "border-edge bg-raised hover:border-edge-active hover:bg-raised-hover"
									}`}
								>
									<div className="text-fg text-sm font-semibold">{option.title}</div>
									<div className="mt-1 text-fg-3 text-sm">{option.description}</div>
								</button>
							);
						})}
					</div>
				</fieldset>
			</div>

			{/* Dev Script */}
			<Field title={t("projectSettings.devScript")} description={t("projectSettings.devScriptDesc")}>
				<textarea
					value={config.devScript ?? ""}
					onChange={(e) => update("devScript", e.target.value)}
					rows={4}
					placeholder={inheritedHint("devScript") || "bun run dev"}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					aria-label={t("projectSettings.devScript")}
					className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
				/>
			</Field>

			{/* Cleanup Script */}
			<Field title={t("projectSettings.cleanupScript")} description={t("projectSettings.cleanupScriptDesc")}>
				<textarea
					value={config.cleanupScript ?? ""}
					onChange={(e) => update("cleanupScript", e.target.value)}
					rows={4}
					placeholder={inheritedHint("cleanupScript") || "git worktree remove ."}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					aria-label={t("projectSettings.cleanupScript")}
					className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y"
				/>
			</Field>

			{/* Environment Variables */}
			<EnvVarsEditor
				env={config.env}
				storageScope={envStorageScope}
				onChange={(env) => update("env", env)}
				onErrorChange={onEnvErrorChange}
			/>
			</SettingsSection>

			<SettingsSection
				title={t("projectSettings.groupWorktree")}
				description={t("projectSettings.groupWorktreeDesc")}
			>
			{/* Clone Paths (CoW) */}
			<div>
				<span className="block text-fg text-sm font-semibold mb-2">
					{t("projectSettings.clonePaths")}
				</span>
				<div className="flex items-start gap-3 mb-3">
					<p className="text-fg-3 text-sm flex-1">
						{t("projectSettings.clonePathsDesc")}
					</p>
					<button
						type="button"
						onClick={runAutoDetect}
						disabled={detecting}
						className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg border border-accent/30 text-accent outline-none hover:bg-accent/10 hover:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/50 transition-[color,background-color,border-color,transform] duration-150 ease-out active:scale-[0.96] disabled:opacity-50"
					>
						{detecting ? t("projectSettings.autoDetecting") : t("projectSettings.autoDetect")}
					</button>
				</div>
				{detectFeedback && (
					<p className="text-fg-3 text-xs mb-2" aria-live="polite">{detectFeedback}</p>
				)}
				<ListEditor
					items={config.clonePaths ?? []}
					onChange={(items) => {
						update("clonePaths", items);
						setDetectFeedback(null);
					}}
					placeholder={inheritedHint("clonePaths") || "node_modules"}
					addLabel={t("projectSettings.addClonePath")}
					removeLabel={t("listEditor.removeItem")}
				/>
			</div>

			{/* Worktree File Filter (Sparse Checkout) */}
			<div>
				<span className="block text-fg text-sm font-semibold mb-2">
					{t("projectSettings.sparseCheckout")}
				</span>
				<div className="flex items-start gap-3 mb-3">
					<p className="text-fg-3 text-sm flex-1">
						{t("projectSettings.sparseCheckoutDesc")}
					</p>
					{(config.sparseCheckoutEnabled ?? false) && projectPath && (
						<button
							type="button"
							onClick={() => api.request.openFolder({ path: projectPath })}
							className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg border border-accent/30 text-accent outline-none hover:bg-accent/10 hover:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/50 transition-[color,background-color,border-color,transform] duration-150 ease-out active:scale-[0.96]"
						>
							{t("projectSettings.sparseCheckoutOpenFinder")}
						</button>
					)}
				</div>
				<div className="flex items-center justify-between gap-4 mb-3">
					<span className="text-fg-2 text-sm">{t("projectSettings.sparseCheckoutAll")}</span>
					<ToggleSwitch
						checked={!(config.sparseCheckoutEnabled ?? false)}
						ariaLabel={t("projectSettings.sparseCheckoutAll")}
						onToggle={() => {
							const next = !(config.sparseCheckoutEnabled ?? false);
							const updates: Partial<Dev3RepoConfig> = { sparseCheckoutEnabled: next };
							if (next && !(config.sparseCheckoutPaths?.length)) {
								updates.sparseCheckoutPaths = [""];
							}
							onChange({ ...config, ...updates });
						}}
					/>
				</div>
				{(config.sparseCheckoutEnabled ?? false) && (
					<ListEditor
						items={config.sparseCheckoutPaths ?? []}
						onChange={(items) => update("sparseCheckoutPaths", items)}
						placeholder={t("projectSettings.sparseCheckoutPlaceholder")}
						addLabel={t("projectSettings.sparseCheckoutAddPath")}
						removeLabel={t("listEditor.removeItem")}
					/>
				)}
			</div>

			{/* Port Allocation */}
			<div>
				<label htmlFor="project-port-count" className="block text-fg text-sm font-semibold mb-1">
					{t("projectSettings.portCount")}
				</label>
				<p className="text-fg-3 text-sm mb-2">
					{t("projectSettings.portCountDesc")}
				</p>
				<input
					id="project-port-count"
					type="number"
					min={0}
					max={20}
					value={config.portCount ?? 0}
					onChange={(e) => update("portCount", Math.max(0, Math.min(20, parseInt(e.target.value) || 0)))}
					className="w-20 px-3 py-1.5 rounded-lg bg-base border border-edge text-fg text-sm tabular-nums outline-none focus:border-accent transition-colors"
				/>
			</div>
			</SettingsSection>

			<SettingsSection
				title={t("projectSettings.groupGit")}
				description={t("projectSettings.groupGitDesc")}
			>
			{/* Default Base Branch */}
			<Field title={t("projectSettings.baseBranch")} description={t("projectSettings.baseBranchDesc")}>
				<BranchPicker
					projectId={projectId}
					value={config.defaultBaseBranch ?? ""}
					onChange={(value) => update("defaultBaseBranch", value)}
					placeholder={inheritedHint("defaultBaseBranch") || "main"}
					label={t("projectSettings.baseBranch")}
					includeRemote={false}
				/>
			</Field>

			<Field title={t("projectSettings.compareRef")} description={t("projectSettings.compareRefDesc")}>
				<BranchPicker
					projectId={projectId}
					value={config.defaultCompareRef ?? ""}
					onChange={(value) => update("defaultCompareRef", value)}
					placeholder={inheritedHint("defaultCompareRef") || `origin/${config.defaultBaseBranch ?? inherited?.defaultBaseBranch ?? "main"}`}
					label={t("projectSettings.compareRef")}
					includeRemote={true}
				/>
			</Field>

			{/* Peer Review Column */}
			<div className="flex items-center justify-between gap-4">
				<div>
					<span className="block text-fg text-sm font-semibold mb-1">
						{t("projectSettings.peerReview")}
					</span>
					<p className="text-fg-3 text-sm">
						{t("projectSettings.peerReviewDesc")}
					</p>
				</div>
				<ToggleSwitch
					checked={config.peerReviewEnabled ?? true}
					ariaLabel={t("projectSettings.peerReview")}
					onToggle={() => update("peerReviewEnabled", !(config.peerReviewEnabled ?? true))}
				/>
			</div>

			{/* Automatic AI Review */}
			<div className="space-y-3">
				<div className="flex items-center justify-between gap-4">
					<div>
						<span className="block text-fg text-sm font-semibold mb-1">
							{t("projectSettings.autoReview")}
						</span>
						<p className="text-fg-3 text-sm">
							{t("projectSettings.autoReviewDesc")}
						</p>
					</div>
					<ToggleSwitch
						checked={config.autoReviewEnabled ?? false}
						ariaLabel={t("projectSettings.autoReviewEnabled")}
						onToggle={() => update("autoReviewEnabled", !(config.autoReviewEnabled ?? false))}
					/>
				</div>
				{(config.autoReviewEnabled ?? false) && <WarningNote>{t("projectSettings.autoReviewWarning")}</WarningNote>}
			</div>
			</SettingsSection>
		</div>
	);
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
	const [activeTab, setActiveTab] = useState<ConfigTab>(
		project?.kind === "virtual"
			? (initialTab === "automations" ? "automations" : "global")
			: (initialTab ?? "global"),
	);

	// ---- Project tab state (reads/writes projects.json) ----
	const projectConfigFromProject = useCallback((p: Project): ProjectConfigValues => ({
		setupScript: p.setupScript,
		setupScriptLaunchMode: p.setupScriptLaunchMode,
		devScript: p.devScript,
		cleanupScript: p.cleanupScript,
		clonePaths: p.clonePaths,
		defaultBaseBranch: p.defaultBaseBranch,
		defaultCompareRef: getEffectiveCompareRef(
			p,
			p.defaultBaseBranch,
			p.defaultCompareRef ?? `origin/${p.defaultBaseBranch}`,
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
	const [globalReviewModePrompt, setGlobalReviewModePrompt] = useState<string | undefined>(undefined);
	const inheritedReviewModePrompt = resolveReviewModePrompt(null, { reviewModePrompt: globalReviewModePrompt }, t("createTask.reviewPrompt"));

	// Load available agents
	useEffect(() => {
		api.request.getAgents().then(setAvailableAgents).catch(() => {});
		api.request.getGlobalSettings().then((s) => setGlobalReviewModePrompt(s.reviewModePrompt)).catch(() => {});
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
		() => reviewModePrompt.trim() !== initialReviewModePromptRef.current.trim(),
		[reviewModePrompt],
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
	async function handleToggleSensitive(next: boolean) {
		if (!project) return;
		try {
			const updated = await api.request.updateProjectSettings({ projectId, sensitive: next });
			dispatch({ type: "updateProject", project: updated });
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
		const parked = tasks.filter((task) => task.customColumnId === columnId).length;
		const confirmed = await confirm({
			title: t("customColumns.deleteConfirmTitle"),
			message: parked > 0
				? t.plural("customColumns.deleteConfirmMessage", parked, { name: column?.name ?? "" })
				: t("customColumns.deleteConfirmMessageEmpty", { name: column?.name ?? "" }),
			confirmLabel: t("customColumns.deleteColumn"),
			danger: true,
		});
		if (!confirmed) return;
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
			});
			dispatch({ type: "updateProject", project: updated });
			loadedProjectConfig.current = toSave;
			setProjectConfig(toSave);
			initialAiReviewRef.current = { agentId: aiReviewAgentId, configId: aiReviewConfigId, prompt: aiReviewPrompt };
			initialReviewModePromptRef.current = reviewModePrompt;
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
								className="flex items-center gap-1.5 text-fg-3 hover:text-fg-2 text-sm transition-colors -mt-1 -mb-3"
							>
								<span className="text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F0141}"}</span>
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
								<>
									<button type="button" {...tabButtonProps("project")}>
										{t("projectSettings.tabProject")}
									</button>
									<button type="button" {...tabButtonProps("worktree")}>
										{t("projectSettings.tabWorktree")}
									</button>
								</>
							)}
							<button type="button" {...tabButtonProps("automations")}>
								{t("automations.tabLabel")}
							</button>
						</div>
						<p className="text-fg-muted text-xs px-1">
							{activeTab === "global" && t("projectSettings.tabGlobalDesc")}
							{activeTab === "project" && t("projectSettings.tabProjectDesc")}
							{activeTab === "worktree" && t("projectSettings.tabWorktreeDesc")}
							{activeTab === "automations" && t("automations.tabDesc")}
						</p>
					</div>

					{/* ======== Automations tab ======== */}
					{activeTab === "automations" && (
						<div data-help-id="project-settings.automations">
							<AutomationsPanel project={project} />
						</div>
					)}

					{/* ======== Global tab ======== */}
					{activeTab === "global" && (
						<div data-help-id="project-settings.board">
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
								<AddRowButton onClick={handleAddLabel} disabled={labelSaving !== null}>
									{t("labels.addLabel")}
								</AddRowButton>
							</div>
							</SettingsSection>

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
							{configFileOverride && (
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
							</SettingsSection>
						</div>
					))}

					{/* ======== Worktree tab ======== */}
					{activeTab === "worktree" && project.kind !== "virtual" && (
						<div className="space-y-7" data-help-id="project-settings.worktree">
							{worktreeTasks.length === 0 ? (
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
								className="px-4 py-2 text-sm font-medium rounded-xl text-fg-2 outline-none hover:text-fg hover:bg-elevated focus-visible:ring-2 focus-visible:ring-accent/50 transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96]"
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
		</div>
	);
}

export default ProjectSettings;
