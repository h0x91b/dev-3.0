import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
	AgentAccount,
	AgentAccountIdentity,
	AgentAccountKind,
	AgentAccountsState,
	AgentApiProfileInfo,
	ClaudeModelSlot,
	ClaudeSlotModel,
	ClaudeSlotModels,
} from "../../../shared/agent-accounts";
import { CLAUDE_MODEL_SLOTS, shortCodexWorkspaceId } from "../../../shared/agent-accounts";
import { api } from "../../rpc";
import { confirm } from "../../confirm";
import { toast } from "../../toast";
import type { TFunction } from "../../i18n";
import { AGENT_ACCOUNTS_CHANGED_EVENT, notifyAgentAccountsChanged } from "../AgentAccountIndicator";
import Tooltip from "../Tooltip";
import SettingsSection from "./SettingsSection";

/** Small "(i)" info glyph with a two-tier tooltip (label headline + detail),
 *  matching the Tooltip style used across the app. */
function FieldHint({ label, body }: { label: string; body: string }) {
	return (
		<Tooltip content={label} detail={body}>
			<span
				tabIndex={0}
				role="img"
				aria-label={body}
				className="text-fg-muted hover:text-fg-2 cursor-help text-[0.7rem] leading-none shrink-0 outline-none focus-visible:text-accent"
				style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
			>
				{""}
			</span>
		</Tooltip>
	);
}

/** Field caption + its (i) hint on one line. */
function HintLabel({ text, body }: { text: string; body: string }) {
	return (
		<span className="flex items-center gap-1 text-fg-3 text-xs">
			{text}
			<FieldHint label={text} body={body} />
		</span>
	);
}

interface AddFlow {
	kind: AgentAccountKind;
	accountId: string | null;
	loginCommand: string;
	verifying: boolean;
}

function IdentityBadges({
	identity,
	hideEmail,
	kind,
	t,
}: {
	identity: AgentAccountIdentity | null;
	hideEmail?: string;
	kind: AgentAccountKind;
	t: TFunction;
}) {
	if (!identity) return null;
	const workspaceId = kind === "codex" ? shortCodexWorkspaceId(identity) : null;
	return (
		<>
			{identity.email && identity.email !== hideEmail ? (
				<span className="text-fg-3 text-xs font-mono truncate">{identity.email}</span>
			) : null}
			{identity.organization ? (
				<span className="text-fg-muted text-xs truncate">{identity.organization}</span>
			) : null}
			{workspaceId ? (
				<span className="text-fg-3 text-[0.6875rem] font-mono px-1.5 py-0.5 bg-raised rounded shrink-0">
					{t("settings.accountsWorkspace", { id: workspaceId })}
				</span>
			) : null}
			{identity.planLabel ? (
				<span className="text-accent text-xs px-1.5 py-0.5 bg-accent/10 rounded shrink-0">
					{identity.planLabel}
				</span>
			) : null}
		</>
	);
}

function apiBadgeHost(baseUrl: string | null): string | null {
	if (!baseUrl) return null;
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}

/** Account-row badges for an API profile: just the API chip + endpoint host.
 *  The per-slot model overrides are intentionally NOT shown here — they are long
 *  and belong in the edit form, not the compact row. */
function ApiProfileBadges({ api }: { api: AgentApiProfileInfo }) {
	const host = apiBadgeHost(api.baseUrl);
	return (
		<>
			<span className="text-warning text-xs px-1.5 py-0.5 bg-warning/10 rounded shrink-0">API</span>
			{host ? <span className="text-fg-3 text-xs font-mono truncate">{host}</span> : null}
		</>
	);
}

