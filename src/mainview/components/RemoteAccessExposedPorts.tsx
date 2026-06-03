import { useEffect, useState } from "react";
import type { ExposedPort } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";

/**
 * Cross-task summary of every Cloudflare tunnel currently exposing a
 * dev-server port. Rendered inside the Remote Access modal — gives users a
 * single place to see what's public, copy URLs, and stop tunnels.
 *
 * Receives live updates via the `exposedPortsChanged` push message; falls
 * back to one initial `listExposedPorts` call on mount.
 */
export default function RemoteAccessExposedPorts() {
	const t = useT();
	const [items, setItems] = useState<ExposedPort[]>([]);
	const [toast, setToast] = useState<string | null>(null);

	useEffect(() => {
		// Wrap in try/catch — `api.request` is a Proxy; mocks may not define
		// every RPC method, throwing synchronously on access otherwise.
		const refresh = () => {
			try {
				Promise.resolve(api.request.listExposedPorts({}))
					.then(setItems)
					.catch(() => { /* fail silent */ });
			} catch { /* RPC method missing in test mock */ }
		};
		refresh();
		window.addEventListener("rpc:exposedPortsChanged", refresh);
		return () => window.removeEventListener("rpc:exposedPortsChanged", refresh);
	}, []);

	if (items.length === 0) {
		return (
			<div className="bg-base rounded-lg p-3 text-left">
				<div className="text-xs text-fg-3 uppercase tracking-wider font-semibold mb-1.5">
					{t("tunnel.exposedPortsSection")}
				</div>
				<div className="text-xs text-fg-muted">{t("tunnel.noPortsExposed")}</div>
			</div>
		);
	}

	function showToast(msg: string) {
		setToast(msg);
		setTimeout(() => setToast(null), 1500);
	}

	async function copyUrl(url: string) {
		try {
			await navigator.clipboard.writeText(url);
			showToast(t("tunnel.urlCopied"));
		} catch {/* clipboard blocked */}
	}

	async function stopItem(item: ExposedPort) {
		if (item.kind === "shared") {
			await api.request.unexposeShared({ taskId: item.taskId });
		} else {
			await api.request.unexposePort({ taskId: item.taskId, port: item.ports[0] });
		}
	}

	return (
		<div className="bg-base rounded-lg p-3 text-left relative">
			<div className="text-xs text-fg-3 uppercase tracking-wider font-semibold mb-2">
				{t("tunnel.exposedPortsSection")}
			</div>
			<div className="space-y-2">
				{items.map((item, i) => (
					<div key={`${item.taskId}-${item.kind}-${item.ports.join(",")}-${i}`} className="flex items-center justify-between gap-2 text-xs">
						<div className="flex flex-col min-w-0 flex-1">
							<div className="flex items-center gap-1.5">
								<span className="font-mono text-fg-2">
									{item.kind === "shared" ? t("tunnel.sharedTunnel") : `:${item.ports[0]}`}
								</span>
								{item.kind === "shared" && (
									<span className="text-fg-3 text-[0.6875rem]">({item.ports.join(", ")})</span>
								)}
								{item.state === "starting" && <span className="text-fg-3">— {t("tunnel.starting")}</span>}
								{item.state === "failed" && <span className="text-danger">— {t("tunnel.failed")}</span>}
							</div>
							{item.url && (
								<button
									onClick={() => copyUrl(item.url!)}
									className="text-accent hover:text-accent-hover truncate text-left mt-0.5"
									title={item.url}
								>
									{item.url}
								</button>
							)}
						</div>
						<button
							onClick={() => stopItem(item)}
							className="text-danger hover:bg-danger/10 px-2 py-1 rounded flex-shrink-0"
						>
							{t("tunnel.stopExposing")}
						</button>
					</div>
				))}
			</div>
			{toast && (
				<div className="absolute -bottom-7 left-1/2 -translate-x-1/2 px-3 py-1 bg-elevated border border-edge text-fg text-xs rounded shadow-lg whitespace-nowrap">
					{toast}
				</div>
			)}
		</div>
	);
}
