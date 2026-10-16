import { useState } from "react";
import type { CodingAgent, ColumnAgentConfig, CustomColumn } from "../../../shared/types";
import { CUSTOM_COLUMN_INSTRUCTION_MAX_CHARS } from "../../../shared/types";
import { useT } from "../../i18n";
import AgentConfigPicker from "../AgentConfigPicker";
import ColorSwatchPicker from "../ColorSwatchPicker";
import { ToggleSwitch } from "./fields";

interface CustomColumnRowProps {
	column: CustomColumn;
	saving: boolean;
	onUpdate: (name: string, color: string, llmInstruction: string, agentConfig?: ColumnAgentConfig | null) => void;
	onDelete: () => void;
	availableAgents: CodingAgent[];
	projectId: string;
}

export function CustomColumnRow({ column, saving, onUpdate, onDelete, availableAgents, projectId }: CustomColumnRowProps) {
	const t = useT();
	const [name, setName] = useState(column.name);
	const [color, setColor] = useState(column.color);
	const [llmInstruction, setLlmInstruction] = useState(column.llmInstruction);
	const [agentEnabled, setAgentEnabled] = useState(!!column.agentConfig);
	const [agentId, setAgentId] = useState(column.agentConfig?.agentId ?? "builtin-claude");
	const [configId, setConfigId] = useState(column.agentConfig?.configId ?? "claude-default");
	const [agentPrompt, setAgentPrompt] = useState(column.agentConfig?.prompt ?? "");

	function buildAgentConfig(): ColumnAgentConfig | null {
		if (!agentEnabled) return null;
		return { agentId, configId, prompt: agentPrompt };
	}

	function commitUpdate(newName = name, newColor = color, newInstruction = llmInstruction, newAgentConfig?: ColumnAgentConfig | null) {
		const trimmedName = newName.trim();
		if (!trimmedName) return;
		// An instruction past the limit is rejected by the agent side, so never
		// persist it — the counter turns red and explains why nothing saved.
		if (newInstruction.length > CUSTOM_COLUMN_INSTRUCTION_MAX_CHARS) return;
		onUpdate(trimmedName, newColor, newInstruction, newAgentConfig !== undefined ? newAgentConfig : buildAgentConfig());
	}

	const isOverLimit = llmInstruction.length > CUSTOM_COLUMN_INSTRUCTION_MAX_CHARS;

	return (
		<div className="p-3 bg-elevated rounded-xl border border-edge space-y-3">
			{/* Name + color + delete */}
			<div>
				<div className="flex items-center justify-between mb-1">
					<span className="text-fg-3 text-xs">{t("customColumns.columnName")}</span>
					<button
						type="button"
						onClick={onDelete}
						disabled={saving}
						className="grid place-items-center w-7 h-7 rounded-lg text-fg-3 hover:text-danger hover:bg-danger/10 outline-none focus-visible:ring-2 focus-visible:ring-danger/50 transition-colors"
						title={t("customColumns.deleteColumn")}
						aria-label={t("customColumns.deleteColumn")}
					>
						<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>
				<div className="flex items-center gap-1.5">
					<ColorSwatchPicker
						value={color}
						disabled={saving}
						label={t("customColumns.colorPicker")}
						onChange={(next) => { setColor(next); commitUpdate(name, next, llmInstruction); }}
					/>
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						onBlur={() => commitUpdate()}
						onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
						aria-label={t("customColumns.columnName")}
						placeholder={t("customColumns.columnName")}
						disabled={saving}
						className="flex-1 px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/40 transition-colors min-w-0"
					/>
				</div>
			</div>
			{/* LLM instruction */}
			<div>
				<label htmlFor={`column-instruction-${column.id}`} className="block text-fg-3 text-xs mb-1">{t("customColumns.llmInstruction")}</label>
				<textarea
					id={`column-instruction-${column.id}`}
					value={llmInstruction}
					onChange={(e) => setLlmInstruction(e.target.value)}
					onBlur={() => commitUpdate()}
					placeholder={t("customColumns.llmInstructionPlaceholder")}
					disabled={saving}
					rows={2}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					aria-invalid={isOverLimit}
					aria-describedby={`column-instruction-count-${column.id}`}
					className={`w-full px-3 py-2 bg-base border rounded-lg text-fg-2 text-xs placeholder-fg-muted outline-none transition-colors resize-none ${
						isOverLimit ? "border-danger focus:border-danger" : "border-edge focus:border-accent/40"
					}`}
				/>
				<div
					id={`column-instruction-count-${column.id}`}
					aria-live="polite"
					className={`text-right text-xs mt-0.5 tabular-nums ${isOverLimit ? "text-danger" : "text-fg-muted"}`}
				>
					{t("customColumns.charCount", { count: String(llmInstruction.length), max: String(CUSTOM_COLUMN_INSTRUCTION_MAX_CHARS) })}
					{isOverLimit && <span className="ml-2">{t("customColumns.charCountOverLimit")}</span>}
				</div>
			</div>
			{/* Column Agent */}
			<div className="border-t border-edge/50 pt-3">
				<div className="flex items-center justify-between gap-3 mb-2">
					<div>
						<span className="block text-fg-3 text-xs font-medium">{t("columnAgent.title")}</span>
						<p className="text-fg-muted text-dense">{t("columnAgent.desc")}</p>
					</div>
					<ToggleSwitch
						checked={agentEnabled}
						ariaLabel={t("columnAgent.enable")}
						size="sm"
						onToggle={() => {
							const next = !agentEnabled;
							setAgentEnabled(next);
							commitUpdate(name, color, llmInstruction, next ? { agentId, configId, prompt: agentPrompt } : null);
						}}
					/>
				</div>
				{agentEnabled && (
					<div className="space-y-2 pl-1">
						<AgentConfigPicker
							idPrefix={`column-agent-${column.id}`}
							agents={availableAgents}
							projectId={projectId}
							agentId={agentId}
							configId={configId}
							onChange={(next) => {
								const nextAgentId = next.agentId ?? "builtin-claude";
								const nextConfigId = next.configId ?? "claude-default";
								setAgentId(nextAgentId);
								setConfigId(nextConfigId);
								// State updates are async, so persist with the fresh pair
								// rather than relying on the (stale) state values.
								commitUpdate(name, color, llmInstruction, { agentId: nextAgentId, configId: nextConfigId, prompt: agentPrompt });
							}}
						/>
						<div>
							<label htmlFor={`column-agent-prompt-${column.id}`} className="block text-fg-3 text-xs mb-1">{t("columnAgent.prompt")}</label>
							<textarea
								id={`column-agent-prompt-${column.id}`}
								value={agentPrompt}
								onChange={(e) => setAgentPrompt(e.target.value)}
								onBlur={() => commitUpdate()}
								placeholder={t("columnAgent.promptPlaceholder")}
								disabled={saving}
								rows={3}
								autoCapitalize="off"
								autoCorrect="off"
								spellCheck={false}
								className="w-full px-2 py-1.5 bg-base border border-edge rounded-lg text-fg-2 text-xs placeholder-fg-muted outline-none focus:border-accent/40 transition-colors resize-y font-mono"
							/>
							<p className="text-fg-muted text-nano mt-1">{t("columnAgent.hint")}</p>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
