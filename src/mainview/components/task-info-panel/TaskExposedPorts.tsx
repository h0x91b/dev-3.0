import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ExposedPort, Task } from "../../../shared/types";
import { api } from "../../rpc";
import { useT } from "../../i18n";
import { useTaskAllocatedPorts } from "./useTaskAllocatedPorts";

interface TaskExposedPortsProps {
	task: Task;
}

/**
 * Toolbar button + dropdown menu for the task's allocated dev-server ports
 * (`$DEV3_PORT0..N` slots from `project.portCount`). Each slot can be shared
 * publicly via a Cloudflare quick tunnel with one click.
 *
 * Source-of-ports: the project's pre-allocated pool. We deliberately do NOT
 * use port-scan detection — that picked up our own `cloudflared` /
 * `dev3-server` processes, drowning the user in irrelevant rows.
 *
 * Lives in the Runtime & access bar (row 2 right) per UX bible §5.1.
 * Hidden when the project doesn't allocate any ports.
 */
export default function TaskExposedPorts({ task }: TaskExposedPortsProps) {
	const t = useT();
	const allocatedPorts = useTaskAllocatedPorts(task);
	const btnRef = useRef<HTMLButtonElement>(null);
	const [exposed, setExposed] = useState<ExposedPort[]>([]);
	const [menuOpen, setMenuOpen] = useState(false);
	const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

	useEffect(() => {
		function onExposedChanged(e: Event) {
			const detail = (e as CustomEvent).detail as { taskId: string; ports: ExposedPort[] };
			if (detail.taskId === task.id) setExposed(detail.ports);
		}
		window.addEventListener("rpc:exposedPortsChanged", onExposedChanged);
		try {
			Promise.resolve(api.request.listExposedPorts({ taskId: task.id }))
				.then((list) => setExposed(list))
				.catch(() => { /* server may be cold / mock-incomplete */ });
		} catch { /* RPC method missing in test mock */ }
		return () => {
			window.removeEventListener("rpc:exposedPortsChanged", onExposedChanged);
		};
	}, [task.id]);

	// No allocated ports = nothing to expose. Honor §5.1 budget by not adding
	// a useless control to the Runtime & access bar in projects that don't
	// allocate any slots.
	if (allocatedPorts.length === 0) return null;

	function openMenu() {
		if (!btnRef.current) return;
		const rect = btnRef.current.getBoundingClientRect();
		setMenuPos({ top: rect.bottom + 4, left: rect.left });
		setMenuOpen(true);
	}

	const activeCount = exposed.length;

	return (
		<>
			<button
				ref={btnRef}
				onClick={openMenu}
				className={`flex items-center gap-1 px-2 py-1 rounded-lg transition-colors flex-shrink-0 ${
					activeCount > 0
						? "text-accent bg-accent/10 hover:bg-accent/20"
						: "text-fg-3 hover:text-fg hover:bg-elevated"
				}`}
				title={t("tunnel.exposedPortsSection")}
			>
				<svg className="w-[1.125rem] h-[1.125rem]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
						d="M4 7h11.5a3.5 3.5 0 010 7H8.5a3.5 3.5 0 100 7H20" />
				</svg>
				<span className="text-[0.6875rem] font-semibold">
					{activeCount > 0 ? `${t("tunnel.portsLabel")} (${activeCount})` : t("tunnel.portsLabel")}
				</span>
			</button>

			{menuOpen && createPortal(
				<ExposedPortsMenu
					taskId={task.id}
					allocatedPorts={allocatedPorts}
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
	allocatedPorts: number[];
	exposed: ExposedPort[];
	position: { top: number; left: number };
	onClose: () => void;
}

function ExposedPortsMenu({ taskId, allocatedPorts, exposed, position, onClose }: MenuProps) {
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

	function quickFor(port: number): ExposedPort | undefined {
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
			const merged = sharedTunnel ? Array.from(new Set([...sharedTunnel.ports, port])) : [port];
			await api.request.exposePortsShared({ taskId, ports: merged });
		} catch (err) {
			showToast(String(err));
		} finally {
			setBusyPort(null);
		}
	}

	async function copyUrl(url: string) {
		try {
			await navigator.clipboard.writeText(url);
			showToast(t("tunnel.urlCopied"));
		} catch {/* clipboard blocked */}
	}

	async function copySsh(port: number) {
		const { command } = await api.request.getSshForwardCommand({ ports: [port] });
		await navigator.clipboard.writeText(command);
		showToast(t("tunnel.sshCopied"));
	}

	async function stopShared() {
		try {
			await api.request.unexposeShared({ taskId });
		} catch {/* server logged */}
	}

	return (
		<div
			ref={menuRef}
			className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active py-1 w-[22rem] max-h-[28rem] overflow-y-auto"
			style={{ top: menuPos.top, left: menuPos.left, visibility: visible ? "visible" : "hidden" }}
			onClick={(event) => event.stopPropagation()}
		>
			<div className="px-3 py-2 text-xs text-fg-3 uppercase tracking-wider font-semibold border-b border-edge">
				{t("tunnel.exposedPortsSection")}
			</div>

			<div className="py-1">
				{allocatedPorts.map((port, idx) => {
					const tunnel = quickFor(port);
					const isBusy = busyPort === port;
					return (
						<div key={port} className="px-3 py-2 text-sm border-b border-edge/40 last:border-b-0">
							<div className="flex items-center justify-between gap-2">
								<div className="flex flex-col min-w-0">
									<span className="font-mono text-fg">:{port}</span>
									<span className="text-xs text-fg-3">$DEV3_PORT{idx}</span>
								</div>
								<div className="flex items-center gap-1 flex-shrink-0">
									{tunnel ? (
										tunnel.state === "starting" ? (
											<span className="text-xs text-fg-3 px-2 py-1">{t("tunnel.starting")}</span>
										) : tunnel.state === "failed" ? (
											<span className="text-xs text-danger px-2 py-1">{t("tunnel.failed")}</span>
										) : (
											<button
												onClick={() => handleUnexpose(port)}
												disabled={isBusy}
												className="text-xs text-danger hover:bg-danger/10 px-2 py-1 rounded"
											>
												{t("tunnel.stopExposing")}
											</button>
										)
									) : (
										<button
											onClick={() => handleExpose(port)}
											disabled={isBusy}
											className="text-xs text-accent bg-accent/10 hover:bg-accent/20 px-2 py-1 rounded"
										>
											{t("tunnel.exposeViaCloudflare")}
										</button>
									)}
								</div>
							</div>
							{tunnel?.state === "connected" && tunnel.url && (
								<button
									onClick={() => copyUrl(tunnel.url!)}
									className="text-xs text-accent hover:text-accent-hover truncate block w-full text-left mt-1.5"
									title={tunnel.url}
								>
									{tunnel.url}
								</button>
							)}
							<div className="flex items-center gap-3 mt-1.5">
								<button
									onClick={() => handleAddToShared(port)}
									className="text-[0.6875rem] text-fg-3 hover:text-fg-2 underline-offset-2 hover:underline"
								>
									{t("tunnel.addToShared")}
								</button>
								<button
									onClick={() => copySsh(port)}
									className="text-[0.6875rem] text-fg-3 hover:text-fg-2 underline-offset-2 hover:underline"
								>
									{t("tunnel.copySshCommand")}
								</button>
							</div>
						</div>
					);
				})}
			</div>

			{sharedTunnel && (
				<div className="border-t border-edge px-3 py-2.5 bg-base/40">
					<div className="flex items-center justify-between mb-1">
						<span className="text-xs text-fg-2 font-semibold">{t("tunnel.sharedTunnel")}</span>
						<button onClick={stopShared} className="text-xs text-danger hover:bg-danger/10 px-2 py-1 rounded">
							{t("tunnel.stopExposing")}
						</button>
					</div>
					<div className="text-xs text-fg-3 mb-1.5">{t("tunnel.portsLabel")}: {sharedTunnel.ports.join(", ")}</div>
					{sharedTunnel.state === "connected" && sharedTunnel.url && (
						<button
							onClick={() => copyUrl(sharedTunnel.url!)}
							className="text-xs text-accent hover:text-accent-hover truncate block w-full text-left"
							title={sharedTunnel.url}
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
				<div className="absolute -bottom-8 left-1/2 -translate-x-1/2 px-3 py-1 bg-elevated border border-edge text-fg text-xs rounded shadow-lg whitespace-nowrap">
					{toast}
				</div>
			)}
		</div>
	);
}
