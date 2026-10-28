import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isAgentDirAccountKind, type AccountLoginState } from "../../../shared/agent-accounts";
import { api, isElectrobun } from "../../rpc";
import type { TFunction } from "../../i18n";
import TerminalView, { type TerminalHandle } from "../../TerminalView";
import { DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME } from "../../terminal-themes";
import { useFocusTrap } from "../../utils/useFocusTrap";

const AGENT_NAMES = { claude: "Claude Code", codex: "Codex", omp: "Oh My Pi", pi: "Pi" } as const;

const RUNNING_HINTS = {
	claude: "settings.accountLoginRunningClaude",
	codex: "settings.accountLoginRunningCodex",
	omp: "settings.accountLoginRunningOmp",
	pi: "settings.accountLoginRunningPi",
} as const;

const PRESS = "transition-[opacity,color,background-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96]";

type Tone = "progress" | "success" | "warning" | "danger";

function StatusIcon({ tone }: { tone: Tone }) {
	if (tone === "progress") {
		return (
			<span aria-hidden className="relative mt-1 flex h-2.5 w-2.5 shrink-0">
				<span className="absolute inset-0 rounded-full bg-accent/40 motion-safe:animate-ping" />
				<span className="relative h-2.5 w-2.5 rounded-full bg-accent" />
			</span>
		);
	}
	const path =
		tone === "success"
			? "M5 12.5l4.5 4.5L19 7.5"
			: tone === "warning"
				? "M12 8v5m0 3.5h.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"
				: "M12 8v5m0 3.5h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z";
	const color = tone === "success" ? "text-success" : tone === "warning" ? "text-warning-strong" : "text-danger";
	return (
		<svg aria-hidden className={`mt-px h-4 w-4 shrink-0 ${color}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
			<path d={path} />
		</svg>
	);
}

/** The status headline for a phase; the Settings row reuses it so both say the same thing. */
export function loginPhaseTitle(login: AccountLoginState, remote: boolean, t: TFunction): string {
	switch (login.phase) {
		case "running":
			return t("settings.accountLoginRunning");
		case "verifying":
			return t("settings.accountLoginVerifying");
		case "succeeded":
			return t("settings.accountLoginSucceeded", { label: login.account?.label ?? AGENT_NAMES[login.kind] });
		case "exited":
			return t("settings.accountLoginExited");
		case "missing-executable":
			return t(remote ? "settings.accountLoginMissingRemote" : "settings.accountLoginMissing", { command: login.executable });
		case "failed":
			return t("settings.accountLoginFailed");
		case "expired":
			return t("settings.accountLoginExpired");
	}
}

function toneOf(phase: AccountLoginState["phase"]): Tone {
	if (phase === "succeeded") return "success";
	if (phase === "failed") return "danger";
	if (phase === "exited" || phase === "missing-executable" || phase === "expired") return "warning";
	return "progress";
}

/** Copyable fallback for a host where the embedded terminal cannot help. */
function ManualCommand({ command, t }: { command: string; t: TFunction }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 2000);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<div className="space-y-1.5" data-testid="account-login-manual">
			<p className="text-fg-3 text-xs">{t("settings.accountLoginManualHint")}</p>
			<div className="flex items-center gap-1.5">
				<code data-wheel-x className="streamer-private flex-1 min-w-0 bg-elevated border border-edge rounded-lg px-2.5 py-1.5 text-xs font-mono text-fg overflow-x-auto whitespace-nowrap">
					{command}
				</code>
				<button
					type="button"
					onClick={() => {
						void navigator.clipboard.writeText(command).then(() => setCopied(true)).catch(() => {});
					}}
					className={`px-2.5 py-1.5 rounded-lg bg-elevated border border-edge text-fg-2 text-xs hover:bg-elevated-hover shrink-0 ${PRESS}`}
				>
					{copied ? t("settings.accountsCopied") : t("settings.accountsCopy")}
				</button>
			</div>
		</div>
	);
}

interface AccountLoginModalProps {
	login: AccountLoginState;
	/** Retry/cancel in flight — buttons lock so a double click cannot race two logins. */
	busy: boolean;
	onHide: () => void;
	onCancel: () => void;
	onRetry: () => void;
	onDone: () => void;
	t: TFunction;
}

/**
 * The provider's own sign-in, running live on the dev3 host. The modal is only a
 * view: hiding it leaves the login running, and its state comes from the host.
 * Escape is NOT bound to close — the CLI inside uses it.
 */
export default function AccountLoginModal({ login, busy, onHide, onCancel, onRetry, onDone, t }: AccountLoginModalProps) {
	const trapRef = useFocusTrap<HTMLDivElement>();
	const [ptyUrl, setPtyUrl] = useState<string | null>(null);
	const [handle, setHandle] = useState<TerminalHandle | null>(null);
	const hideRef = useRef<HTMLButtonElement>(null);
	const footerRef = useRef<HTMLDivElement>(null);

	/** The terminal would swallow Tab as a keystroke and trap keyboard users; the login CLIs never need it. */
	function leaveTerminalOnTab(e: KeyboardEvent<HTMLDivElement>) {
		if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
		e.preventDefault();
		e.stopPropagation();
		if (e.shiftKey) hideRef.current?.focus();
		else footerRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
	}
	const agent = AGENT_NAMES[login.kind];
	const remote = !isElectrobun;

	useEffect(() => {
		setPtyUrl(null);
		if (!login.sessionKey) return;
		let cancelled = false;
		api.request.getAccountLoginPtyUrl({ sessionKey: login.sessionKey })
			.then((url) => { if (!cancelled) setPtyUrl(url); })
			.catch(() => {});
		return () => { cancelled = true; };
	}, [login.sessionKey]);

	useEffect(() => {
		if (handle && login.phase === "running") handle.focus();
	}, [handle, login.phase]);

	const tone = toneOf(login.phase);
	const where = remote ? t("settings.accountLoginWhereRemote") : t("settings.accountLoginWhereLocal");
	const title = loginPhaseTitle(login, remote, t);
	let body: ReactNode = null;
	switch (login.phase) {
		case "running":
			body = login.deviceAuth
				? t("settings.accountLoginRunningDevice")
				: isAgentDirAccountKind(login.kind)
					// The in-harness provider picker is the hard part, so it is explained in remote mode too.
					? [t(RUNNING_HINTS[login.kind]), remote ? t("settings.accountLoginRunningRemote") : null].filter(Boolean).join(" ")
					: remote
						? t("settings.accountLoginRunningRemote")
						: t(RUNNING_HINTS[login.kind]);
			break;
		case "succeeded":
			body = t("settings.accountLoginSucceededBody");
			break;
		case "exited":
			body = t("settings.accountLoginExitedBody");
			break;
		case "missing-executable":
			body = t("settings.accountLoginMissingBody");
			break;
		case "failed":
			body = login.error;
			break;
		case "expired":
			body = t("settings.accountLoginExpiredBody");
			break;
	}

	const active = login.phase === "running" || login.phase === "verifying" || login.phase === "exited" || login.phase === "missing-executable";
	const canRetry = login.phase === "exited" || login.phase === "missing-executable" || login.phase === "failed" || login.phase === "expired";
	const showManual = login.phase === "missing-executable" || login.phase === "exited";
	const showTerminal = login.sessionKey !== null && login.phase !== "expired";

	return createPortal(
		<div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" data-testid="account-login-modal">
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="account-login-title"
				aria-describedby="account-login-status"
				tabIndex={-1}
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[50rem] max-w-full max-h-full flex flex-col outline-none"
			>
				<div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4">
					<div className="min-w-0">
						<h2 id="account-login-title" className="text-fg text-base font-semibold text-balance">
							{t("settings.accountLoginTitle", { agent })}
						</h2>
						<p className="text-fg-3 text-xs mt-0.5">{where}</p>
					</div>
					<button
						ref={hideRef}
						type="button"
						onClick={onHide}
						title={active ? t("settings.accountLoginHideHint") : undefined}
						aria-label={active ? t("settings.accountLoginHide") : t("settings.accountLoginClose")}
						className={`text-fg-muted hover:text-fg p-1.5 -mr-1.5 rounded-lg hover:bg-fg/5 shrink-0 ${PRESS}`}
						data-testid="account-login-hide"
					>
						<svg aria-hidden className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
							{active ? <path d="M6 12h12" /> : <path d="M6 18 18 6M6 6l12 12" />}
						</svg>
					</button>
				</div>

				<div className="px-6 space-y-3 overflow-y-auto min-h-0">
					<div
						id="account-login-status"
						role="status"
						aria-live="polite"
						data-testid="account-login-status"
						data-phase={login.phase}
						className={`flex items-start gap-2.5 rounded-xl px-3.5 py-3 ${
							tone === "success" ? "bg-success/10" : tone === "danger" ? "bg-danger/10" : tone === "warning" ? "bg-warning/10" : "bg-accent/10"
						}`}
					>
						<StatusIcon tone={tone} />
						<div className="min-w-0 space-y-0.5">
							{/* Only these phases print a login label (an email) — keep the rest readable when streaming. */}
							<p className={`text-fg text-sm font-medium${login.phase === "succeeded" ? " streamer-private" : ""}`}>{title}</p>
							{body ? <p className={`text-fg-2 text-xs text-pretty break-words${login.phase === "failed" ? " streamer-private" : ""}`}>{body}</p> : null}
							{login.pending && (login.phase === "running" || login.phase === "exited") ? (
								<p className="text-warning-strong text-xs text-pretty" data-testid="account-login-pending">
									{t(login.pending === "status-unavailable" ? "settings.accountLoginPendingUnavailable" : "settings.accountLoginPendingMismatch")}
								</p>
							) : null}
							{login.phase === "missing-executable" && login.installUrl ? (
								<p className="text-fg-3 text-xs">
									{t("settings.accountLoginInstallGuide")}{" "}
									<a href={login.installUrl} target="_blank" rel="noreferrer" className="text-accent hover:text-accent-emphasis underline underline-offset-2 break-all">
										{login.installUrl}
									</a>
								</p>
							) : null}
						</div>
					</div>

					{showTerminal ? (
						<div
							// The CLI prints the account email, OAuth links and device codes: private when streaming.
							className="streamer-private relative h-[22rem] max-h-[50vh] rounded-xl overflow-hidden border border-edge p-2"
							// Same ground as the canvas TerminalView paints, so the inset reads as the terminal's own margin.
							style={{ background: document.documentElement.dataset.theme === "light" ? LIGHT_TERMINAL_THEME.background : DARK_TERMINAL_THEME.background }}
							data-testid="account-login-terminal"
							onKeyDownCapture={leaveTerminalOnTab}
						>
							{ptyUrl ? (
								<TerminalView ptyUrl={ptyUrl} taskId={login.sessionKey!} projectId="" onReady={setHandle} />
							) : (
								<div className="flex h-full items-center justify-center text-fg-3 text-sm">{t("terminal.connecting")}</div>
							)}
						</div>
					) : null}

					{showManual ? <ManualCommand command={login.manualCommand} t={t} /> : null}
				</div>

				<div ref={footerRef} className="flex flex-wrap items-center justify-end gap-2 px-6 pt-4 pb-5">
					{active || canRetry ? (
						<button
							type="button"
							onClick={onCancel}
							disabled={busy}
							data-testid="account-login-cancel"
							className={`px-3.5 py-2 rounded-xl text-sm text-fg-2 hover:text-fg hover:bg-overlay-hover disabled:opacity-50 ${PRESS}`}
						>
							{t(active ? "settings.accountLoginCancel" : "settings.accountLoginClose")}
						</button>
					) : null}
					{canRetry ? (
						<button
							type="button"
							onClick={onRetry}
							disabled={busy}
							data-testid="account-login-retry"
							className={`px-3.5 py-2 rounded-xl bg-accent-fill text-white text-sm font-medium hover:bg-accent-fill-hover disabled:opacity-50 ${PRESS}`}
						>
							{t("settings.accountLoginRetry")}
						</button>
					) : null}
					{login.phase === "succeeded" ? (
						<button
							type="button"
							onClick={onDone}
							autoFocus
							data-testid="account-login-done"
							className={`px-4 py-2 rounded-xl bg-accent-fill text-white text-sm font-medium hover:bg-accent-fill-hover ${PRESS}`}
						>
							{t("settings.accountLoginDone")}
						</button>
					) : null}
				</div>
			</div>
		</div>,
		document.body,
	);
}
