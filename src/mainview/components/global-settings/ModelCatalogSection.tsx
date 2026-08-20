import { useCallback, useEffect, useMemo, useState } from "react";
import type { CodingAgent, ModelCatalogView, ModelSidecarStatus } from "../../../shared/types";
import {
	CATALOG_PROVIDER_KINDS,
	CUSTOM_API_FORMATS,
	isValidCatalogModelName,
	modelUsesExtendedContext,
	sidecarProviderKey,
	validateCatalog,
	type CatalogProviderKind,
	type CustomApiFormat,
} from "../../../shared/model-catalog";
import { randomUUID } from "../../uuid";
import Select, { type SelectOption } from "../Select";
import { confirm } from "../../confirm";
import { toast } from "../../toast";
import { api } from "../../rpc";
import type { TFunction } from "../../i18n";
import SettingsEntry from "./SettingsEntry";

const EMPTY: ModelCatalogView = { providers: [], models: [] };

const INPUT_CLASS =
	"w-full px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/40 transition-colors";
const BUTTON_CLASS =
	"px-2.5 py-1 rounded-lg bg-elevated border border-edge text-fg-2 text-xs hover:text-fg hover:border-edge-active transition-colors disabled:opacity-50";

const REMOVE_CLASS =
	"px-2.5 py-1 rounded-lg text-danger text-xs hover:bg-danger/10 border border-transparent hover:border-danger/30 transition-colors";
const CELL_CLASS = "align-top px-2 py-2 min-w-0";

/** What a stored key looks like before the user asks to see it. Never leaves the
 *  renderer: an edit always replaces the whole value, so this cannot be saved. */
const KEY_MASK = "••••••••••••";

/**
 * One provider's API key: masked until the user clicks the eye.
 *
 * A stored key is READ-ONLY while masked — changing a secret you cannot see is
 * how a working key gets half-overwritten, and it made "clear the field to
 * remove the key" impossible to offer. Revealing fetches that one key (nothing
 * arrives with the catalog), after which the field behaves like any other:
 * editing replaces the key, emptying it removes the key on save.
 *
 * The revealed value carries `streamer-private`, so a recording blurs it —
 * bible §10 rules identity/secret values, and this is one.
 */
function ProviderKeyField({
	t,
	provider,
	draft,
	onDraft,
}: {
	t: TFunction;
	provider: ModelCatalogView["providers"][number];
	draft: string | undefined;
	onDraft: (value: string | undefined) => void;
}) {
	const [revealed, setRevealed] = useState<string | null>(null);
	const [shown, setShown] = useState(false);

	const unlocked = !provider.hasKey || revealed !== null;
	const value = draft ?? revealed ?? (provider.hasKey ? KEY_MASK : "");
	const removing = provider.hasKey && draft === "";

	const toggle = async () => {
		if (!provider.hasKey || revealed !== null) {
			setShown(!shown);
			return;
		}
		try {
			const { key } = await api.request.modelCatalogRevealKey({ providerId: provider.id });
			setRevealed(key);
			setShown(true);
		} catch (err) {
			toast.error(t("catalog.providerKeyRevealError", { error: String(err) }), { source: "settings" });
		}
	};

	return (
		<>
			<div className="flex items-center gap-1.5">
				<input
					id={`provider-key-${provider.id}`}
					type={shown ? "text" : "password"}
					aria-label={t("catalog.providerKey")}
					value={value}
					readOnly={!unlocked}
					placeholder="sk-…"
					autoComplete="off"
					spellCheck={false}
					onChange={(event) => onDraft(event.target.value)}
					className={`${INPUT_CLASS} font-mono ${shown ? "streamer-private" : ""} ${unlocked ? "" : "cursor-default"}`}
				/>
				<button
					type="button"
					onClick={() => void toggle()}
					title={shown ? t("catalog.providerKeyHide") : t("catalog.providerKeyShow")}
					aria-label={shown ? t("catalog.providerKeyHide") : t("catalog.providerKeyShow")}
					aria-pressed={shown}
					className="shrink-0 p-1.5 rounded-lg text-fg-3 hover:text-fg hover:bg-elevated transition-colors"
				>
					<KeyEyeIcon off={shown} />
				</button>
			</div>
			<span className={`block text-xs mt-1 ${removing ? "text-danger" : "text-fg-3"}`}>
				{removing
					? t("catalog.providerKeyRemoving")
					: provider.hasKey
						? t("catalog.providerKeyStored")
						: t("catalog.providerKeyMissing")}
			</span>
		</>
	);
}

