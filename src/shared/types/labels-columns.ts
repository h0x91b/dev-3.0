import type { ColumnAgentConfig } from "./column-agents";

// ---- Labels ----

export interface Label {
	id: string;
	name: string;
	color: string; // hex color from LABEL_COLORS palette
}

// ---- Custom Columns ----

/** Soft character cap for the LLM instruction field. Not enforced server-side. */
export const CUSTOM_COLUMN_INSTRUCTION_MAX_CHARS = 500;

export interface CustomColumn {
	id: string;
	name: string;
	color: string; // hex color
	llmInstruction: string; // guidance for LLM on when to move tasks here
	agentConfig?: ColumnAgentConfig; // auto-spawn agent when task enters this column
}

// Colors ordered to maximize perceptual distance between consecutive picks
// (each step jumps ~150° around the color wheel: warm→cool→warm→cool…)
export const LABEL_COLORS = [
	"#ef4444", // red       0°
	"#14b8a6", // teal    174°
	"#f97316", // orange   25°
	"#8b5cf6", // violet  258°
	"#84cc16", // lime     80°
	"#ec4899", // pink    322°
	"#06b6d4", // cyan    188°
	"#eab308", // yellow   50°
	"#3b82f6", // blue    217°
	"#22c55e", // green   142°
	"#f43f5e", // rose    350°
	"#6366f1", // indigo  239°
] as const;
