import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ExposedPort, PortInfo } from "../../../shared/types";
import { api } from "../../rpc";
import { useT } from "../../i18n";

interface TaskExposedPortsProps {
	taskId: string;
}

/**
 * Toolbar button + dropdown menu listing every dev-server port detected on
 * this task's tmux session, with per-port actions to share it publicly via a
 * Cloudflare quick tunnel, group multiple ports under one shared tunnel,
 * or copy a ready-made `ssh -L` line. State is fed live by the
 * `portsUpdated` and `exposedPortsChanged` push messages — no polling.
 *
 * The button hides itself when no ports are detected — keeps the toolbar
 * uncluttered for tasks that aren't running anything HTTP.
 */
export default function TaskExposedPorts({ taskId }: TaskExposedPortsProps) {
	const t = useT();
	const btnRef = useRef<HTMLButtonElement>(null);
	const [ports, setPorts] = useState<PortInfo[]>([]);
	const [exposed, setExposed] = useState<ExposedPort[]>([]);
	const [menuOpen, setMenuOpen] = useState(false);
	const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

	useEffect(() => {
		function onPortsUpdated(e: Event) {
			const detail = (e as CustomEvent).detail as { taskId: string; ports: PortInfo[] };
			if (detail.taskId === taskId) setPorts(detail.ports);
		}
		function onExposedChanged(e: Event) {
			const detail = (e as CustomEvent).detail as { taskId: string; ports: ExposedPort[] };
			if (detail.taskId === taskId) setExposed(detail.ports);
		}
		window.addEventListener("rpc:portsUpdated", onPortsUpdated);
		window.addEventListener("rpc:exposedPortsChanged", onExposedChanged);
		// Initial sync — covers components mounting after the last push. Wrap
		// in try/catch because `api.request` is a Proxy that synthesizes
		// methods on demand; tests that mock only a subset of RPC methods
		// will throw synchronously on access of an unstubbed name.
		try {
			Promise.resolve(api.request.listExposedPorts({ taskId }))
				.then((list) => setExposed(list))
				.catch(() => { /* server may be cold or mock-incomplete */ });
		} catch { /* RPC method missing in test mock */ }
		return () => {
			window.removeEventListener("rpc:portsUpdated", onPortsUpdated);
			window.removeEventListener("rpc:exposedPortsChanged", onExposedChanged);
		};
	}, [taskId]);

	if (ports.length === 0 && exposed.length === 0) return null;

	function openMenu() {
		if (!btnRef.current) return;
		const rect = btnRef.current.getBoundingClientRect();
		setMenuPos({ top: rect.bottom + 4, left: rect.left });
		setMenuOpen(true);
	}

	const hasActiveTunnels = exposed.length > 0;

	return (
		<>
			<button
				ref={btnRef}
				onClick={openMenu}
				className={`flex items-center gap-1 px-2 py-1 rounded-lg transition-colors flex-shrink-0 border ${
					hasActiveTunnels
						? "text-accent border-accent/40 hover:bg-accent/10"
						: "text-fg-2 border-edge hover:bg-elevated"
				}`}
				title={t("tunnel.exposedPortsSection")}
			>
				<span
					className="text-[1rem] leading-none"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{"\u{F0484}"}
				</span>
				<span className="text-[0.6875rem] font-semibold">
					{t("tunnel.portsLabel")} {hasActiveTunnels ? `(${exposed.length})` : ""}
				</span>
			</button>

			{menuOpen && createPortal(
				<ExposedPortsMenu
					taskId={taskId}
					ports={ports}
					exposed={exposed}
					position={menuPos}
					onClose={() => setMenuOpen(false)}
				/>,
				document.body,
			)}
		</>
	);
}

interface MenuProps {
	taskId: string;
	ports: PortInfo[];
	exposed: ExposedPort[];
	position: { top: number; left: number };
	onClose: () => void;
}

