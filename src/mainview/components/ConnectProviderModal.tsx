import { useState } from "react";
import { createPortal } from "react-dom";
import { CUSTOM_API_FORMATS, uniqueCustomProviderLabel, type CatalogProviderKind, type CustomApiFormat } from "../../shared/model-catalog";
import { RECOMMENDED_MODELS, seedAgentPresets, seedCatalogModels } from "../../shared/recommended-models";
import { useT } from "../i18n";
import { api } from "../rpc";
import { toast } from "../toast";
import { randomUUID } from "../uuid";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useFocusTrap } from "../utils/useFocusTrap";
import { OPEN_SETTINGS_SECTION_EVENT } from "../state";

/**
 * One place a user can go from "I have no models of my own" to a session running
 * on somebody else's, without learning what a catalog is.
 *
 * Only OpenRouter is seeded: the curated list is OpenRouter ids, and inventing
 * ids for the others would produce presets that fail at launch. The rest create
 * the provider and hand over to the catalog settings, which is where naming a
 * model belongs anyway.
 */

interface ConnectTarget {
	id: string;
	label: string;
	kind: CatalogProviderKind;
	/** Fixed endpoint for the OpenAI-compatible services; editable for `custom`. */
	baseUrl?: string;
	needsKey: boolean;
	/** Where the user gets a key, opened in their browser. */
	keyUrl?: string;
	descKey: "connect.descOpenrouter" | "connect.descOllama" | "connect.descFireworks" | "connect.descBaseten" | "connect.descCustom";
}

const TARGETS: ConnectTarget[] = [
	{
		id: "openrouter",
		label: "OpenRouter",
		kind: "openrouter",
		needsKey: true,
		keyUrl: "https://openrouter.ai/keys",
		descKey: "connect.descOpenrouter",
	},
	{ id: "ollama", label: "Ollama", kind: "custom", baseUrl: "http://localhost:11434/v1", needsKey: false, descKey: "connect.descOllama" },
	{
		id: "fireworks",
		label: "Fireworks",
		kind: "custom",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		needsKey: true,
		keyUrl: "https://fireworks.ai/account/api-keys",
		descKey: "connect.descFireworks",
	},
	{
		id: "baseten",
		label: "Baseten",
		kind: "custom",
		baseUrl: "https://inference.baseten.co/v1",
		needsKey: true,
		keyUrl: "https://app.baseten.co/settings/api-keys",
		descKey: "connect.descBaseten",
	},
	{ id: "custom", label: "Custom", kind: "custom", needsKey: true, descKey: "connect.descCustom" },
];

/** Only this one has curated model ids behind it, so only this one can finish
 *  the job in one click. */
const SEEDED_TARGET = "openrouter";

const INPUT_CLASS =
	"w-full px-3 py-2 bg-base border border-edge rounded-lg text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/40 transition-colors";