function AccountRow({
	kind,
	label,
	identity,
	api,
	isActive,
	onActivate,
	onRename,
	onEditApi,
	onRemove,
	t,
}: {
	kind: AgentAccountKind;
	label: string;
	identity: AgentAccountIdentity | null;
	api?: AgentApiProfileInfo | null;
	isActive: boolean;
	onActivate?: () => void;
	onRename?: (label: string) => void;
	/** API profiles edit the whole form instead of an inline label rename. */
	onEditApi?: () => void;
	onRemove?: () => void;
	t: TFunction;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(label);

	function commitRename() {
		setEditing(false);
		const trimmed = draft.trim();
		if (trimmed && trimmed !== label) onRename?.(trimmed);
		else setDraft(label);
	}

	return (
		<div
			className={`flex flex-wrap items-center gap-2.5 px-3 py-2 bg-elevated border rounded-lg transition-colors ${
				isActive ? "border-accent/50" : "border-edge"
			} ${onActivate && !isActive ? "cursor-pointer hover:bg-elevated-hover" : ""}`}
			role={onActivate ? "button" : undefined}
			tabIndex={onActivate ? 0 : undefined}
			onClick={onActivate}
			onKeyDown={(event) => {
				if (onActivate && (event.key === "Enter" || event.key === " ")) {
					event.preventDefault();
					onActivate();
				}
			}}
		>
			<span
				aria-hidden
				className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${
					isActive ? "border-accent bg-accent" : "border-fg-muted/50"
				}`}
			/>
			<div className="basis-40 min-w-0 flex-1 flex flex-wrap items-center gap-2">
				{editing ? (
					<input
						type="text"
						value={draft}
						autoFocus
						onChange={(event) => setDraft(event.target.value)}
						onClick={(event) => event.stopPropagation()}
						onBlur={commitRename}
						onKeyDown={(event) => {
							event.stopPropagation();
							if (event.key === "Enter") commitRename();
							if (event.key === "Escape") {
								setDraft(label);
								setEditing(false);
							}
						}}
						className="flex-none w-48 max-w-full px-2 py-0.5 bg-base border border-edge rounded text-fg text-sm outline-none focus:border-accent/40"
					/>
				) : (
					<span className="text-fg text-sm font-medium truncate">{label}</span>
				)}
				{api ? (
					<ApiProfileBadges api={api} />
				) : (
					<IdentityBadges identity={identity} hideEmail={label} kind={kind} t={t} />
				)}
			</div>
			<div className="ml-auto flex items-center justify-end gap-1 shrink-0">
				{isActive ? (
					<span className="text-success text-xs px-1.5 py-0.5 bg-success/15 rounded shrink-0">
						{t("settings.accountsActive")}
					</span>
				) : null}
				{onEditApi ? (
					<button
						type="button"
						onClick={(event) => {
							event.stopPropagation();
							onEditApi();
						}}
						className="p-1 rounded text-fg-muted hover:text-fg hover:bg-raised-hover transition-colors shrink-0"
						title={t("settings.accountsEditApi")}
						aria-label={t("settings.accountsEditApi")}
					>
						<span className="text-[0.75rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
							{"\uf044"}
						</span>
					</button>
				) : onRename && !editing ? (
					<button
						type="button"
						onClick={(event) => {
							event.stopPropagation();
							setDraft(label);
							setEditing(true);
						}}
						className="p-1 rounded text-fg-muted hover:text-fg hover:bg-raised-hover transition-colors shrink-0"
						title={t("settings.accountsRename")}
						aria-label={t("settings.accountsRename")}
					>
						<span className="text-[0.75rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
							{"\uf044"}
						</span>
					</button>
				) : null}
				{onRemove ? (
					<button
						type="button"
						onClick={(event) => {
							event.stopPropagation();
							onRemove();
						}}
						className="text-danger text-xs hover:bg-danger/10 px-1.5 py-0.5 rounded transition-colors shrink-0"
					>
						{t("settings.accountsRemove")}
					</button>
				) : null}
			</div>
		</div>
	);
}

function LoginFlowCard({
	flow,
	onVerify,
	onCancel,
	t,
}: {
	flow: AddFlow;
	onVerify: () => void;
	onCancel: () => void;
	t: TFunction;
}) {
	const [copied, setCopied] = useState(false);

	return (
		<div className="bg-base border border-accent/30 rounded-lg p-3 space-y-2.5">
			<p className="text-fg-2 text-xs">{t("settings.accountsLoginHint")}</p>
			<div className="flex items-center gap-1.5">
				<code className="flex-1 bg-elevated border border-edge rounded px-2 py-1.5 text-xs font-mono text-fg overflow-x-auto whitespace-nowrap">
					{flow.loginCommand}
				</code>
				<button
					type="button"
					onClick={() => {
						navigator.clipboard.writeText(flow.loginCommand);
						setCopied(true);
						setTimeout(() => setCopied(false), 2000);
					}}
					className="px-2.5 py-1.5 rounded bg-elevated border border-edge text-fg-2 text-xs hover:bg-elevated-hover transition-colors shrink-0"
				>
					{copied ? t("settings.accountsCopied") : t("settings.accountsCopy")}
				</button>
			</div>
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={onVerify}
					disabled={flow.verifying}
					className="px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors"
				>
					{flow.verifying ? t("settings.accountsVerifying") : t("settings.accountsVerify")}
				</button>
				<button
					type="button"
					onClick={onCancel}
					disabled={flow.verifying}
					className="px-3 py-1.5 rounded-lg text-fg-3 text-xs hover:text-fg hover:bg-elevated transition-colors disabled:opacity-50"
				>
					{t("settings.accountsCancelAdd")}
				</button>
			</div>
		</div>
	);
}

interface ApiSlotDraft {
	id: string;
	name: string;
	description: string;
}

interface ApiFormDraft {
	label: string;
	baseUrl: string;
	apiKey: string;
	/** Master override: one model id for every slot (disables the per-slot boxes). */
	model: string;
	slots: Record<ClaudeModelSlot, ApiSlotDraft>;
	envText: string;
}

const SLOT_LABELS: Record<ClaudeModelSlot, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable" };
const SLOT_DEFAULT_DESCRIPTION: Record<ClaudeModelSlot, string> = {
	opus: "Override Opus",
	sonnet: "Override Sonnet",
	haiku: "Override Haiku",
	fable: "Override Fable",
};
/** Example provider slugs shown as placeholders — a big model for Opus/Sonnet,
 *  a cheap/fast one for Haiku/Fable — so the "provider/model" format is obvious. */
const SLOT_ID_PLACEHOLDER: Record<ClaudeModelSlot, string> = {
	opus: "z-ai/glm-5.2",
	sonnet: "deepseek/deepseek-v4-pro",
	haiku: "deepseek/deepseek-v4-flash",
	fable: "z-ai/glm-5.2",
};

/** Display name derived from a model id: the part after the last "/"
 *  (`deepseek/deepseek-v4-flash` → `deepseek-v4-flash`). */
function lastModelSegment(id: string): string {
	return id.trim().split("/").pop()?.trim() ?? "";
}

function emptySlots(): Record<ClaudeModelSlot, ApiSlotDraft> {
	const slots = {} as Record<ClaudeModelSlot, ApiSlotDraft>;
	for (const slot of CLAUDE_MODEL_SLOTS) {
		slots[slot] = { id: "", name: "", description: SLOT_DEFAULT_DESCRIPTION[slot] };
	}
	return slots;
}

function slotsFromModels(models: ClaudeSlotModels): Record<ClaudeModelSlot, ApiSlotDraft> {
	const slots = emptySlots();
	for (const slot of CLAUDE_MODEL_SLOTS) {
		const m = models[slot];
		if (m) slots[slot] = { id: m.id, name: m.name ?? "", description: m.description ?? SLOT_DEFAULT_DESCRIPTION[slot] };
	}
	return slots;
}

/** Only slots with a non-empty id become overrides; name/description are optional. */
function slotsToPayload(slots: Record<ClaudeModelSlot, ApiSlotDraft>): ClaudeSlotModels {
	const out: ClaudeSlotModels = {};
	for (const slot of CLAUDE_MODEL_SLOTS) {
		const id = slots[slot].id.trim();
		if (!id) continue;
		const entry: ClaudeSlotModel = { id };
		if (slots[slot].name.trim()) entry.name = slots[slot].name.trim();
		if (slots[slot].description.trim()) entry.description = slots[slot].description.trim();
		out[slot] = entry;
	}
	return out;
}

const EMPTY_API_FORM: ApiFormDraft = { label: "", baseUrl: "", apiKey: "", model: "", slots: emptySlots(), envText: "" };

const API_INPUT_CLASS =
	"w-full px-2 py-1.5 bg-elevated border border-edge rounded text-fg text-xs font-mono outline-none focus:border-accent/40 placeholder:text-fg-muted/60 disabled:opacity-50";

function SlotOverrideCard({
	slot,
	draft,
	disabled,
	onChange,
	t,
}: {
	slot: ClaudeModelSlot;
	draft: ApiSlotDraft;
	disabled: boolean;
	onChange: (draft: ApiSlotDraft) => void;
	t: TFunction;
}) {
	return (
		<div className={`bg-elevated/40 border border-edge rounded-lg p-2 space-y-1.5 ${disabled ? "opacity-50" : ""}`}>
			<span className="flex items-center gap-1 text-fg-2 text-xs font-semibold">
				{SLOT_LABELS[slot]}
				<FieldHint label={SLOT_LABELS[slot]} body={t("settings.accountsApiSlotIdHint")} />
			</span>
			<input
				type="text"
				value={draft.id}
				placeholder={SLOT_ID_PLACEHOLDER[slot]}
				disabled={disabled}
				onChange={(event) => {
					const id = event.target.value;
					// Auto-fill the display name from the id's last "/" segment, but stop
					// once the user has typed a custom name (name diverged from the derived one).
					const following = !draft.name || draft.name === lastModelSegment(draft.id);
					onChange({ ...draft, id, name: following ? lastModelSegment(id) : draft.name });
				}}
				className={API_INPUT_CLASS}
			/>
			<div className="grid grid-cols-2 gap-1.5">
				<input
					type="text"
					value={draft.name}
					placeholder={lastModelSegment(SLOT_ID_PLACEHOLDER[slot])}
					disabled={disabled}
					onChange={(event) => onChange({ ...draft, name: event.target.value })}
					className={API_INPUT_CLASS}
				/>
				<input
					type="text"
					value={draft.description}
					placeholder={t("settings.accountsApiSlotDescription")}
					disabled={disabled}
					onChange={(event) => onChange({ ...draft, description: event.target.value })}
					className={API_INPUT_CLASS}
				/>
			</div>
		</div>
	);
}

function ApiProfileFormCard({
	draft,
	saving,
	editing,
	onChange,
	onSave,
	onCancel,
	t,
}: {
	draft: ApiFormDraft;
	saving: boolean;
	/** true when editing an existing profile (vs. creating a new one). */
	editing: boolean;
	onChange: (draft: ApiFormDraft) => void;
	onSave: () => void;
	onCancel: () => void;
	t: TFunction;
}) {
	const [showKey, setShowKey] = useState(false);
	const canSave = !saving && !!(draft.baseUrl.trim() || draft.apiKey.trim() || draft.envText.trim());
	const masterActive = !!draft.model.trim();

	function field(label: string, key: "label" | "baseUrl", placeholder: string, hintBody: string) {
		return (
			<label className="block space-y-1">
				<HintLabel text={label} body={hintBody} />
				<input
					type="text"
					value={draft[key]}
					placeholder={placeholder}
					onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
					className={API_INPUT_CLASS}
				/>
			</label>
		);
	}

	return (
		<div className="bg-base border border-accent/30 rounded-lg p-3 space-y-2.5">
			<p className="text-fg-2 text-xs">{t("settings.accountsApiHint")}</p>
			{field(t("settings.accountsApiLabel"), "label", "OpenRouter", t("settings.accountsApiLabelHint"))}
			{field(t("settings.accountsApiBaseUrl"), "baseUrl", "https://openrouter.ai/api", t("settings.accountsApiBaseUrlHint"))}
			<label className="block space-y-1">
				<HintLabel text={t("settings.accountsApiKey")} body={t("settings.accountsApiKeyHintDetail")} />
				<div className="relative">
					<input
						type={showKey ? "text" : "password"}
						value={draft.apiKey}
						placeholder="sk-ant-…"
						onChange={(event) => onChange({ ...draft, apiKey: event.target.value })}
						className={`${API_INPUT_CLASS} pr-9`}
					/>
					<button
						type="button"
						onClick={() => setShowKey((v) => !v)}
						className="absolute inset-y-0 right-0 flex items-center px-2.5 text-fg-muted hover:text-fg transition-colors"
						title={showKey ? t("settings.accountsApiKeyHide") : t("settings.accountsApiKeyShow")}
						aria-label={showKey ? t("settings.accountsApiKeyHide") : t("settings.accountsApiKeyShow")}
					>
						<span className="text-[0.85rem] leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
							{showKey ? "" : ""}
						</span>
					</button>
				</div>
			</label>
			<label className="block space-y-1">
				<HintLabel text={t("settings.accountsApiModelMaster")} body={t("settings.accountsApiModelMasterHint")} />
				<input
					type="text"
					value={draft.model}
					placeholder="z-ai/glm-5.2"
					onChange={(event) => onChange({ ...draft, model: event.target.value })}
					className={API_INPUT_CLASS}
				/>
			</label>
			<div className="space-y-1.5">
				<HintLabel
					text={masterActive ? t("settings.accountsApiSlotsDisabled") : t("settings.accountsApiSlotsTitle")}
					body={t("settings.accountsApiSlotsHint")}
				/>
				<div className="grid grid-cols-2 gap-1.5">
					{CLAUDE_MODEL_SLOTS.map((slot) => (
						<SlotOverrideCard
							key={slot}
							slot={slot}
							draft={draft.slots[slot]}
							disabled={masterActive}
							onChange={(slotDraft) => onChange({ ...draft, slots: { ...draft.slots, [slot]: slotDraft } })}
							t={t}
						/>
					))}
				</div>
			</div>
			<label className="block space-y-1">
				<HintLabel text={t("settings.accountsApiEnv")} body={t("settings.accountsApiEnvHint")} />
				<textarea
					value={draft.envText}
					placeholder={"CLAUDE_CODE_USE_BEDROCK=1\nAWS_REGION=us-east-1"}
					rows={3}
					onChange={(event) => onChange({ ...draft, envText: event.target.value })}
					className={`${API_INPUT_CLASS} resize-y`}
				/>
			</label>
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={onSave}
					disabled={!canSave}
					className="px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors"
				>
					{editing ? t("settings.accountsApiSave") : t("settings.accountsApiCreate")}
				</button>
				<button
					type="button"
					onClick={onCancel}
					disabled={saving}
					className="px-3 py-1.5 rounded-lg text-fg-3 text-xs hover:text-fg hover:bg-elevated transition-colors disabled:opacity-50"
				>
					{t("settings.accountsCancelAdd")}
				</button>
			</div>
		</div>
	);
}

export default function AgentAccountsSection({ t }: { t: TFunction }) {
	const [state, setState] = useState<AgentAccountsState | null>(null);
	const [addFlow, setAddFlow] = useState<AddFlow | null>(null);
	const [apiForm, setApiForm] = useState<ApiFormDraft | null>(null);
	// null → the form creates a new profile; set → it edits this existing one.
	const [apiEdit, setApiEdit] = useState<{ id: string } | null>(null);
	const [apiSaving, setApiSaving] = useState(false);
	const [busy, setBusy] = useState(false);

	const reload = useCallback(() => {
		api.request.listAgentAccounts().then(setState).catch(() => {});
	}, []);

	useEffect(() => {
		reload();
		// Stay in sync with switches made from the launch picker's account popover
		// (AgentAccountIndicator) while this section is on screen.
		window.addEventListener(AGENT_ACCOUNTS_CHANGED_EVENT, reload);
		return () => window.removeEventListener(AGENT_ACCOUNTS_CHANGED_EVENT, reload);
	}, [reload]);

	const run = useCallback(
		async (action: () => Promise<unknown>) => {
			setBusy(true);
			try {
				await action();
			} catch (err) {
				toast.error(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
				reload();
				notifyAgentAccountsChanged();
			}
		},
		[reload],
	);

	const handleImport = useCallback(
		(kind: AgentAccountKind) => run(() => api.request.importAgentAccount({ kind })),
		[run],
	);

	const handleStartAdd = useCallback(
		(kind: AgentAccountKind) =>
			run(async () => {
				const prepared = await api.request.prepareAgentAccountLogin({ kind });
				setAddFlow({ kind, accountId: prepared.accountId, loginCommand: prepared.loginCommand, verifying: false });
			}),
		[run],
	);

	const handleVerify = useCallback(async () => {
		if (!addFlow) return;
		setAddFlow({ ...addFlow, verifying: true });
		try {
			await api.request.completeAgentAccountLogin({ kind: addFlow.kind, accountId: addFlow.accountId });
			setAddFlow(null);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
			setAddFlow((current) => (current ? { ...current, verifying: false } : current));
		} finally {
			reload();
			notifyAgentAccountsChanged();
		}
	}, [addFlow, reload]);

	const handleCancelAdd = useCallback(() => {
		if (!addFlow) return;
		// A prepared-but-unverified login dir (Claude CLAUDE_CONFIG_DIR or Codex
		// CODEX_HOME) is an orphan — clean it up. Both flows now hand back an
		// accountId for the scaffolded dir.
		if (addFlow.accountId) {
			api.request.removeAgentAccount({ kind: addFlow.kind, accountId: addFlow.accountId }).catch(() => {});
		}
		setAddFlow(null);
	}, [addFlow]);

	const handleStartEditApi = useCallback(
		(account: AgentAccount) =>
			run(async () => {
				const draft = await api.request.getAgentApiProfileDraft({ kind: "claude", accountId: account.id });
				setApiForm({
					label: draft.label,
					baseUrl: draft.baseUrl,
					apiKey: draft.apiKey,
					model: draft.model,
					slots: slotsFromModels(draft.slotModels),
					envText: draft.envText,
				});
				setApiEdit({ id: account.id });
			}),
		[run],
	);

	const closeApiForm = useCallback(() => {
		setApiForm(null);
		setApiEdit(null);
	}, []);

	const handleSaveApiProfile = useCallback(async () => {
		if (!apiForm) return;
		setApiSaving(true);
		try {
			if (apiEdit) {
				await api.request.updateAgentApiProfile({
					kind: "claude",
					accountId: apiEdit.id,
					label: apiForm.label.trim() || undefined,
					// undefined clears baseUrl/model; the key field is prefilled, so it is
					// sent as-is (unchanged unless the user edited it; empty clears it).
					baseUrl: apiForm.baseUrl.trim() || undefined,
					apiKey: apiForm.apiKey,
					model: apiForm.model.trim() || undefined,
					slotModels: slotsToPayload(apiForm.slots),
					// Always sent so clearing the textarea clears the env (full replacement).
					envText: apiForm.envText,
				});
			} else {
				await api.request.addAgentApiProfile({
					kind: "claude",
					label: apiForm.label.trim() || undefined,
					baseUrl: apiForm.baseUrl.trim() || undefined,
					apiKey: apiForm.apiKey.trim() || undefined,
					model: apiForm.model.trim() || undefined,
					slotModels: slotsToPayload(apiForm.slots),
					envText: apiForm.envText.trim() || undefined,
				});
			}
			closeApiForm();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setApiSaving(false);
			reload();
			notifyAgentAccountsChanged();
		}
	}, [apiForm, apiEdit, closeApiForm, reload]);

	const handleSetActive = useCallback(
		(kind: AgentAccountKind, accountId: string | null) => {
			// Setting the DEFAULT account only changes the preselect for future
			// launches — it no longer swaps ~/.codex/auth.json or moves any running
			// session's cost, so no confirmation is needed (per-launch is the guard).
			run(() => api.request.setActiveAgentAccount({ kind, accountId }));
		},
		[run],
	);

	const handleRemove = useCallback(
		async (kind: AgentAccountKind, account: AgentAccount) => {
			const ok = await confirm({
				title: t("settings.accountsRemoveConfirmTitle"),
				message: t("settings.accountsRemoveConfirmMessage", { label: account.label }),
				danger: true,
			});
			if (!ok) return;
			run(() => api.request.removeAgentAccount({ kind, accountId: account.id }));
		},
		[run, t],
	);

	const handleRename = useCallback(
		(kind: AgentAccountKind, accountId: string, label: string) =>
			run(() => api.request.renameAgentAccount({ kind, accountId, label })),
		[run],
	);

	function renderAgentBlock(
		kind: AgentAccountKind,
		title: string,
		accounts: AgentAccount[],
		activeId: string | null,
		extraRows: ReactNode,
		emptyHint: ReactNode,
	) {
		return (
			<div className="bg-raised border border-edge rounded-xl p-4 space-y-2.5">
				<div className="flex items-center gap-2">
					<span className="text-fg text-sm font-semibold flex-1">{title}</span>
					<button
						type="button"
						onClick={() => handleImport(kind)}
						disabled={busy}
						className="px-2.5 py-1 text-accent text-xs font-medium hover:bg-accent/10 rounded-lg transition-colors disabled:opacity-50"
					>
						{t("settings.accountsImportCurrent")}
					</button>
					<button
						type="button"
						onClick={() => handleStartAdd(kind)}
						disabled={busy || addFlow !== null || apiForm !== null}
						className="px-2.5 py-1 text-accent text-xs font-medium hover:bg-accent/10 rounded-lg transition-colors disabled:opacity-50"
					>
						+ {t("settings.accountsAdd")}
					</button>
					{kind === "claude" ? (
						<button
							type="button"
							onClick={() => setApiForm(EMPTY_API_FORM)}
							disabled={busy || addFlow !== null || apiForm !== null}
							className="px-2.5 py-1 text-accent text-xs font-medium hover:bg-accent/10 rounded-lg transition-colors disabled:opacity-50"
						>
							+ {t("settings.accountsAddApi")}
						</button>
					) : null}
				</div>
				<div className="space-y-1.5">
					{extraRows}
					{accounts.map((account) => (
						<AccountRow
							key={account.id}
							kind={kind}
							label={account.label}
							identity={account.identity}
							api={account.api}
							isActive={account.id === activeId}
							onActivate={account.id === activeId ? undefined : () => handleSetActive(kind, account.id)}
							onRename={account.auth === "api" ? undefined : (label) => handleRename(kind, account.id, label)}
							onEditApi={account.auth === "api" ? () => handleStartEditApi(account) : undefined}
							onRemove={() => handleRemove(kind, account)}
							t={t}
						/>
					))}
					{accounts.length === 0 && !extraRows && !emptyHint ? (
						<p className="text-fg-muted text-xs">{t("settings.accountsNoneYet")}</p>
					) : null}
					{emptyHint}
				</div>
				{addFlow?.kind === kind ? (
					<LoginFlowCard flow={addFlow} onVerify={handleVerify} onCancel={handleCancelAdd} t={t} />
				) : null}
				{kind === "claude" && apiForm ? (
					<ApiProfileFormCard
						draft={apiForm}
						saving={apiSaving}
						editing={apiEdit !== null}
						onChange={setApiForm}
						onSave={handleSaveApiProfile}
						onCancel={closeApiForm}
						t={t}
					/>
				) : null}
			</div>
		);
	}

	if (!state) {
		return (
			<SettingsSection
				title={t("settings.agentAccounts")}
				description={t("settings.agentAccountsDesc")}
			>
				<p className="text-fg-muted text-xs">…</p>
			</SettingsSection>
		);
	}

	const codexUnmanaged =
		state.codex.currentIdentity && state.codex.activeId === null ? state.codex.currentIdentity : null;

	return (
		<SettingsSection
			title={t("settings.agentAccounts")}
			description={t("settings.agentAccountsDesc")}
		>
			{renderAgentBlock(
				"claude",
				"Claude Code",
				state.claude.accounts,
				state.claude.activeId,
				<AccountRow
					kind="claude"
					label={t("settings.accountsSystemLogin")}
					identity={state.claude.systemIdentity}
					isActive={state.claude.activeId === null}
					onActivate={
						state.claude.activeId === null
							? undefined
							: () => handleSetActive("claude", null)
					}
					t={t}
				/>,
				null,
			)}
			{renderAgentBlock(
				"codex",
				"Codex",
				state.codex.accounts,
				state.codex.activeId,
				null,
				codexUnmanaged ? (
					<div className="flex flex-wrap items-center gap-2.5 px-3 py-2 bg-elevated/50 border border-edge border-dashed rounded-lg">
						<span aria-hidden className="w-3.5 h-3.5 rounded-full border-2 border-warning/60 shrink-0" />
						<div className="basis-40 min-w-0 flex-1 flex flex-wrap items-center gap-2">
							<span className="text-fg-2 text-sm whitespace-nowrap">{t("settings.accountsUnmanaged")}</span>
							<IdentityBadges identity={codexUnmanaged} kind="codex" t={t} />
						</div>
						<span className="ml-auto text-fg-muted text-xs">{t("settings.accountsUnmanagedHint")}</span>
					</div>
				) : null,
			)}
			<p className="text-fg-muted text-xs">{t("settings.accountsNewSessionsHint")}</p>
		</SettingsSection>
	);
}