function ExposedPortsMenu({ taskId, ports, exposed, position, onClose }: MenuProps) {
	const t = useT();
	const menuRef = useRef<HTMLDivElement>(null);
	const [menuPos, setMenuPos] = useState(position);
	const [visible, setVisible] = useState(false);
	const [busyPort, setBusyPort] = useState<number | null>(null);
	const [toast, setToast] = useState<string | null>(null);

	useEffect(() => {
		function handleClick(event: MouseEvent) {
			if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
		}
		function handleKey(event: KeyboardEvent) {
			if (event.key === "Escape") onClose();
		}
		document.addEventListener("mousedown", handleClick);
		document.addEventListener("keydown", handleKey);
		return () => {
			document.removeEventListener("mousedown", handleClick);
			document.removeEventListener("keydown", handleKey);
		};
	}, [onClose]);

	useLayoutEffect(() => {
		if (!menuRef.current) return;
		const m = menuRef.current.getBoundingClientRect();
		const vw = window.innerWidth, vh = window.innerHeight, pad = 8;
		let top = position.top, left = position.left;
		if (top + m.height > vh - pad) top = vh - m.height - pad;
		if (left + m.width > vw - pad) left = vw - m.width - pad;
		if (left < pad) left = pad;
		if (top < pad) top = pad;
		setMenuPos({ top, left });
		setVisible(true);
	}, [position]);

	function showToast(msg: string) {
		setToast(msg);
		setTimeout(() => setToast(null), 1500);
	}

	function exposedForPort(port: number): ExposedPort | undefined {
		// "Quick" tunnels carry exactly one port. "Shared" carries many; we
		// don't surface the "shared URL for this single port" inline because
		// the shared row at the bottom is the canonical place for it.
		return exposed.find((e) => e.kind === "quick" && e.ports[0] === port);
	}

	const sharedTunnel = exposed.find((e) => e.kind === "shared");

	async function handleExpose(port: number) {
		setBusyPort(port);
		try {
			await api.request.exposePort({ taskId, port });
		} catch (err) {
			showToast(String(err));
		} finally {
			setBusyPort(null);
		}
	}

	async function handleUnexpose(port: number) {
		setBusyPort(port);
		try {
			await api.request.unexposePort({ taskId, port });
		} finally {
			setBusyPort(null);
		}
	}

	async function handleAddToShared(port: number) {
		setBusyPort(port);
		try {
			const newPorts = sharedTunnel ? Array.from(new Set([...sharedTunnel.ports, port])) : [port];
			await api.request.exposePortsShared({ taskId, ports: newPorts });
		} catch (err) {
			showToast(String(err));
		} finally {
			setBusyPort(null);
		}
	}

	async function handleCopyUrl(url: string) {
		try {
			await navigator.clipboard.writeText(url);
			showToast(t("tunnel.urlCopied"));
		} catch {/* clipboard blocked */}
	}

	async function handleCopySsh(port: number) {
		const { command } = await api.request.getSshForwardCommand({ ports: [port] });
		await navigator.clipboard.writeText(command);
		showToast(t("tunnel.sshCopied"));
	}

	async function handleStopShared() {
		try {
			await api.request.unexposeShared({ taskId });
		} catch {/* server logged it */}
	}

	return (
		<div
			ref={menuRef}
			className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1.5 min-w-[22rem] max-w-[28rem]"
			style={{ top: menuPos.top, left: menuPos.left, visibility: visible ? "visible" : "hidden" }}
			onClick={(event) => event.stopPropagation()}
		>
			<div className="px-3 py-2 text-xs text-fg-3 uppercase tracking-wider font-semibold border-b border-edge">
				{t("tunnel.exposedPortsSection")}
			</div>

			{ports.length === 0 ? (
				<div className="px-3 py-3 text-xs text-fg-muted">{t("tunnel.noPortsExposed")}</div>
			) : (
				<div className="py-1">
					{ports.map((p) => {
						const tunnel = exposedForPort(p.port);
						const isBusy = busyPort === p.port;
						return (
							<div key={p.port} className="px-3 py-2 text-sm">
								<div className="flex items-center justify-between gap-2">
									<div className="flex flex-col min-w-0">
										<span className="font-mono text-fg">:{p.port}</span>
										<span className="text-xs text-fg-3">{p.processName}</span>
									</div>
									<div className="flex items-center gap-1 flex-shrink-0">
										{tunnel ? (
											<>
												{tunnel.state === "connected" && tunnel.url && (
													<button
														onClick={() => handleCopyUrl(tunnel.url!)}
														className="px-2 py-1 rounded text-xs bg-accent/15 text-accent hover:bg-accent/25 max-w-[16rem] truncate"
														title={tunnel.url}
													>
														{tunnel.url}
													</button>
												)}
												{tunnel.state === "starting" && (
													<span className="px-2 py-1 text-xs text-fg-3">{t("tunnel.starting")}</span>
												)}
												{tunnel.state === "failed" && (
													<span className="px-2 py-1 text-xs text-danger">{t("tunnel.failed")}</span>
												)}
												<button
													onClick={() => handleUnexpose(p.port)}
													disabled={isBusy}
													className="px-2 py-1 rounded text-xs text-danger hover:bg-danger/15"
												>
													{t("tunnel.stopExposing")}
												</button>
											</>
										) : (
											<button
												onClick={() => handleExpose(p.port)}
												disabled={isBusy}
												className="px-2 py-1 rounded text-xs bg-accent hover:bg-accent-hover text-white"
											>
												{t("tunnel.exposeViaCloudflare")}
											</button>
										)}
									</div>
								</div>
								<div className="flex items-center gap-2 mt-1.5">
									<button
										onClick={() => handleAddToShared(p.port)}
										className="text-xs text-fg-3 hover:text-fg-2 underline-offset-2 hover:underline"
									>
										{t("tunnel.addToShared")}
									</button>
									<button
										onClick={() => handleCopySsh(p.port)}
										className="text-xs text-fg-3 hover:text-fg-2 underline-offset-2 hover:underline"
									>
										{t("tunnel.copySshCommand")}
									</button>
								</div>
							</div>
						);
					})}
				</div>
			)}

			{sharedTunnel && (
				<div className="border-t border-edge px-3 py-2.5 bg-base/40">
					<div className="flex items-center justify-between mb-1">
						<span className="text-xs text-fg-2 font-semibold">{t("tunnel.sharedTunnel")}</span>
						<button
							onClick={handleStopShared}
							className="text-xs text-danger hover:underline"
						>
							{t("tunnel.stopExposing")}
						</button>
					</div>
					<div className="text-xs text-fg-3 mb-1">{t("tunnel.portsLabel")}: {sharedTunnel.ports.join(", ")}</div>
					{sharedTunnel.state === "connected" && sharedTunnel.url && (
						<button
							onClick={() => handleCopyUrl(sharedTunnel.url!)}
							className="text-xs bg-accent/15 text-accent hover:bg-accent/25 px-2 py-1 rounded truncate block w-full text-left"
						>
							{sharedTunnel.url}
						</button>
					)}
					{sharedTunnel.state === "starting" && (
						<span className="text-xs text-fg-3">{t("tunnel.starting")}</span>
					)}
				</div>
			)}

			<div className="border-t border-edge px-3 py-1.5 text-[0.6875rem] text-fg-muted">
				{t("tunnel.publicWarning")}
			</div>

			{toast && (
				<div className="absolute -bottom-8 left-1/2 -translate-x-1/2 px-3 py-1 bg-accent text-white text-xs rounded shadow-lg">
					{toast}
				</div>
			)}
		</div>
	);
}
