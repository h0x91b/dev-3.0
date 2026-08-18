import { useState } from "react";
import { createPortal } from "react-dom";
import { modelRolesForAgent } from "../../shared/model-catalog";
import {
	applyPresetUpdates,
	catalogForCurrentRevision,
	markRevisionSeen,
	pendingPresetUpdates,
	type PresetUpdate,
} from "../../shared/recommended-models";
import { useT } from "../i18n";
import { api } from "../rpc";
import { toast } from "../toast";
import { randomUUID } from "../uuid";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useFocusTrap } from "../utils/useFocusTrap";

/**
 * "The recommended set moved on — here is what would change."
 *
 * dev3 never rewrites a seeded preset on its own: the models behind it decide
 * what a session costs and how well it works, and the user is the one paying.
 * So both sides are on screen, per role, and the write happens on a click.
 *
 * Declining is a real answer, not a postponement — it stamps the same revision,
 * so this exact question is asked once.
 */
export default function RecommendedUpdateModal({
	updates,
	agentCommands,
	onClose,
	onApplied,
}: {
	/** What to show. The write recomputes its own — see `answer`. */
	updates: PresetUpdate[];
	/** Agent id → base command, so a role can be shown under its own CLI's name
	 *  for that role rather than as a raw id. */
	agentCommands: Record<string, string>;
	onClose: () => void;
	onApplied: () => void;
}) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const [busy, setBusy] = useState(false);
	useEscapeKey(onClose);

	function roleLabel(agentId: string, roleId: string): string {
		const role = modelRolesForAgent(agentCommands[agentId] ?? "").find((item) => item.id === roleId);
		return role ? t(role.labelKey as Parameters<typeof t>[0]) : roleId;
	}

	async function answer(accept: boolean) {
		if (busy) return;
		setBusy(true);
		try {
			// Re-read rather than patch what this modal was opened with: settings may
			// have been edited in another window while it sat open.
			const agents = await api.request.getAgents();
			// The catalog matters even more than the agents do. `modelCatalogSave`
			// REPLACES the catalog and forgets the keys of providers missing from what
			// it is handed, so writing the snapshot this modal rendered from would
			// delete a provider added since — and its stored API key with it.
			let next = markRevisionSeen(agents, updates);
			if (accept) {
				const catalog = catalogForCurrentRevision(await api.request.modelCatalogGet(), randomUUID);
				if (!catalog) throw new Error(t("recommendedUpdate.noProvider"));
				await api.request.modelCatalogSave({ catalog });
				// Recomputed for the same reason: a binding points at a catalog model
				// id, and the ids in this modal's snapshot were invented for a catalog
				// that is now stale. Stamped either way, so a preset another window
				// already updated still stops asking.
				next = applyPresetUpdates(next, pendingPresetUpdates(agents, catalog, randomUUID));
			}
			await api.request.saveAgents({ agents: next });
			if (accept) toast.success(t("recommendedUpdate.applied"), { source: "settings" });
			onApplied();
			onClose();
		} catch (err) {
			toast.error(t("recommendedUpdate.error", { error: String(err) }), { source: "settings" });
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
				aria-labelledby="recommended-update-title"
				data-testid="recommended-update-modal"
				tabIndex={-1}
				className="relative bg-overlay border border-edge rounded-2xl shadow-2xl w-[34rem] max-w-[92vw] max-h-[85vh] flex flex-col outline-none"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="px-6 pt-6 pb-4 border-b border-edge">
					<h2 id="recommended-update-title" className="text-fg text-lg font-semibold">
						{t("recommendedUpdate.title")}
					</h2>
					<p className="text-fg-3 text-sm mt-1">{t("recommendedUpdate.subtitle")}</p>
				</div>

				<div className="px-6 py-4 overflow-auto flex-1 space-y-4">
					{updates.map((update) => (
						<div
							key={update.configId}
							data-testid={`recommended-update-tier-${update.tierId}`}
							className="rounded-xl border border-edge bg-raised p-3"
						>
							<p className="text-fg-2 text-xs font-semibold mb-2">
								{update.agentName} · {update.presetName}
								{update.newPreset ? (
									<span className="text-accent font-normal ml-2">{t("recommendedUpdate.newPreset")}</span>
								) : null}
							</p>
							<ul className="space-y-1">
								{update.changes.map((change) => (
									<li key={change.roleId} className="flex items-baseline gap-2 text-xs">
										<span className="text-fg-3 w-24 shrink-0 truncate">
											{roleLabel(update.agentId, change.roleId)}
										</span>
										<span className="text-fg-muted font-mono truncate">
											{change.from ?? t("recommendedUpdate.unbound")}
										</span>
										<span className="text-fg-muted shrink-0">&rarr;</span>
										<span className="text-fg font-mono truncate">{change.to}</span>
									</li>
								))}
							</ul>
						</div>
					))}
					<p className="text-fg-3 text-xs">{t("recommendedUpdate.keepHint")}</p>
				</div>

				<div className="flex items-center justify-end gap-2 px-6 pt-2 pb-6">
					<button
						type="button"
						onClick={() => void answer(false)}
						disabled={busy}
						data-testid="recommended-update-keep"
						className="px-4 py-2 text-sm font-medium text-fg-2 hover:text-fg bg-elevated hover:bg-elevated-hover border border-edge rounded-xl transition-colors disabled:opacity-50"
					>
						{t("recommendedUpdate.keep")}
					</button>
					<button
						type="button"
						onClick={() => void answer(true)}
						disabled={busy}
						data-testid="recommended-update-apply"
						className="px-4 py-2 text-sm font-medium text-white bg-accent-fill hover:bg-accent-fill-hover rounded-xl transition-colors disabled:opacity-50"
					>
						{busy ? t("recommendedUpdate.applying") : t("recommendedUpdate.apply")}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
