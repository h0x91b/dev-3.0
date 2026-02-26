import { useState, useRef, useEffect, type Dispatch } from "react";
import { createPortal } from "react-dom";
import type { CodingAgent, GlobalSettings, Project, Task, TaskStatus } from "../../shared/types";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";

interface SelectOption {
	value: string;
	label: string;
}

function Select({
	id,
	value,
	options,
	onChange,
}: {
	id?: string;
	value: string;
	options: SelectOption[];
	onChange: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [dropdownStyle, setDropdownStyle] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });
	const buttonRef = useRef<HTMLButtonElement>(null);
	const selected = options.find((o) => o.value === value);

	function handleOpen() {
		if (buttonRef.current) {
			const rect = buttonRef.current.getBoundingClientRect();
			setDropdownStyle({
				top: rect.bottom + 4,
				left: rect.left,
				width: rect.width,
			});
		}
		setOpen((v) => !v);
	}

	useEffect(() => {
		function handleClick(e: MouseEvent) {
			const target = e.target as Node;
			if (buttonRef.current && !buttonRef.current.contains(target)) {
				setOpen(false);
			}
		}
		if (open) document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [open]);

	return (
		<div className="relative w-full" id={id}>
			<button
				ref={buttonRef}
				type="button"
				onClick={handleOpen}
				className={`w-full flex items-center justify-between gap-2 bg-elevated text-fg text-sm rounded-lg px-3 py-1.5 border transition-colors outline-none text-left ${
					open ? "border-accent" : "border-edge hover:border-edge-active"
				}`}
			>
				<span className="truncate">{selected?.label ?? ""}</span>
				<svg
					className={`w-3.5 h-3.5 text-fg-3 flex-shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
					viewBox="0 0 12 12"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.8"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<polyline points="2,4 6,8 10,4" />
				</svg>
			</button>

			{open && createPortal(
				<div
					style={{ position: "fixed", top: dropdownStyle.top, left: dropdownStyle.left, width: dropdownStyle.width, zIndex: 9999 }}
					className="bg-overlay border border-edge-active rounded-lg shadow-xl shadow-black/50 overflow-hidden"
				>
					{options.map((opt) => (
						<button
							key={opt.value}
							type="button"
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => {
								onChange(opt.value);
								setOpen(false);
							}}
							className={`w-full text-left px-3 py-2 text-sm transition-colors ${
								opt.value === value
									? "bg-accent/15 text-fg font-medium"
									: "text-fg-2 hover:bg-raised-hover hover:text-fg"
							}`}
						>
							{opt.label}
						</button>
					))}
				</div>,
				document.body,
			)}
		</div>
	);
}

interface VariantRow {
	agentId: string | null;
	configId: string | null;
}

interface LaunchVariantsModalProps {
	task: Task;
	project: Project;
	targetStatus: TaskStatus;
	agents: CodingAgent[];
	globalSettings: GlobalSettings;
	dispatch: Dispatch<AppAction>;
	onClose: () => void;
}

function LaunchVariantsModal({
	task,
	project,
	targetStatus,
	agents,
	globalSettings,
	dispatch,
	onClose,
}: LaunchVariantsModalProps) {
	const t = useT();

	function makeDefaultVariant(): VariantRow {
		// Try global default agent, fall back to first available
		let agentId: string | null = globalSettings.defaultAgentId ?? null;
		let agent = agentId ? agents.find((a) => a.id === agentId) : null;

		// If agent not found (null, undefined, or removed), use first available
		if (!agent && agents.length > 0) {
			agent = agents[0];
			agentId = agent.id;
		}

		const configId =
			globalSettings.defaultConfigId ??
			agent?.defaultConfigId ??
			agent?.configurations[0]?.id ??
			null;
		return { agentId, configId };
	}

	const [variants, setVariants] = useState<VariantRow[]>(() => [makeDefaultVariant()]);
	const [launching, setLaunching] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function addVariant() {
		setVariants((prev) => [...prev, makeDefaultVariant()]);
	}

	function removeVariant(index: number) {
		setVariants((prev) => prev.filter((_, i) => i !== index));
	}

	function updateVariant(index: number, updates: Partial<VariantRow>) {
		setVariants((prev) =>
			prev.map((v, i) => (i === index ? { ...v, ...updates } : v)),
		);
	}

	function handleAgentChange(index: number, agentId: string | null) {
		// When agent changes, reset config to that agent's default
		const agent = agents.find((a) => a.id === agentId);
		const configId = agent?.defaultConfigId ?? agent?.configurations[0]?.id ?? null;
		updateVariant(index, { agentId, configId });
	}

	async function handleLaunch() {
		setLaunching(true);
		setError(null);
		try {
			const resultTasks = await api.request.spawnVariants({
				taskId: task.id,
				projectId: project.id,
				targetStatus,
				variants,
			});
			dispatch({ type: "spawnVariants", sourceTaskId: task.id, variants: resultTasks });
			onClose();
		} catch (err) {
			setError(String(err));
		}
		setLaunching(false);
	}

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onClick={onClose}
		>
			<div
				className="bg-overlay rounded-2xl shadow-2xl shadow-black/50 border border-edge-active w-full max-w-lg mx-4 overflow-hidden"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="px-6 py-4 border-b border-edge">
					<h2 className="text-fg text-lg font-semibold">{t("launch.title")}</h2>
					<p className="text-fg-3 text-sm mt-1 truncate">{task.title}</p>
				</div>

				{/* Variant rows */}
				<div className="px-6 py-4 space-y-3 max-h-[50vh] overflow-y-auto">
					{variants.map((variant, index) => {
						const selectedAgent = agents.find((a) => a.id === variant.agentId);
						const configs = selectedAgent?.configurations ?? [];

						return (
							<div
								key={index}
								className="flex items-center gap-3 p-3 bg-raised rounded-xl border border-edge"
							>
								{/* Variant number */}
								<span className="text-accent font-bold text-sm w-7 flex-shrink-0">
									#{index + 1}
								</span>

								{/* Agent select */}
								<div className="flex-1 min-w-0">
									<label className="text-xs text-fg-3 block mb-1">
										{t("launch.agent")}
									</label>
									<Select
										id={`variant-agent-${index}`}
										value={variant.agentId ?? ""}
										options={agents.map((a) => ({ value: a.id, label: a.name }))}
										onChange={(val) => handleAgentChange(index, val || null)}
									/>
								</div>

								{/* Config select */}
								<div className="flex-1 min-w-0">
									<label className="text-xs text-fg-3 block mb-1">
										{t("launch.config")}
									</label>
									<Select
										id={`variant-config-${index}`}
										value={variant.configId ?? ""}
										options={configs.map((c) => ({ value: c.id, label: c.name }))}
										onChange={(val) => updateVariant(index, { configId: val || null })}
									/>
								</div>

								{/* Remove button */}
								{variants.length > 1 && (
									<button
										onClick={() => removeVariant(index)}
										className="text-fg-muted hover:text-danger transition-colors p-1 mt-4 flex-shrink-0"
										title={t("launch.removeVariant")}
									>
										<svg
											className="w-4 h-4"
											fill="none"
											stroke="currentColor"
											viewBox="0 0 24 24"
										>
											<path
												strokeLinecap="round"
												strokeLinejoin="round"
												strokeWidth={2}
												d="M6 18L18 6M6 6l12 12"
											/>
										</svg>
									</button>
								)}
							</div>
						);
					})}
				</div>

				{/* Error */}
				{error && (
					<div className="px-6 py-2 text-danger text-sm">
						{t("launch.failedLaunch", { error })}
					</div>
				)}

				{/* Footer */}
				<div className="px-6 py-4 border-t border-edge flex items-center justify-between">
					<button
						onClick={addVariant}
						className="text-accent hover:text-accent-hover text-sm font-medium transition-colors"
					>
						{t("launch.addVariant")}
					</button>

					<div className="flex items-center gap-3">
						<button
							onClick={onClose}
							className="text-fg-3 hover:text-fg text-sm transition-colors px-3 py-1.5"
							disabled={launching}
						>
							{t("kanban.cancel")}
						</button>
						<button
							onClick={handleLaunch}
							disabled={launching || variants.length === 0}
							className="bg-accent hover:bg-accent-hover text-white text-sm font-medium px-5 py-2 rounded-xl transition-colors disabled:opacity-50"
						>
							{launching ? t("launch.launching") : t("launch.launch")}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

export default LaunchVariantsModal;
