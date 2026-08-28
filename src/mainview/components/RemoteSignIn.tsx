import { useRef, useState } from "react";
import { useT } from "../i18n";
import { submitRemoteAccessCode } from "../rpc";

/**
 * The browser's sign-in screen: shown whenever the remote transport has no
 * usable session (expired cookie, a QR token already consumed, or a URL opened
 * with no credential at all).
 *
 * The static access code is typed HERE and never travels in the URL, so it stays
 * out of browser history, the address bar and any proxy log. The field is always
 * offered — asking the host whether a code is configured would tell an
 * unauthenticated visitor something they have no business knowing.
 */
export default function RemoteSignIn({ onSignedIn }: { onSignedIn: () => void }) {
	const t = useT();
	const [code, setCode] = useState("");
	const [status, setStatus] = useState<"idle" | "submitting" | "rejected" | "network">("idle");
	const inputRef = useRef<HTMLInputElement>(null);

	async function handleSubmit(event: React.FormEvent) {
		event.preventDefault();
		const trimmed = code.trim();
		if (!trimmed || status === "submitting") return;
		setStatus("submitting");
		const outcome = await submitRemoteAccessCode(trimmed);
		if (outcome === "ok") {
			onSignedIn();
			return;
		}
		setStatus(outcome === "rejected" ? "rejected" : "network");
		inputRef.current?.focus();
	}

	const error = status === "rejected" ? t("remote.signInRejected")
		: status === "network" ? t("remote.signInNetworkError")
		: null;

	return (
		<div className="h-full w-full flex items-center justify-center bg-base">
			<div className="bg-raised border border-edge rounded-lg p-6 max-w-sm w-full space-y-4 text-center">
				<div className="text-3xl">{"🔒"}</div>
				<h2 className="text-fg text-lg font-semibold">{t("remote.authFailed")}</h2>
				<p className="text-fg-3 text-sm">{t("remote.authFailedDesc")}</p>

				<form onSubmit={handleSubmit} className="space-y-2 text-left">
					<label htmlFor="remote-access-code" className="block text-fg-2 text-xs">
						{t("remote.signInCodeLabel")}
					</label>
					<input
						id="remote-access-code"
						data-testid="remote-access-code"
						ref={inputRef}
						type="password"
						autoComplete="current-password"
						autoFocus
						value={code}
						onChange={(event) => {
							setCode(event.target.value);
							if (status !== "submitting") setStatus("idle");
						}}
						aria-invalid={error !== null}
						aria-describedby={error ? "remote-access-code-error" : undefined}
						className="w-full px-4 py-3 bg-base border border-edge rounded-xl text-fg text-sm font-mono outline-none focus:border-accent/40 transition-colors"
					/>
					{error ? (
						<p id="remote-access-code-error" data-testid="remote-access-code-error" className="text-danger text-xs" role="alert">
							{error}
						</p>
					) : null}
					<button
						type="submit"
						disabled={!code.trim() || status === "submitting"}
						className="w-full px-4 py-2 text-sm rounded-lg bg-accent-fill text-white hover:bg-accent-fill-hover transition-[background-color,transform] active:scale-[0.96] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
					>
						{t(status === "submitting" ? "remote.signInSubmitting" : "remote.signInSubmit")}
					</button>
				</form>
			</div>
		</div>
	);
}
