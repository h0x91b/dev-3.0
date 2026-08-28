import { useEffect, useState } from "react";
import type { Project } from "../../shared/types";
import { STATUS_COLORS } from "../../shared/types";
import type { ImportableConversationView } from "../../shared/conversation-import-model";
import { api } from "../rpc";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useFocusTrap } from "../utils/useFocusTrap";
import { compactAge } from "../utils/statusAge";
import { useT, statusKey } from "../i18n";
import { toast } from "../toast";
import { trackEvent } from "../analytics";
import HelpSpot from "./HelpSpot";

interface ImportConversationsModalProps {
	project: Project;
	/**
	 * The offer dev3 makes on its own after a project is added. It has to
	 * disappear without a word when there is nothing to offer — an unprompted
	 * "nothing found" is noise. Asked for from Project Settings, the same empty
	 * result is the answer to a question and stays on screen.
	 */
	autoOffer?: boolean;
	onClose: () => void;
}

/**
 * The import preview. Deliberately two-state: one ticked "Import all" is the
 * whole first screen, and the per-conversation list only appears for the user
 * who wants to argue with it.
 */
function ImportConversationsModal({ project, autoOffer, onClose }: ImportConversationsModalProps) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const [scanning, setScanning] = useState(true);
	const [conversations, setConversations] = useState<ImportableConversationView[]>([]);
	const [scanError, setScanError] = useState<string | null>(null);
	const [partial, setPartial] = useState(false);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [importing, setImporting] = useState(false);

	useEscapeKey(() => { if (!importing) onClose(); });

	useEffect(() => {
		let live = true;
		api.request.scanImportableConversations({ projectId: project.id })
			.then((result) => {
				if (!live) return;
				// The offer is spent the moment it is made, not when it is accepted —
				// declining is an answer. A scan that FAILED marks nothing, so a
				// transient error does not burn the project's single offer.
				if (autoOffer) api.request.markConversationImportOffered({ projectId: project.id }).catch(() => {});
				if (autoOffer && result.conversations.length === 0) {
					onClose();
					return;
				}
				setConversations(result.conversations);
				setSelected(new Set(result.conversations.map((c) => c.sessionId)));
			})
			.catch((err) => {
				if (!live) return;
				if (autoOffer) onClose();
				else setScanError(String(err));
			})
			.finally(() => { if (live) setScanning(false); });
		return () => { live = false; };
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [project.id]);

	async function handleImport() {
		const sessionIds = partial ? [...selected] : conversations.map((c) => c.sessionId);
		if (sessionIds.length === 0 || importing) return;
		setImporting(true);
		try {
			// Every new task arrives in the UI through the `taskUpdated` push the
			// handler sends per task — no local dispatch to keep in sync with it.
			const result = await api.request.importConversations({ projectId: project.id, sessionIds });
			trackEvent("conversations_imported", { count: result.imported, partial });
			if (result.imported > 0) {
				toast.success(t.plural("importConversations.done", result.imported, { count: result.imported }));
			}
			for (const problem of result.problems) {
				toast.error(t("importConversations.problem", { title: problem.title, error: problem.error }));
			}
			onClose();
		} catch (err) {
			toast.error(t("importConversations.failed", { error: String(err) }));
			setImporting(false);
		}
	}

	const count = partial ? selected.size : conversations.length;
	const empty = !scanning && !scanError && conversations.length === 0;

	// An unasked-for offer stays invisible until it has something to offer, so a
	// fast scan never flashes a dialog the user then watches disappear.
	if (autoOffer && scanning) return null;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onMouseDown={(e) => { if (e.target === e.currentTarget && !importing) onClose(); }}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="import-conversations-title"
				tabIndex={-1}
				data-help-id="modal.import-conversations"
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[34rem] max-h-[85vh] flex flex-col outline-none"
			>
				<div className="px-6 pt-6 pb-4 space-y-1">
					<div className="flex items-center gap-1.5">
						<h2 id="import-conversations-title" className="text-fg text-lg font-semibold">
							{t("importConversations.title")}
						</h2>
						<HelpSpot topicId="modal.import-conversations" className="w-5 h-5 text-base" />
					</div>
					<p className="text-fg-3 text-sm">
						{scanning
							? t("importConversations.scanning")
							: scanError
								? t("importConversations.scanFailed", { error: scanError })
								: empty
									? t("importConversations.empty", { name: project.name })
									: t.plural("importConversations.found", conversations.length, {
										count: conversations.length,
										name: project.name,
									})}
					</p>
				</div>

				{!scanning && !empty && !scanError && (
					<div className="px-6 pb-2 space-y-3 overflow-y-auto">
						<label className="flex items-center gap-2.5 cursor-pointer">
							<input
								type="checkbox"
								autoFocus
								checked={!partial}
								onChange={(e) => setPartial(!e.target.checked)}
								className="w-4 h-4 rounded accent-accent"
								data-testid="import-conversations-all"
							/>
							<span className="text-fg text-sm font-medium">
								{t.plural("importConversations.importAll", conversations.length, { count: conversations.length })}
							</span>
						</label>

						{!partial ? (
							<button
								type="button"
								onClick={() => setPartial(true)}
								className="text-accent hover:text-accent-emphasis text-sm transition-colors"
								data-testid="import-conversations-partial"
							>
								{t("importConversations.partial")}
							</button>
						) : (
							<>
								<div className="flex items-center gap-3">
									<button
										type="button"
										onClick={() => setSelected(new Set(conversations.map((c) => c.sessionId)))}
										className="text-fg-3 hover:text-fg text-xs transition-colors"
									>
										{t("importConversations.selectAll")}
									</button>
									<button
										type="button"
										onClick={() => setSelected(new Set())}
										className="text-fg-3 hover:text-fg text-xs transition-colors"
									>
										{t("importConversations.unselectAll")}
									</button>
								</div>
								<div
									className="max-h-[45vh] overflow-y-auto rounded-xl border border-edge divide-y divide-edge/40"
									data-testid="import-conversations-list"
								>
									{conversations.map((c) => (
										<label
											key={c.sessionId}
											className="flex items-start gap-2.5 px-3 py-2.5 hover:bg-elevated-hover transition-colors cursor-pointer"
										>
											<input
												type="checkbox"
												checked={selected.has(c.sessionId)}
												onChange={() => setSelected((cur) => {
													const next = new Set(cur);
													if (next.has(c.sessionId)) next.delete(c.sessionId);
													else next.add(c.sessionId);
													return next;
												})}
												className="w-3.5 h-3.5 mt-0.5 rounded accent-accent flex-shrink-0"
												data-testid={`import-conversation-${c.sessionId}`}
											/>
											<span className="min-w-0 flex-1">
												<span className="block text-fg text-sm truncate">{c.title}</span>
												<span className="block text-fg-muted text-xs mt-0.5">
													{t("importConversations.rowMeta", {
														age: compactAge(new Date(c.lastActivityMs).toISOString()),
														turns: String(c.turns),
													})}
												</span>
											</span>
											<span
												className="text-xs px-1.5 py-0.5 rounded-md flex-shrink-0 whitespace-nowrap"
												style={{
													color: STATUS_COLORS[c.targetStatus],
													backgroundColor: `${STATUS_COLORS[c.targetStatus]}1f`,
												}}
											>
												{t(statusKey(c.targetStatus))}
											</span>
										</label>
									))}
								</div>
							</>
						)}

						<p className="text-fg-muted text-xs leading-5">{t("importConversations.hint")}</p>
					</div>
				)}

				<div className="px-6 py-4 mt-auto border-t border-edge flex items-center justify-end gap-3">
					<button
						type="button"
						onClick={onClose}
						disabled={importing}
						className="px-4 py-1.5 text-fg-3 text-sm hover:text-fg transition-colors rounded-lg disabled:opacity-50"
					>
						{empty || scanError ? t("importConversations.close") : t("importConversations.cancel")}
					</button>
					{!empty && !scanError && (
						<button
							type="button"
							onClick={handleImport}
							disabled={scanning || importing || count === 0}
							data-testid="import-conversations-submit"
							className="px-5 py-2 bg-accent-fill text-white text-sm font-semibold rounded-xl hover:bg-accent-fill-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						>
							{importing
								? t("importConversations.importing")
								: t.plural("importConversations.submit", count, { count })}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

export default ImportConversationsModal;