/** Open eye = "show me"; struck-through eye = "hide it again". Stroke-only, so
 *  it sits at the same weight as the row's other glyphs. */
function KeyEyeIcon({ off }: { off: boolean }) {
	return (
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
			<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" strokeLinecap="round" strokeLinejoin="round" />
			<circle cx="12" cy="12" r="2.8" />
			{off ? <path d="M4 20 20 4" strokeLinecap="round" /> : null}
		</svg>
	);
}

/** One editable table. Rows carry the controls; the header names the columns,
 *  and each control repeats that name for screen readers. */
function EditTable({
	columns,
	actionsLabel,
	children,
}: { columns: string[]; actionsLabel: string; children: React.ReactNode }) {
	return (
		<div className="overflow-x-auto rounded-xl border border-edge bg-raised">
			<table className="w-full text-sm border-collapse">
				<thead>
					<tr className="border-b border-edge">
						{columns.map((column) => (
							<th key={column} scope="col" className="text-left px-2 py-2 text-fg-2 text-xs font-semibold">
								{column}
							</th>
						))}
						<th scope="col" className="w-0 px-2 py-2">
							<span className="sr-only">{actionsLabel}</span>
						</th>
					</tr>
				</thead>
				<tbody>{children}</tbody>
			</table>
		</div>
	);
}

/** A control that is off on purpose, with the reason spelled out next to it —
 *  a greyed button that explains nothing reads as a broken app. */
function Gated({ reason, children }: { reason: string | null; children: React.ReactNode }) {
	return (
		<span className="inline-flex items-center gap-2">
			{children}
			{reason ? <span className="text-fg-3 text-xs">{reason}</span> : null}
		</span>
	);
}

function StatusRow({ tone, children }: { tone: "success" | "warning" | "danger" | "muted"; children: React.ReactNode }) {
	const dot = { success: "bg-success", warning: "bg-warning", danger: "bg-danger", muted: "bg-fg-muted" }[tone];
	return (
		<div className="flex items-center gap-2 text-sm text-fg-2">
			<span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} aria-hidden />
			<span className="min-w-0">{children}</span>
		</div>
	);
}

/**
 * The model catalog: providers dev3 may reach and the named models on top of
 * them. Credentials go in and never come back. Edits stay local until saved,
 * because saving restarts the proxy and that interrupts running sessions.
 */
