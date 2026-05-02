import { useEffect, useState } from "react";
import { api } from "../rpc";
import { useT } from "../i18n";
import TerminalView from "../TerminalView";

interface HomeTerminalProps {
	onBack: () => void;
}

const SESSION_KEY = "home";

function HomeTerminal({ onBack }: HomeTerminalProps) {
	const t = useT();
	const [ptyUrl, setPtyUrl] = useState<string | null>(null);
	const [error, setError] = useState(false);
	const [restarting, setRestarting] = useState(false);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const url = await api.request.getHomePtyUrl({});
				if (cancelled) return;
				setPtyUrl(url);
			} catch (err) {
				if (cancelled) return;
				console.error("[HomeTerminal] getHomePtyUrl FAILED:", err);
				setError(true);
			}
		})();
		return () => { cancelled = true; };
	}, []);

	useEffect(() => {
		function onHomePtyDied() {
			setError(true);
		}
		window.addEventListener("rpc:homePtyDied", onHomePtyDied);
		return () => window.removeEventListener("rpc:homePtyDied", onHomePtyDied);
	}, []);

	async function handleRestart() {
		setRestarting(true);
		try {
			await api.request.destroyHomeTerminal({}).catch(() => {});
			const url = await api.request.getHomePtyUrl({});
			setPtyUrl(url);
			setError(false);
		} catch (err) {
			console.error("[HomeTerminal] Restart failed:", err);
			setError(true);
		} finally {
			setRestarting(false);
		}
	}

	if (error) {
		return (
			<div className="flex items-center justify-center h-full">
				<div className="bg-raised border border-edge rounded-lg p-6 max-w-md w-full space-y-4">
					<div className="flex items-center gap-2 font-medium text-fg">
						<span className="text-lg">{"⏹"}</span>
						<span>{t("homeTerminal.sessionEnded")}</span>
					</div>
					<p className="text-fg-3 text-sm">{t("homeTerminal.sessionEndedDesc")}</p>
					<div className="flex gap-3 pt-2">
						<button
							onClick={handleRestart}
							disabled={restarting}
							className="flex-1 px-4 py-2 bg-accent text-white rounded text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-50"
						>
							{restarting ? t("terminal.connecting") : t("homeTerminal.restart")}
						</button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="h-full w-full flex flex-col overflow-hidden">
			<div className="flex items-center justify-between px-4 py-1.5 border-b border-edge flex-shrink-0 bg-raised">
				<button
					onClick={onBack}
					className="flex items-center gap-1.5 text-fg-3 hover:text-fg transition-colors text-sm"
				>
					<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
					</svg>
					<span>{t("homeTerminal.back")}</span>
				</button>
				<div className="flex items-center gap-3">
					<span className="text-fg-muted text-xs truncate max-w-[20rem]">~</span>
					<kbd className="text-[0.625rem] text-fg-muted/60 font-mono px-1.5 py-0.5 rounded bg-elevated border border-edge">
						{t("homeTerminal.shortcutHint")}
					</kbd>
				</div>
			</div>
			<div className="flex-1 min-h-0 overflow-hidden">
				{ptyUrl ? (
					<TerminalView ptyUrl={ptyUrl} taskId={SESSION_KEY} projectId="" />
				) : (
					<div className="flex items-center justify-center h-full">
						<div className="flex items-center gap-3">
							<div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
							<span className="text-fg-3 text-sm">{t("terminal.connecting")}</span>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

export default HomeTerminal;
