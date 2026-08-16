import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfiguration, ModelCatalogView } from "../../../../shared/types";
import { I18nProvider, type TFunction } from "../../../i18n";
import PresetModelRoles from "../PresetModelRoles";

const t = ((key: string) => key) as unknown as TFunction;

const CATALOG: ModelCatalogView = {
	providers: [
		{ id: "p-or", kind: "openrouter", label: "OpenRouter", hasKey: true },
		{ id: "p-oai", kind: "openai", label: "OpenAI", hasKey: true },
	],
	models: [
		{ id: "m-fast", providerId: "p-or", name: "fast-gremlin", modelId: "deepseek/flash" },
		{ id: "m-main", providerId: "p-oai", name: "my-main", modelId: "gpt-5.6-sol" },
	],
};

function renderRoles(
	baseCommand: string,
	config: Partial<AgentConfiguration> = {},
	catalog: ModelCatalogView | null = CATALOG,
) {
	const onChange = vi.fn();
	const view = render(
		<I18nProvider>
			<PresetModelRoles
				t={t}
				baseCommand={baseCommand}
				config={{ id: "c1", name: "Preset", ...config } as AgentConfiguration}
				catalog={catalog}
				onChange={onChange}
			/>
		</I18nProvider>,
	);
	return { onChange, ...view };
}

describe("when the block appears at all", () => {
	it("offers Claude Code its own alias slots", () => {
		renderRoles("claude");
		expect(screen.getByText("catalog.roleOpus")).toBeTruthy();
		expect(screen.getByText("catalog.roleHaiku")).toBeTruthy();
	});

	it("offers Codex the roles Codex has, and none it does not", () => {
		renderRoles("codex");
		expect(screen.getByText("catalog.roleMain")).toBeTruthy();
		expect(screen.queryByText("catalog.roleOpus")).toBeNull();
	});

	it("stays out of the way for an agent dev3 cannot route", () => {
		const { container } = renderRoles("gemini");
		expect(container.textContent).toBe("");
	});

	it("stays hidden while the catalog is empty, instead of showing a dead control", () => {
		const { container } = renderRoles("claude", {}, { providers: [], models: [] });
		expect(container.textContent).toBe("");
	});

	it("stays hidden until the catalog has loaded", () => {
		const { container } = renderRoles("claude", {}, null);
		expect(container.textContent).toBe("");
	});
});

describe("warnings the user must see before launching", () => {
	it("warns when an OpenRouter model serves a Claude Code role", () => {
		renderRoles("claude", { modelRoles: { sonnet: "m-fast" } });
		expect(screen.getByText("catalog.warnOpenRouterTitle")).toBeTruthy();
	});

	it("keeps quiet for a direct provider", () => {
		renderRoles("claude", { modelRoles: { opus: "m-main" } });
		expect(screen.queryByText("catalog.warnOpenRouterTitle")).toBeNull();
	});

	it("names a role left pointing at a deleted model", () => {
		renderRoles("claude", { modelRoles: { opus: "m-gone" } });
		expect(screen.getByText("catalog.roleOrphan")).toBeTruthy();
	});
});
