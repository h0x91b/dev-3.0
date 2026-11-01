import { useEffect, useRef, useState } from "react";
import type { AutoHibernateSuggestion } from "../../shared/auto-hibernate";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useT } from "../i18n";
import { UNSOLICITED_DIALOG_QUIET_MS, useDialogKeyboardGuard } from "../utils/dialog-keyboard-guard";
import { useFocusTrap } from "../utils/useFocusTrap";

interface AutoHibernateSuggestionModalProps {
	suggestion: AutoHibernateSuggestion;
	onPresent: () => void;
	onHold: () => void;
	onRespond: (action: "hibernate" | "snooze", taskIds: string[]) => Promise<void>;
}

function SuggestionDialog({ suggestion, onPresent, onHold, onRespond }: AutoHibernateSuggestionModalProps) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const presentedRef = useRef(false);
	const heldRef = useRef(suggestion.held);
	const [heldLocally, setHeldLocally] = useState(false);
	const [selected, setSelected] = useState(() => new Set(suggestion.tasks.map((task) => task.taskId)));
	const [now, setNow] = useState(Date.now);
	const [pending, setPending] = useState(false);
	const pendingRef = useRef(false);
	const held = suggestion.held || heldLocally;
	const secondsLeft = Math.max(0, Math.ceil(((suggestion.autoConfirmAt ?? now) - now) / 1_000));
	const countdown = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`;
	const selectedIds = suggestion.tasks.filter((task) => selected.has(task.taskId)).map((task) => task.taskId);

	useEffect(() => {
		if (presentedRef.current) return;
		presentedRef.current = true;
		onPresent();
	}, [onPresent]);

	useEffect(() => {
		if (suggestion.held) {
			heldRef.current = true;
			setHeldLocally(true);
		}
	}, [suggestion.held]);

	useEffect(() => {
		if (held || suggestion.autoConfirmAt === null) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, [held, suggestion.autoConfirmAt]);

	function takeOver() {
		if (heldRef.current || suggestion.held) return;
		heldRef.current = true;
		setHeldLocally(true);
		onHold();
	}

	async function respond(action: "hibernate" | "snooze") {
		if (pendingRef.current || (action === "hibernate" && selectedIds.length === 0)) return;
		takeOver();
		pendingRef.current = true;
		setPending(true);
		try {
			await onRespond(action, action === "hibernate" ? selectedIds : suggestion.tasks.map((task) => task.taskId));
		} catch {
			// The host reports the error and retains the suggestion for another try.
		} finally {
			pendingRef.current = false;
			setPending(false);
		}
	}

	useEscapeKey(() => { void respond("snooze"); });
	useDialogKeyboardGuard(trapRef, {
		quietMs: UNSOLICITED_DIALOG_QUIET_MS,
		onKeyActivity: takeOver,
		onEscape: () => { void respond("snooze"); },
	});

	return (
		<div
			className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 px-4"
			onMouseDown={(event) => { if (event.target === event.currentTarget) event.preventDefault(); }}
			onPointerDownCapture={takeOver}
			onKeyDownCapture={takeOver}
			onWheelCapture={takeOver}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="auto-hibernate-suggestion-title"
				aria-describedby="auto-hibernate-suggestion-consequences"
				tabIndex={-1}
				className="bg-overlay rounded-2xl shadow-2xl shadow-black/50 w-full max-w-xl max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden outline-none"
			>
				<div className="flex-1 min-h-0 overflow-y-auto">
					<div className="px-6 pt-5 pb-4 space-y-3 shrink-0">
						<h2 id="auto-hibernate-suggestion-title" className="text-fg text-lg font-semibold">{t("autoHibernateSuggestion.title")}</h2>
						<p className="text-fg-2 text-sm leading-relaxed">{t("autoHibernateSuggestion.description")}</p>
						<div id="auto-hibernate-suggestion-consequences" className="text-sm leading-relaxed space-y-1">
							<p className="text-warning">{t("autoHibernateSuggestion.losses")}</p>
							<p className="text-fg-2">{t("autoHibernateSuggestion.preserved")}</p>
						</div>
					</div>
					<ul className="px-6 space-y-2" aria-label={t("autoHibernateSuggestion.tasks")}>
						{suggestion.tasks.map((task) => (
							<li key={task.taskId}>
								<label className="flex items-start gap-3 rounded-lg bg-raised px-3 py-3 min-h-11 cursor-pointer">
									<input
										type="checkbox"
										className="mt-1 shrink-0 accent-accent"
										checked={selected.has(task.taskId)}
										disabled={pending}
										onChange={() => {
											takeOver();
											setSelected((current) => {
												const next = new Set(current);
												if (next.has(task.taskId)) next.delete(task.taskId);
												else next.add(task.taskId);
												return next;
											});
										}}
									/>
									<span className="min-w-0 space-y-1">
										<span className="block text-fg text-sm font-medium break-words">{task.title}</span>
										<span className="flex flex-wrap gap-x-2 gap-y-0.5 text-fg-3 text-xs">
											<span className="min-w-0 break-words">{task.projectName}</span>
											<span>{t.plural("autoHibernateSuggestion.inactive", Math.max(1, Math.floor((now - task.lastActivityAt) / 60_000)))}</span>
										</span>
									</span>
								</label>
							</li>
						))}
					</ul>
				</div>
				<div className="px-6 py-4 space-y-3 shrink-0">
					<p className="text-fg-3 text-xs leading-relaxed" aria-live={held ? "polite" : "off"}>
						{held ? t("autoHibernateSuggestion.held") : suggestion.autoConfirmAt !== null ? (
							<span data-testid="auto-hibernate-countdown" className="tabular-nums">
								{t("autoHibernateSuggestion.countdown", { time: countdown })}
							</span>
						) : t("autoHibernateSuggestion.waiting")}
					</p>
					<div className="flex flex-wrap justify-end gap-2">
						<button autoFocus type="button" disabled={pending} onClick={() => { void respond("snooze"); }} className="min-h-11 px-4 py-2 rounded-lg bg-raised hover:bg-elevated text-fg text-sm disabled:opacity-50 transition-colors">
							{t("autoHibernateSuggestion.notNow")}
						</button>
						<button type="button" disabled={pending || selectedIds.length === 0} onClick={() => { void respond("hibernate"); }} className="min-h-11 px-4 py-2 rounded-lg bg-danger hover:bg-danger/80 text-white text-sm disabled:opacity-50 transition-colors">
							{t.plural("autoHibernateSuggestion.hibernate", selectedIds.length)}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

export default function AutoHibernateSuggestionModal(props: AutoHibernateSuggestionModalProps) {
	return <SuggestionDialog key={props.suggestion.id} {...props} />;
}
