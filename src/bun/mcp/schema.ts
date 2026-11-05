/**
 * The JSON Schema subset the MCP tool table uses, and a validator for it. The
 * schemas are published as-is in `tools/list`, so the validator and the
 * advertised contract are one object. Every object schema is closed
 * (`additionalProperties: false`): an argument the tool does not declare —
 * `asSender`, `sourceTaskId`, `takeOver` — is a usage error, never ignored.
 */

export type JsonSchema =
	| { type: "string"; description?: string; minLength?: number; maxLength?: number; enum?: readonly string[]; pattern?: string }
	| { type: "integer"; description?: string; minimum?: number; maximum?: number }
	| { type: "boolean"; description?: string }
	| { type: "array"; description?: string; items: JsonSchema; minItems?: number; maxItems?: number }
	| ObjectSchema;

export interface ObjectSchema {
	type: "object";
	description?: string;
	properties: Record<string, JsonSchema>;
	required?: readonly string[];
	additionalProperties: false;
}

/** The first problem with `value`, as a sentence naming its path, or null when it fits. */
export function validate(schema: JsonSchema, value: unknown, path = "arguments"): string | null {
	switch (schema.type) {
		case "string": {
			if (typeof value !== "string") return `${path} must be a string`;
			if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} must be at least ${schema.minLength} characters`;
			if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} must be at most ${schema.maxLength} characters`;
			if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.join(", ")}`;
			if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path} has an invalid format`;
			return null;
		}
		case "integer": {
			if (typeof value !== "number" || !Number.isInteger(value)) return `${path} must be an integer`;
			if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be >= ${schema.minimum}`;
			if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be <= ${schema.maximum}`;
			return null;
		}
		case "boolean":
			return typeof value === "boolean" ? null : `${path} must be a boolean`;
		case "array": {
			if (!Array.isArray(value)) return `${path} must be an array`;
			if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} items`;
			if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} takes at most ${schema.maxItems} items`;
			for (let i = 0; i < value.length; i++) {
				const problem = validate(schema.items, value[i], `${path}[${i}]`);
				if (problem) return problem;
			}
			return null;
		}
		case "object": {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return `${path} must be an object`;
			const record = value as Record<string, unknown>;
			for (const key of Object.keys(record)) {
				if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) return `${path}.${key} is not an accepted argument`;
			}
			for (const key of schema.required ?? []) {
				if (record[key] === undefined) return `${path}.${key} is required`;
			}
			for (const [key, child] of Object.entries(schema.properties)) {
				if (record[key] === undefined) continue;
				const problem = validate(child, record[key], `${path}.${key}`);
				if (problem) return problem;
			}
			return null;
		}
	}
}
