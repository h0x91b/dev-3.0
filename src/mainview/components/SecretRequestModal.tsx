import { useEffect, useRef, useState } from "react";
import { SECRET_MAX_LENGTH, secretTransportAllowed, type SecretRequest } from "../../shared/secret-request";
import { api } from "../rpc";
import { useT } from "../i18n";
import { useFocusTrap } from "../utils/useFocusTrap";
import { UNSOLICITED_DIALOG_QUIET_MS, useDialogKeyboardGuard } from "../utils/dialog-keyboard-guard";

export default function SecretRequestModal({ request, onDone }: { request: SecretRequest; onDone: () => void }) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const inputRef = useRef<HTMLInputElement>(null);
	const busyRef = useRef(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	const transportAllowed = secretTransportAllowed(window.location);

	useEffect(() => {
		const input = inputRef.current;
		return () => { if (input) input.value = ""; };
	}, []);

	async function respond(approved: boolean) {
		if (busyRef.current || (approved && !transportAllowed)) return;
		const input = inputRef.current;
		if (approved && !input?.reportValidity()) return;
		busyRef.current = true;
		setBusy(true);
		setError(false);
		const params = { requestId: request.requestId, ...(approved ? { secret: input!.value } : {}) };
		if (input) input.value = "";
		try {
			await api.request.respondToSecretRequest(params);
			onDone();
		} catch {
			setError(true);
			busyRef.current = false;
			setBusy(false);
		} finally {
			delete params.secret;
		}
	}

	useDialogKeyboardGuard(trapRef, { quietMs: UNSOLICITED_DIALOG_QUIET_MS, onEscape: () => { void respond(false); } });

	return (
		<div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onMouseDown={(event) => {
			if (event.target === event.currentTarget) event.preventDefault();
		}}>
			<div ref={trapRef} role="dialog" aria-modal="true" aria-labelledby="secret-title" aria-describedby="secret-privacy"
				tabIndex={-1} className="bg-overlay rounded-2xl shadow-2xl shadow-black/50 border border-accent/40 w-full max-w-xl mx-4 max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden outline-none ph-no-capture">
				<form autoComplete="off" className="flex flex-col min-h-0" onSubmit={(event) => { event.preventDefault(); void respond(true); }}>
					<div className="p-6 space-y-4 overflow-y-auto min-h-0">
						<span className="inline-flex rounded-full px-2.5 py-1 bg-accent/15 text-accent text-xs font-medium">{t("confirmDialog.agentBadge")}</span>
						<h2 id="secret-title" className="text-lg font-semibold text-fg">{t("secret.title")}</h2>
						<p className="text-sm text-fg-2 break-words">{request.taskTitle}</p>
						<div className="space-y-1 text-sm">
							<p className="text-fg-2">{t("secret.command")}</p>
							<pre className="bg-base rounded-lg p-3 text-xs text-fg whitespace-pre-wrap break-all max-h-36 overflow-auto">{JSON.stringify(request.command, null, 2)}</pre>
						<p className="text-fg-muted text-xs break-all streamer-private">{request.cwd}</p>
						</div>
						<p id="secret-privacy" className="text-sm text-fg-2">{t("secret.privacy")}</p>
						<p className="text-sm text-fg-2">{t("secret.trust")}</p>
						<label className="block text-sm text-fg" htmlFor="secret-value">{t("secret.value", { name: request.env })}</label>
						<input ref={inputRef} id="secret-value" type="password" required maxLength={SECRET_MAX_LENGTH}
							disabled={busy || !transportAllowed} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
							data-ph-mask data-private data-lpignore="true" data-1p-ignore="true"
							className="w-full rounded-lg border border-edge bg-base px-3 py-2 text-fg outline-none focus:border-accent" />
						{!transportAllowed && <p role="alert" className="text-sm text-danger">{t("secret.insecure")}</p>}
						{error && <p role="alert" className="text-sm text-danger">{t("secret.error")}</p>}
					</div>
					<div className="flex justify-end gap-3 px-6 py-4 border-t border-edge shrink-0">
						<button type="button" autoFocus disabled={busy} onClick={() => { void respond(false); }}
							className="px-4 py-2 rounded-lg text-sm text-fg-2 hover:bg-overlay-hover active:scale-[0.96] motion-reduce:transform-none">{t("secret.decline")}</button>
						<button type="submit" disabled={busy || !transportAllowed}
							className="px-4 py-2 rounded-lg text-sm bg-accent text-white hover:bg-accent-hover disabled:opacity-50 active:scale-[0.96] motion-reduce:transform-none">{t("secret.run")}</button>
					</div>
				</form>
			</div>
		</div>
	);
}
