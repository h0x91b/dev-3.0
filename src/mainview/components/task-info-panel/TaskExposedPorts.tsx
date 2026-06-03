import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ExposedPort, Task } from "../../../shared/types";
import { api } from "../../rpc";
import { useT } from "../../i18n";
import { useTaskAllocatedPorts } from "./useTaskAllocatedPorts";

interface TaskExposedPortsProps {
	task: Task;
}

/** Tiny inline spinner matching the design-token palette — use inside small
    buttons for async actions (Expose / Stop / shared toggle). */
function Spinner() {
	return (
		<svg
			className="w-3 h-3 animate-spin"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="9" strokeWidth="3" opacity="0.25" />
			<path d="M21 12a9 9 0 00-9-9" strokeWidth="3" strokeLinecap="round" />
		</svg>
	);
}

/**
 * Truncated URL + a Nerd-Font copy icon button (matches the worktree-path
 * copy affordance in TaskGitActions). The whole row is one button so a
 * stray click anywhere on the URL still copies; on success the icon
 * briefly flips to a checkmark and the row reads "Copied".
 */
function CopyUrlRow({ url }: { url: string }) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	async function handleClick() {
		try {
			await navigator.clipboard.writeText(url);
			setCopied(true);
			setTimeout(() => setCopied(false), 1000);
		} catch { /* clipboard blocked */ }
	}
	return (
		<button
			onClick={handleClick}
			className="flex items-center gap-1.5 text-xs text-accent hover:text-accent-hover w-full text-left rounded px-1 -mx-1 hover:bg-accent/10 transition-colors"
			title={copied ? t("tunnel.urlCopied") : t("tunnel.copyUrl")}
		>
			<span className="truncate flex-1">{copied ? t("tunnel.copied") : url}</span>
			<span
				className="text-xs leading-none flex-shrink-0"
				style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
			>
				{copied ? "\u{F012C}" : "\uF0C5"}
			</span>
		</button>
	);
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
				className={`flex items-center gap-1 px-2 py-1 rounded-lg transition-colors flex-shrink-0 border ${
					activeCount > 0
						? "text-accent border-accent/40 bg-accent/10 hover:bg-accent/20"
						: "text-fg-2 border-edge hover:bg-elevated hover:text-fg"
				}`}
				title={t("tunnel.exposedPortsSection")}
			>
				<span
					className="text-[1.125rem] leading-none"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{"\u{F1087}"}
				</span>
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
		function handleKey(event: KeyboardEvent) {
			if (event.key === "Escape") onClose();
		}
		document.addEventListener("keydown", handleKey);
		return () => document.removeEventListener("keydown", handleKey);
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
		<>
			{/* Transparent backdrop — any click outside the menu closes it.
			    More reliable than document-mousedown listeners across portal
			    boundaries, and matches how OS popovers behave. */}
			<div className="fixed inset-0 z-40" onClick={onClose} />
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
											<span className="text-xs text-fg-3 px-2 py-1 inline-flex items-center gap-1.5">
												<Spinner /> {t("tunnel.starting")}
											</span>
										) : tunnel.state === "failed" ? (
											<span className="text-xs text-danger px-2 py-1">{t("tunnel.failed")}</span>
										) : (
											<button
												onClick={() => handleUnexpose(port)}
												disabled={isBusy}
												className="text-xs text-danger border border-danger/30 hover:bg-danger/10 px-2 py-1 rounded inline-flex items-center gap-1.5 disabled:opacity-60"
											>
												{isBusy && <Spinner />}
												{t("tunnel.stopExposing")}
											</button>
										)
									) : (
										<button
											onClick={() => handleExpose(port)}
											disabled={isBusy}
											className="text-xs text-accent border border-accent/40 bg-accent/10 hover:bg-accent/20 px-2 py-1 rounded inline-flex items-center gap-1.5 disabled:opacity-60"
										>
											{isBusy && <Spinner />}
											{isBusy ? t("tunnel.starting") : t("tunnel.exposeViaCloudflare")}
										</button>
									)}
								</div>
							</div>
							{tunnel?.state === "connected" && tunnel.url && (
								<div className="mt-1.5">
									<CopyUrlRow url={tunnel.url} />
								</div>
							)}
							<div className="flex items-center gap-3 mt-1.5">
								<button
									onClick={() => handleAddToShared(port)}
									className="text-[0.6875rem] text-fg-3 hover:text-fg-2 underline-offset-2 hover:underline"
									title={t("tunnel.sharedDescription")}
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
						<button onClick={stopShared} className="text-xs text-danger border border-danger/30 hover:bg-danger/10 px-2 py-1 rounded">
							{t("tunnel.stopExposing")}
						</button>
					</div>
					<div className="text-[0.6875rem] text-fg-muted mb-1.5 leading-snug">{t("tunnel.sharedDescription")}</div>
					<div className="text-xs text-fg-3 mb-1.5">{t("tunnel.portsLabel")}: {sharedTunnel.ports.join(", ")}</div>
					{sharedTunnel.state === "connected" && sharedTunnel.url && (
						<CopyUrlRow url={sharedTunnel.url} />
					)}
					{sharedTunnel.state === "starting" && (
						<span className="text-xs text-fg-3 inline-flex items-center gap-1.5"><Spinner /> {t("tunnel.starting")}</span>
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
		</>
	);
}