export default function ModelCatalogSection({ t }: { t: TFunction }) {
	const [saved, setSaved] = useState<ModelCatalogView>(EMPTY);
	const [draft, setDraft] = useState<ModelCatalogView>(EMPTY);
	const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
	/** Bumped on every successful save, to remount the key fields: a revealed key
	 *  is local to its field, and after a save it names a key that no longer
	 *  exists (removed) or is no longer current (replaced). */
	const [savedRevision, setSavedRevision] = useState(0);
	const [status, setStatus] = useState<ModelSidecarStatus | null>(null);
	const [available, setAvailable] = useState<string[] | null>(null);
	const [listError, setListError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	/** Only to count which presets a deletion would break — never edited here. */
	const [agents, setAgents] = useState<CodingAgent[]>([]);

	const load = useCallback(async () => {
		try {
			const view = await api.request.modelCatalogGet();
			setSaved(view);
			setDraft(view);
		} catch (err) {
			toast.error(t("catalog.loadError", { error: String(err) }), { source: "settings" });
		}
	}, [t]);

	const refreshStatus = useCallback(async () => {
		try {
			setStatus(await api.request.modelSidecarStatus());
		} catch {
			/* transient — keep the last known status */
		}
	}, []);

	useEffect(() => {
		void load();
		void refreshStatus();
		void api.request.getAgents().then(setAgents).catch(() => setAgents([]));
		const timer = setInterval(() => void refreshStatus(), 4000);
		return () => clearInterval(timer);
	}, [load, refreshStatus]);

	const dirty = useMemo(
		() => JSON.stringify(draft) !== JSON.stringify(saved) || Object.keys(keyDrafts).length > 0,
		[draft, saved, keyDrafts],
	);

	const issues = useMemo(
		() => validateCatalog({ providers: draft.providers, models: draft.models }),
		[draft],
	);

	const patchProvider = (id: string, patch: Partial<ModelCatalogView["providers"][number]>) =>
		setDraft((d) => ({ ...d, providers: d.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));

	const patchModel = (id: string, patch: Partial<ModelCatalogView["models"][number]>) =>
		setDraft((d) => ({ ...d, models: d.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));

	/** Presets that would stop working if these catalog models disappeared. */
	const presetsUsing = (modelIds: string[]): number =>
		agents.reduce(
			(sum, agent) =>
				sum + agent.configurations.filter((c) => Object.values(c.modelRoles ?? {}).some((id) => modelIds.includes(id))).length,
			0,
		);

	const kindOptions: SelectOption[] = CATALOG_PROVIDER_KINDS.map((kind) => ({
		value: kind,
		label: t(`catalog.kind.${kind}` as Parameters<TFunction>[0]),
	}));

	const providerOptions: SelectOption[] = draft.providers.map((p) => ({ value: p.id, label: p.label }));

	const kindLabel = (kind: CatalogProviderKind) => t(`catalog.kind.${kind}` as Parameters<TFunction>[0]);

	const addProvider = () => {
		const kind: CatalogProviderKind = CATALOG_PROVIDER_KINDS.find(
			(k) => k !== "custom" && !draft.providers.some((p) => p.kind === k),
		) ?? "custom";
		setDraft({
			...draft,
			providers: [...draft.providers, { id: randomUUID(), kind, label: kindLabel(kind), hasKey: false }],
		});
	};

	/** Switching the kind renames the provider too, unless the user typed a name
	 *  of their own — a row reading "Anthropic" while it talks to OpenRouter is
	 *  the name every model picker then shows. */
	const changeProviderKind = (id: string, kind: CatalogProviderKind) => {
		const current = draft.providers.find((p) => p.id === id);
		const untouched = !current || CATALOG_PROVIDER_KINDS.some((k) => current.label === kindLabel(k));
		patchProvider(id, untouched ? { kind, label: kindLabel(kind) } : { kind });
	};

	const removeProvider = async (id: string) => {
		const orphans = draft.models.filter((m) => m.providerId === id);
		const presets = presetsUsing(orphans.map((m) => m.id));
		const ok = await confirm({
			title: t("catalog.removeProviderTitle"),
			message: presets > 0
				? t("catalog.removeProviderInUse", { models: String(orphans.length), presets: String(presets) })
				: orphans.length > 0
					? t("catalog.removeProviderOrphans", { count: String(orphans.length) })
					: t("catalog.removeProviderBody"),
			confirmLabel: t("catalog.removeProvider"),
			danger: true,
		});
		if (!ok) return;
		setDraft({
			providers: draft.providers.filter((p) => p.id !== id),
			models: draft.models.filter((m) => m.providerId !== id),
		});
		setKeyDrafts((prev) => {
			const next = { ...prev };
			delete next[id];
			return next;
		});
	};

	const addModel = () => {
		const providerId = draft.providers[0]?.id;
		if (!providerId) return;
		setDraft({ ...draft, models: [...draft.models, { id: randomUUID(), providerId, name: "", modelId: "" }] });
	};

	const removeModel = async (id: string) => {
		const presets = presetsUsing([id]);
		const ok = await confirm({
			title: t("catalog.removeModelTitle"),
			message: presets > 0 ? t("catalog.removeModelInUse", { presets: String(presets) }) : t("catalog.removeModelBody"),
			confirmLabel: t("catalog.removeModel"),
			danger: true,
		});
		if (!ok) return;
		setDraft({ ...draft, models: draft.models.filter((m) => m.id !== id) });
	};

	const duplicateModel = (id: string) => {
		const source = draft.models.find((m) => m.id === id);
		if (!source) return;
		// Counting up rather than always "-2": duplicating twice would otherwise
		// produce two rows with the same name, and Save refuses a duplicate name.
		const taken = new Set(draft.models.map((m) => m.name));
		let name = `${source.name}-2`;
		for (let n = 3; taken.has(name); n += 1) name = `${source.name}-${n}`;
		setDraft({ ...draft, models: [...draft.models, { ...source, id: randomUUID(), name }] });
	};

	const save = async () => {
		setBusy(true);
		try {
			const view = await api.request.modelCatalogSave({ catalog: draft, providerKeys: keyDrafts });
			setSaved(view);
			setDraft(view);
			setKeyDrafts({});
			setSavedRevision((n) => n + 1);
			toast.success(t("catalog.saved"), { source: "settings" });
			void refreshStatus();
		} catch (err) {
			toast.error(t("catalog.saveError", { error: String(err) }), { source: "settings" });
		} finally {
			setBusy(false);
		}
	};

	const startProxy = async () => {
		setBusy(true);
		setListError(null);
		try {
			setStatus(await api.request.modelSidecarStart());
		} catch (err) {
			toast.error(t("catalog.startError", { error: String(err) }), { source: "settings" });
			void refreshStatus();
		} finally {
			setBusy(false);
		}
	};

	const stopProxy = async () => {
		setBusy(true);
		try {
			setStatus(await api.request.modelSidecarStop());
			setAvailable(null);
		} finally {
			setBusy(false);
		}
	};

	/** Live model ids, so the id field is a choice rather than a guess. Only a
	 *  successful listing counts — an error must never look like "no models". */
	const loadAvailable = async () => {
		setListError(null);
		try {
			const { models } = await api.request.modelCatalogListModels({});
			setAvailable(models);
		} catch (err) {
			setAvailable(null);
			setListError(String(err));
		}
	};

	const idOptions = (providerId: string): SelectOption[] => {
		const provider = draft.providers.find((p) => p.id === providerId);
		if (!available || !provider) return [];
		const prefix = `${sidecarProviderKey(provider)}/`;
		return available
			.filter((id) => id.startsWith(prefix))
			.map((id) => ({ value: id.slice(prefix.length), label: id.slice(prefix.length) }));
	};

	// A saved provider is what the proxy can serve — a draft row is not in its
	// config yet, and naming models comes after asking the provider what it has.
	const savedProviderCount = saved.providers.length;
	const startReason = !status?.binaryAvailable
		? null // the panel already says the build ships no proxy
		: savedProviderCount === 0
			? t("catalog.startNeedsProvider")
			: null;
	const listReason = !status?.binaryAvailable ? null : !status?.running ? t("catalog.listNeedsProxy") : null;

	const proxyPanel = (
		<div className="space-y-3 rounded-xl border border-edge bg-raised p-4">
					{!status?.binaryAvailable ? (
						<StatusRow tone="danger">{t("catalog.binaryMissing")}</StatusRow>
					) : status?.running ? (
						<StatusRow tone="success">
							{t("catalog.proxyRunning", { port: String(status.port ?? "?") })} · {status.version}
						</StatusRow>
					) : status?.starting ? (
						<StatusRow tone="warning">{t("catalog.proxyStarting")}</StatusRow>
					) : (
						<StatusRow tone="muted">{t("catalog.proxyStopped")}</StatusRow>
					)}

					{status?.lastError ? (
						<pre className="text-xs text-danger whitespace-pre-wrap break-words max-h-40 overflow-auto">
							{status.lastError}
						</pre>
					) : null}

					<div className="flex flex-wrap items-center gap-3">
						{status?.running ? (
							<button type="button" onClick={stopProxy} disabled={busy} className={BUTTON_CLASS}>
								{t("catalog.stopProxy")}
							</button>
						) : (
							<Gated reason={startReason}>
								<button
									type="button"
									onClick={startProxy}
									disabled={busy || !status?.binaryAvailable || savedProviderCount === 0}
									className={BUTTON_CLASS}
								>
									{t("catalog.startProxy")}
								</button>
							</Gated>
						)}
						{/* Listing needs a running proxy. Starting one is the button above's
						    job — two buttons that both start it is how the first got called dead. */}
						<Gated reason={listReason}>
							<button
								type="button"
								onClick={loadAvailable}
								disabled={busy || !status?.binaryAvailable || !status?.running}
								className={BUTTON_CLASS}
							>
								{t("catalog.refreshModels")}
							</button>
						</Gated>
						{listError ? (
							<span className="text-xs text-warning-strong">{t("catalog.listUnavailable")}</span>
						) : available === null ? null : available.length > 0 ? (
							<span className="text-xs text-fg-3">{t("catalog.listLoaded", { count: String(available.length) })}</span>
						) : (
							<span className="text-xs text-warning-strong">{t("catalog.listEmpty")}</span>
						)}
			</div>
		</div>
	);

	return (
		<SettingsEntry anchor="model-catalog">
			<div className="space-y-6">
				{/* First run: say what to do, in order, instead of showing dead controls. */}
				{draft.providers.length === 0 && draft.models.length === 0 ? (
					<div className="rounded-xl border border-accent/30 bg-accent/10 p-4 space-y-1">
						<p className="text-fg text-sm font-semibold">{t("catalog.firstRunTitle")}</p>
						<ol className="text-fg-2 text-sm list-decimal list-inside space-y-0.5">
							<li>{t("catalog.firstRunStep1")}</li>
							<li>{t("catalog.firstRunStep2")}</li>
							<li>{t("catalog.firstRunStep3")}</li>
						</ol>
					</div>
				) : null}

				{/* Providers come first: nothing below exists without one. */}
				<div className="space-y-3">
					<p className="text-fg text-sm font-semibold">{t("catalog.providers")}</p>
					{/* The one thing a key field cannot say for itself: a subscription is
					    not a key here, and pasting one is the first thing people try. */}
					<p className="text-fg-3 text-xs leading-relaxed">{t("catalog.subscriptionNote")}</p>
					{draft.providers.length === 0 ? (
						<p className="text-fg-3 text-sm">{t("catalog.noProviders")}</p>
					) : (
						<EditTable
							columns={[t("catalog.providerKind"), t("catalog.providerLabel"), t("catalog.providerKey")]}
							actionsLabel={t("catalog.colActions")}
						>
							{draft.providers.map((provider) => (
								<tr key={provider.id} className="border-b border-edge/50 last:border-b-0">
									<td className={`${CELL_CLASS} w-48`}>
										<Select
											id={`provider-kind-${provider.id}`}
											ariaLabel={t("catalog.providerKind")}
											value={provider.kind}
											options={kindOptions}
											onChange={(value) => changeProviderKind(provider.id, value as CatalogProviderKind)}
										/>
									</td>
									<td className={CELL_CLASS}>
										<input
											id={`provider-label-${provider.id}`}
											type="text"
											aria-label={t("catalog.providerLabel")}
											value={provider.label}
											onChange={(event) => patchProvider(provider.id, { label: event.target.value })}
											className={INPUT_CLASS}
										/>
										{provider.kind === "custom" ? (
											<>
												<input
													id={`provider-url-${provider.id}`}
													type="url"
													aria-label={t("catalog.providerBaseUrl")}
													value={provider.baseUrl ?? ""}
													placeholder="https://llm.example.com/v1"
													onChange={(event) => patchProvider(provider.id, { baseUrl: event.target.value })}
													className={`${INPUT_CLASS} font-mono mt-1.5`}
												/>
												{/* Absent means OpenAI-shaped, which is what every custom
												    provider saved before this control existed. */}
												<div className="mt-1.5">
												<Select
													id={`provider-format-${provider.id}`}
													ariaLabel={t("connect.apiFormatLabel")}
													value={provider.apiFormat ?? "openai"}
													options={CUSTOM_API_FORMATS.map((format) => ({
														value: format,
														label: t(`connect.apiFormat.${format}` as Parameters<TFunction>[0]),
													}))}
													onChange={(value) => patchProvider(provider.id, { apiFormat: value as CustomApiFormat })}
												/>
												</div>
											</>
										) : null}
										<span className="block text-fg-muted text-xs font-mono mt-1 truncate">
											{sidecarProviderKey(provider)}/…
										</span>
									</td>
									<td className={`${CELL_CLASS} w-64`}>
										<ProviderKeyField
											key={`${provider.id}:${savedRevision}`}
											t={t}
											provider={provider}
											draft={keyDrafts[provider.id]}
											onDraft={(value) => {
												const next = { ...keyDrafts };
												if (value === undefined) delete next[provider.id];
												else next[provider.id] = value;
												setKeyDrafts(next);
											}}
										/>
									</td>
									<td className={`${CELL_CLASS} text-right`}>
										<button type="button" onClick={() => void removeProvider(provider.id)} className={REMOVE_CLASS}>
											{t("catalog.removeProvider")}
										</button>
									</td>
								</tr>
							))}
						</EditTable>
					)}
					<button type="button" onClick={addProvider} className={BUTTON_CLASS}>
						{t("catalog.addProvider")}
					</button>
				</div>

				{/* The proxy sits between the two tables because that is where it is used:
				    it answers what a saved provider offers, and those ids fill the models
				    below. It also answers "is it me or the proxy" when a launch fails. */}
				{proxyPanel}

				{/* Named models */}
				<div className="space-y-3">
					<p className="text-fg text-sm font-semibold">{t("catalog.models")}</p>
					{draft.models.length === 0 ? (
						<p className="text-fg-3 text-sm">{t("catalog.noModels")}</p>
					) : (
						<EditTable
							columns={[t("catalog.modelName"), t("catalog.modelProvider"), t("catalog.modelId"), t("catalog.modelWide")]}
							actionsLabel={t("catalog.colActions")}
						>
							{draft.models.map((model) => {
								const nameBad = model.name.length > 0 && !isValidCatalogModelName(model.name);
								return (
									<tr key={model.id} className="border-b border-edge/50 last:border-b-0">
										<td className={CELL_CLASS}>
											<input
												id={`model-name-${model.id}`}
												type="text"
												aria-label={t("catalog.modelName")}
												value={model.name}
												placeholder="fast-gremlin"
												onChange={(event) => patchModel(model.id, { name: event.target.value })}
												className={`${INPUT_CLASS} font-mono ${nameBad ? "border-danger/50" : ""}`}
											/>
											{nameBad ? <span className="block text-danger text-xs mt-1">{t("catalog.modelNameInvalid")}</span> : null}
										</td>
										<td className={`${CELL_CLASS} w-48`}>
											<Select
												id={`model-provider-${model.id}`}
												ariaLabel={t("catalog.modelProvider")}
												value={model.providerId}
												options={providerOptions}
												onChange={(value) => patchModel(model.id, { providerId: value })}
											/>
										</td>
										<td className={CELL_CLASS}>
											<Select
												id={`model-id-${model.id}`}
												ariaLabel={t("catalog.modelId")}
												value={model.modelId}
												options={idOptions(model.providerId)}
												allowCustom
												searchPlaceholder={t("catalog.modelIdPlaceholder")}
												searchLabel={t("catalog.modelId")}
												customOptionLabel={(query) => t("catalog.modelIdCreate", { id: query })}
												emptyLabel={t("catalog.modelIdEmpty")}
												onChange={(value) => patchModel(model.id, { modelId: value })}
											/>
											</td>
										<td className={`${CELL_CLASS} w-16 text-center`}>
											<input
												id={`model-wide-${model.id}`}
												type="checkbox"
												aria-label={t("catalog.modelWide")}
												title={t("catalog.modelWideHint")}
												checked={modelUsesExtendedContext(model)}
												onChange={(event) => patchModel(model.id, { extendedContext: event.target.checked })}
												className="h-4 w-4 accent-accent"
											/>
										</td>
										<td className={`${CELL_CLASS} text-right whitespace-nowrap`}>
											<button type="button" onClick={() => duplicateModel(model.id)} className={BUTTON_CLASS}>
												{t("catalog.duplicateModel")}
											</button>
											<button type="button" onClick={() => void removeModel(model.id)} className={`${REMOVE_CLASS} ml-1.5`}>
												{t("catalog.removeModel")}
											</button>
										</td>
									</tr>
								);
							})}
						</EditTable>
					)}
					{draft.models.length > 0 ? (
						<>
							<p className="text-fg-3 text-xs">{available ? t("catalog.modelIdTypeAnyway") : t("catalog.modelIdManual")}</p>
							<p className="text-fg-3 text-xs">{t("catalog.modelWideHint")}</p>
						</>
					) : null}
					<Gated reason={draft.providers.length === 0 ? t("catalog.addModelNeedsProvider") : null}>
						<button type="button" onClick={addModel} disabled={draft.providers.length === 0} className={BUTTON_CLASS}>
							{t("catalog.addModel")}
						</button>
					</Gated>
				</div>

				{/* Save — an edit costs a proxy restart, so it is explicit and announced. */}
				{dirty ? (
					<div className="rounded-xl border border-warning/30 bg-warning/10 p-3 space-y-2">
						<p className="text-fg-2 text-xs leading-relaxed">{t("catalog.restartWarning")}</p>
						{issues.length > 0 ? (
							<p className="text-danger text-xs">{t(`catalog.issue.${issues[0].code}` as Parameters<TFunction>[0])}</p>
						) : null}
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={save}
								disabled={busy || issues.length > 0}
								className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm hover:bg-accent-hover transition-colors disabled:opacity-50"
							>
								{t("catalog.save")}
							</button>
							<button
								type="button"
								onClick={() => {
									setDraft(saved);
									setKeyDrafts({});
								}}
								disabled={busy}
								className={BUTTON_CLASS}
							>
								{t("catalog.discard")}
							</button>
						</div>
					</div>
				) : null}
			</div>
		</SettingsEntry>
	);
}
