import { useState } from "react";
import type { Dev3RepoConfig } from "../../../shared/types";
import {
	CONFIG_KEYS,
	fieldUi,
	getFieldSpec,
	type ConfigKey,
	type ConfigSection,
	type ValueSpec,
} from "../../../shared/config-schema";
import { useT } from "../../i18n";
import { ListEditor } from "../ListEditor";
import { ToggleSwitch } from "./fields";

/** Fields of `section` that have no hand-built control, in schema order. */
export function genericFieldKeys(section: ConfigSection): ConfigKey[] {
	return CONFIG_KEYS.filter((key) => fieldUi(key) === "generic" && getFieldSpec(key).section === section);
}

const INPUT = "w-full px-3 py-2 bg-raised border border-edge rounded-xl text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors";

/**
 * Controls rendered straight from the config schema for every field that has
 * no hand-built control, so a new schema field is editable in Project Settings
 * the moment it exists. The label is the config key itself and the help text
 * is the schema's English description: both are identifiers of the file
 * format, which the docs and the CLI print the same way.
 */
export function SchemaConfigFields({
	section,
	config,
	onChange,
	inherited,
}: {
	section: ConfigSection;
	config: Dev3RepoConfig;
	onChange: (config: Dev3RepoConfig) => void;
	inherited?: Dev3RepoConfig;
}) {
	const keys = genericFieldKeys(section);
	if (keys.length === 0) return null;
	return (
		<>
			{keys.map((key) => (
				<SchemaField
					key={key}
					fieldKey={key}
					value={(config as Record<string, unknown>)[key]}
					inherited={(inherited as Record<string, unknown> | undefined)?.[key]}
					onChange={(value) => {
						const next: Record<string, unknown> = { ...config };
						if (value === undefined) delete next[key];
						else next[key] = value;
						onChange(next as Dev3RepoConfig);
					}}
				/>
			))}
		</>
	);
}

function SchemaField({ fieldKey, value, inherited, onChange }: {
	fieldKey: ConfigKey;
	value: unknown;
	inherited: unknown;
	onChange: (value: unknown) => void;
}) {
	const spec = getFieldSpec(fieldKey);
	const inline = spec.type.kind === "boolean";
	const labelId = `schema-field-${fieldKey}`;
	return (
		<div data-config-keys={fieldKey} className={inline ? "flex items-center justify-between gap-4" : undefined}>
			<div>
				<span id={labelId} className="block text-fg text-sm font-semibold font-mono mb-1">{fieldKey}</span>
				<p className={`text-fg-3 text-sm ${inline ? "" : "mb-2"}`}>{spec.description}</p>
			</div>
			<SchemaControl spec={spec.type} labelId={labelId} value={value} inherited={inherited} example={spec.example} defaultValue={spec.default} onChange={onChange} />
		</div>
	);
}

function placeholderOf(inherited: unknown, example: unknown): string {
	const v = inherited ?? example;
	if (v === undefined || v === null) return "";
	return typeof v === "string" ? v : Array.isArray(v) ? v.join(", ") : JSON.stringify(v);
}

function SchemaControl({ spec, labelId, value, inherited, example, defaultValue, onChange }: {
	spec: ValueSpec;
	labelId: string;
	value: unknown;
	inherited: unknown;
	example: unknown;
	defaultValue: unknown;
	onChange: (value: unknown) => void;
}) {
	const t = useT();
	const placeholder = placeholderOf(inherited, example);
	switch (spec.kind) {
		case "boolean": {
			const checked = (value ?? inherited ?? defaultValue ?? false) === true;
			return <ToggleSwitch checked={checked} ariaLabel={labelId.replace("schema-field-", "")} onToggle={() => onChange(!checked)} />;
		}
		case "string":
			return (
				<input
					type="text"
					aria-labelledby={labelId}
					value={typeof value === "string" ? value : ""}
					placeholder={placeholder}
					onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					className={INPUT}
				/>
			);
		case "integer":
			return (
				<input
					type="number"
					aria-labelledby={labelId}
					min={spec.min}
					max={spec.max}
					value={typeof value === "number" ? value : ""}
					placeholder={placeholder}
					onChange={(e) => {
						if (e.target.value === "") return onChange(undefined);
						const n = Math.trunc(Number(e.target.value));
						const lo = spec.min ?? Number.MIN_SAFE_INTEGER;
						const hi = spec.max ?? Number.MAX_SAFE_INTEGER;
						onChange(Math.max(lo, Math.min(hi, n)));
					}}
					className="w-24 px-3 py-1.5 rounded-lg bg-base border border-edge text-fg text-sm tabular-nums outline-none focus:border-accent transition-colors"
				/>
			);
		case "enum":
			return (
				<select
					aria-labelledby={labelId}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
					className="px-3 py-1.5 rounded-lg bg-base border border-edge text-fg text-sm font-mono outline-none focus:border-accent transition-colors"
				>
					<option value="">{t("projectSettings.schemaFieldUnset")}</option>
					{spec.values.map((v) => <option key={v} value={v}>{v}</option>)}
				</select>
			);
		case "list":
			if (spec.item.kind === "string") {
				return (
					<ListEditor
						items={Array.isArray(value) ? (value as string[]) : []}
						onChange={(items) => onChange(items.length > 0 ? items : undefined)}
						placeholder={placeholder}
						addLabel={t("listEditor.addItem")}
						removeLabel={t("listEditor.removeItem")}
					/>
				);
			}
			return <JsonControl labelId={labelId} value={value} placeholder={placeholder} onChange={onChange} />;
		case "record":
		case "object":
			return <JsonControl labelId={labelId} value={value} placeholder={placeholder} onChange={onChange} />;
	}
}

/** Structured values are edited as JSON; the field keeps its last valid value while the text is invalid. */
function JsonControl({ labelId, value, placeholder, onChange }: {
	labelId: string;
	value: unknown;
	placeholder: string;
	onChange: (value: unknown) => void;
}) {
	const t = useT();
	const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)));
	const [error, setError] = useState<string | null>(null);
	return (
		<div>
			<textarea
				aria-labelledby={labelId}
				aria-invalid={error !== null}
				value={text}
				rows={4}
				placeholder={placeholder}
				onChange={(e) => {
					setText(e.target.value);
					if (!e.target.value.trim()) {
						setError(null);
						onChange(undefined);
						return;
					}
					try {
						onChange(JSON.parse(e.target.value));
						setError(null);
					} catch (err) {
						setError(String((err as Error).message));
					}
				}}
				autoCapitalize="off"
				autoCorrect="off"
				spellCheck={false}
				className={`${INPUT} resize-y`}
			/>
			{error && <p className="mt-1 text-danger text-xs" role="alert">{t("projectSettings.schemaFieldInvalidJson", { error })}</p>}
		</div>
	);
}