export default function ConnectProviderModal({ onClose, onConnected }: { onClose: () => void; onConnected?: () => void }) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const [target, setTarget] = useState<ConnectTarget | null>(null);
	const [key, setKey] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	// Only asked for a hand-entered endpoint: the named services all speak one
	// known shape, and asking about it would be a question with one right answer.
	const [apiFormat, setApiFormat] = useState<CustomApiFormat>("openai");
	const [busy, setBusy] = useState(false);

	useEscapeKey(onClose);

	const seeds = target?.id === SEEDED_TARGET;
	const url = target?.baseUrl ?? baseUrl.trim();
	const ready = !!target && (!target.needsKey || key.trim().length > 0) && (target.kind !== "custom" || url.length > 0);

	async function connect() {
		if (!target || busy) return;
		setBusy(true);
		try {
			const catalog = await api.request.modelCatalogGet();
			const providerId = randomUUID();
			// Every target carries a fixed label, and a custom endpoint's label is
			// its identity on the wire — so a second Ollama box or a second
			// hand-entered endpoint would collide with the first and be refused.
			const label =
				target.kind === "custom" ? uniqueCustomProviderLabel(catalog.providers, target.label, url) : target.label;
			const withProvider = {
				providers: [
					...catalog.providers,
					{
						id: providerId,
						kind: target.kind,
						label,
						baseUrl: target.kind === "custom" ? url : undefined,
						apiFormat: target.kind === "custom" ? apiFormat : undefined,
						hasKey: false,
					},
				],
				models: catalog.models,
			};
			const next = seeds ? seedCatalogModels(withProvider, providerId, randomUUID) : withProvider;
			// The key travels in its own field and is stored by the main process;
			// it is never part of the catalog that comes back.
			const saved = await api.request.modelCatalogSave({
				catalog: next,
				providerKeys: key.trim() ? { [providerId]: key.trim() } : undefined,
			});

			if (seeds) {
				const agents = await api.request.getAgents();
				const seeded = seedAgentPresets(agents, saved, randomUUID);
				if (JSON.stringify(seeded) !== JSON.stringify(agents)) await api.request.saveAgents({ agents: seeded });
				toast.success(t("connect.connected", { provider: target.label }), { source: "settings" });
			} else {
				// Nothing to launch yet — the user still has to name the models this
				// endpoint serves, and only they know what it serves.
				toast.info(t("connect.connectedManual", { provider: target.label }), {
					source: "settings",
					// A CATEGORY id, not the `model-catalog` entry id: anything the
					// registry does not know resolves to the first category, so the
					// wrong value here lands the user on Appearance instead.
					onClick: () => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: "models" })),
				});
			}
			onConnected?.();
			onClose();
		} catch (err) {
			toast.error(t("connect.error", { error: String(err) }), { source: "settings" });
		} finally {
			setBusy(false);
		}
	}

	return createPortal(
		<div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50" onClick={onClose}>
			{/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="connect-provider-title"
				data-testid="connect-provider-modal"
				tabIndex={-1}
				className="relative bg-overlay border border-edge rounded-2xl shadow-2xl w-[38rem] max-w-[92vw] max-h-[85vh] flex flex-col outline-none"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="px-6 pt-6 pb-4 border-b border-edge">
					<h2 id="connect-provider-title" className="text-fg text-lg font-semibold">
						{t("connect.title")}
					</h2>
					<p className="text-fg-3 text-sm mt-1">{t("connect.subtitle")}</p>
				</div>

				<div className="px-6 py-4 overflow-auto flex-1 space-y-3">
					{!target ? (
						TARGETS.map((option) => (
							<button
								key={option.id}
								type="button"
								data-testid={`connect-target-${option.id}`}
								onClick={() => {
									setTarget(option);
									setBaseUrl(option.baseUrl ?? "");
								}}
								className="w-full text-left px-4 py-3 rounded-xl border border-edge bg-raised hover:border-edge-active transition-colors"
							>
								<span className="flex items-center gap-2">
									<span className="text-fg text-sm font-medium">{option.label}</span>
									{option.id === SEEDED_TARGET ? (
										<span className="text-micro uppercase tracking-wide text-accent">{t("connect.recommended")}</span>
									) : null}
								</span>
								<span className="block text-fg-3 text-xs mt-0.5">{t(option.descKey)}</span>
							</button>
						))
					) : (
						<>
							{target.kind === "custom" && !target.baseUrl ? (
								<>
									<label className="block">
										<span className="block text-fg-2 text-xs mb-1">{t("connect.baseUrlLabel")}</span>
										<input
											type="url"
											value={baseUrl}
											placeholder="https://llm.example.com/v1"
											onChange={(e) => setBaseUrl(e.target.value)}
											className={`${INPUT_CLASS} font-mono`}
										/>
									</label>
									{/* Asked only for a hand-entered endpoint. The named services
									    each speak one known shape, so the question would have one
									    right answer and no reason to be on screen. */}
									<fieldset className="block">
										<legend className="block text-fg-2 text-xs mb-1">{t("connect.apiFormatLabel")}</legend>
										<div className="flex flex-wrap gap-4">
											{CUSTOM_API_FORMATS.map((format) => (
												<label key={format} className="flex items-center gap-2 text-fg-2 text-sm">
													<input
														type="radio"
														name="connect-api-format"
														value={format}
														checked={apiFormat === format}
														onChange={() => setApiFormat(format)}
													/>
													{t(`connect.apiFormat.${format}` as Parameters<typeof t>[0])}
												</label>
											))}
										</div>
										<span className="block text-fg-3 text-xs mt-1.5">{t("connect.apiFormatHint")}</span>
									</fieldset>
								</>
							) : null}

							{target.needsKey ? (
								<label className="block">
									<span className="block text-fg-2 text-xs mb-1">{t("connect.keyLabel", { provider: target.label })}</span>
									<input
										type="password"
										autoComplete="off"
										spellCheck={false}
										value={key}
										placeholder="sk-…"
										onChange={(e) => setKey(e.target.value)}
										className={`${INPUT_CLASS} font-mono`}
									/>
									<span className="block text-fg-3 text-xs mt-1.5 leading-relaxed">{t("connect.keyHint")}</span>
									{target.keyUrl ? (
										<span className="block text-fg-muted text-xs mt-1 font-mono break-all">{target.keyUrl}</span>
									) : null}
								</label>
							) : (
								<p className="text-fg-3 text-sm">{t("connect.noKeyNeeded")}</p>
							)}

							<div className="rounded-xl border border-edge bg-raised p-3">
								<p className="text-fg-2 text-xs font-semibold mb-1.5">{t("connect.willAdd")}</p>
								{seeds ? (
									<ul className="text-fg-3 text-xs space-y-0.5">
										{RECOMMENDED_MODELS.map((model) => (
											<li key={model.modelId}>· {model.label}</li>
										))}
										<li>· {t("connect.willAddPreset")}</li>
									</ul>
								) : (
									<p className="text-fg-3 text-xs">{t("connect.willAddManual")}</p>
								)}
							</div>
						</>
					)}
				</div>

				<div className="flex items-center justify-end gap-2 px-6 pt-2 pb-6">
					<button
						type="button"
						onClick={() => (target ? setTarget(null) : onClose())}
						disabled={busy}
						className="px-4 py-2 text-sm font-medium text-fg-2 hover:text-fg bg-elevated hover:bg-elevated-hover border border-edge rounded-xl transition-colors disabled:opacity-50"
					>
						{target ? t("connect.back") : t("connect.cancel")}
					</button>
					{target ? (
						<button
							type="button"
							onClick={() => void connect()}
							disabled={!ready || busy}
							data-testid="connect-provider-submit"
							className="px-4 py-2 text-sm font-medium text-white bg-accent-fill hover:bg-accent-fill-hover rounded-xl transition-colors disabled:opacity-50"
						>
							{busy ? t("connect.connecting") : t("connect.connect")}
						</button>
					) : null}
				</div>
			</div>
		</div>,
		document.body,
	);
}
