import { Component, type ErrorInfo, type ReactNode } from "react";
import { getDiagnostics, formatDiagnosticsForCopy, recordDiagnostic } from "../diagnostics";
import { api } from "../rpc";

interface Props {
	children: ReactNode;
}

interface State {
	error: Error | null;
	componentStack: string | null;
	copied: boolean;
}

/**
 * Top-level React error boundary. Mounted OUTSIDE the i18n/theme providers in
 * `main.tsx` so it survives a crash in a provider itself — which is exactly the
 * case that leaves remote/mobile users staring at a blank unmounted tree with no
 * console to inspect.
 *
 * The fallback is deliberately self-contained: no `useT()`, no context, English
 * copy only (a documented i18n exception for this emergency surface — the
 * translation provider may be the thing that threw). It records the crash into
 * the diagnostics store and best-effort logs it to the backend file, then shows
 * the message, a copyable dump of recent diagnostics, and Reload / Copy actions.
 */
export class RootErrorBoundary extends Component<Props, State> {
	state: State = { error: null, componentStack: null, copied: false };

	static getDerivedStateFromError(error: Error): Partial<State> {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		const componentStack = info.componentStack ?? null;
		this.setState({ componentStack });
		recordDiagnostic({
			kind: "react",
			level: "error",
			message: error.message || String(error),
			detail: [error.stack, componentStack].filter(Boolean).join("\n\n") || undefined,
			source: "react-render",
		});
		// Best-effort backend log (works in desktop; no-op/timeout-safe in remote).
		try {
			api.request
				.logRendererError({
					description: `React render crash: ${error.message || String(error)}`,
					source: "error",
				})
				.catch(() => {});
		} catch {
			/* api may be unavailable — the in-UI diagnostics already captured it */
		}
	}

	private handleReload = (): void => {
		try {
			window.location.reload();
		} catch {
			/* no window (tests) */
		}
	};

	private handleCopy = async (): Promise<void> => {
		const text = this.buildCopyText();
		try {
			await navigator.clipboard.writeText(text);
			this.setState({ copied: true });
			setTimeout(() => this.setState({ copied: false }), 2000);
		} catch {
			// Clipboard blocked (insecure LAN context / permissions) — fall back to a
			// hidden textarea + execCommand so copy still works on a plain-http phone.
			try {
				const ta = document.createElement("textarea");
				ta.value = text;
				ta.style.position = "fixed";
				ta.style.opacity = "0";
				document.body.appendChild(ta);
				ta.select();
				document.execCommand("copy");
				document.body.removeChild(ta);
				this.setState({ copied: true });
				setTimeout(() => this.setState({ copied: false }), 2000);
			} catch {
				/* nothing more we can do; the text is still visible on screen */
			}
		}
	};

	private buildCopyText(): string {
		const { error, componentStack } = this.state;
		const parts = [
			`dev-3.0 crash report`,
			`when: ${new Date().toISOString()}`,
			`ua: ${typeof navigator !== "undefined" ? navigator.userAgent : "unknown"}`,
			``,
			`error: ${error?.message ?? "unknown"}`,
			error?.stack ? `\nstack:\n${error.stack}` : "",
			componentStack ? `\ncomponent stack:${componentStack}` : "",
			``,
			`--- diagnostics ---`,
			formatDiagnosticsForCopy(),
		];
		return parts.filter((p) => p !== undefined).join("\n");
	}

	render(): ReactNode {
		const { error, copied } = this.state;
		if (!error) return this.props.children;

		// Recent diagnostics (newest first), excluding nothing — the crash itself is
		// in here too, plus any RPC/rejection noise that preceded it.
		const recent = getDiagnostics().slice().reverse().slice(0, 8);

		return (
			<div
				role="alert"
				className="fixed inset-0 z-[100] overflow-auto bg-base text-fg flex items-start sm:items-center justify-center p-4"
				// Inline fallbacks so the surface is legible even if the token
				// stylesheet failed to apply (dark, neutral defaults).
				style={{ backgroundColor: "var(--color-base, #0b0e14)", color: "var(--color-fg, #e6e6e6)" }}
			>
				<div className="w-full max-w-lg my-auto bg-raised border border-edge rounded-2xl shadow-2xl p-6 space-y-4">
					<div className="flex items-center gap-3">
						<span
							className="text-danger text-3xl leading-none flex-shrink-0"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
						>
						{"\uf071"}
						</span>
						<div>
							<h1 className="text-fg text-lg font-semibold">Something went wrong</h1>
							<p className="text-fg-3 text-sm">
								dev-3.0 hit an unexpected error and stopped rendering.
							</p>
						</div>
					</div>

					<div className="rounded-xl bg-elevated border border-edge px-3 py-2.5 max-h-40 overflow-auto">
						<div className="text-danger text-xs font-mono break-words whitespace-pre-wrap">
							{error.message || String(error)}
						</div>
					</div>

					{recent.length > 0 && (
						<details className="rounded-xl bg-elevated border border-edge px-3 py-2.5">
							<summary className="text-fg-2 text-sm cursor-pointer select-none">
								Recent diagnostics ({recent.length})
							</summary>
							<ul className="mt-2 space-y-2">
								{recent.map((e) => (
									<li key={e.id} className="text-xs font-mono break-words">
										<span className={e.level === "error" ? "text-danger" : "text-fg-3"}>
											{e.kind}
											{e.count > 1 ? ` ×${e.count}` : ""}:
										</span>{" "}
										<span className="text-fg-2 whitespace-pre-wrap">{e.message}</span>
									</li>
								))}
							</ul>
						</details>
					)}

					<div className="flex flex-wrap justify-end gap-2 pt-1">
						<button
							type="button"
							onClick={this.handleCopy}
							className="px-4 py-2 text-sm rounded-lg text-fg-2 border border-edge hover:text-fg hover:bg-elevated transition-colors"
						>
							{copied ? "Copied" : "Copy details"}
						</button>
						<button
							type="button"
							onClick={this.handleReload}
							className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
						>
							Reload app
						</button>
					</div>
				</div>
			</div>
		);
	}
}

export default RootErrorBoundary;
