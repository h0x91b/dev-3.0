import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENTS, type ModelCatalogView } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import AgentConfigPicker from "../AgentConfigPicker";
import { OPEN_SETTINGS_SECTION_EVENT } from "../../state";
import { isSettingsCategoryId } from "../../settings-registry";
import { RECOMMENDED_REVISION } from "../../../shared/recommended-models";

const modelCatalogGet = vi.fn<() => Promise<ModelCatalogView>>();
const modelCatalogSave = vi.fn();
const getAgents = vi.fn();
const saveAgents = vi.fn();

vi.mock("../../rpc", () => ({
	api: {
		request: {
			modelCatalogGet: (...args: []) => modelCatalogGet(...args),
			modelCatalogSave: (...args: unknown[]) => modelCatalogSave(...args),
			getAgents: (...args: unknown[]) => getAgents(...args),
			saveAgents: (...args: unknown[]) => saveAgents(...args),
			// The account pill under the picker renders nothing without it, which is
			// exactly what this file wants.
			listAgentAccounts: () => Promise.reject(new Error("not under test")),
		},
	},
}));

const claude = DEFAULT_AGENTS.find((a) => a.id === "builtin-claude")!;
const gemini = DEFAULT_AGENTS.find((a) => a.baseCommand.endsWith("gemini"))!;

function setup(agent = claude) {
	const onChange = vi.fn();
	render(
		<I18nProvider>
			<AgentConfigPicker
				idPrefix="test"
				agents={[agent]}
				agentId={agent.id}
				configId={agent.defaultConfigId ?? agent.configurations[0].id}
				onChange={onChange}
			/>
		</I18nProvider>,
	);
	return { onChange };
}

describe("AgentConfigPicker — models the user has not connected", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		modelCatalogGet.mockResolvedValue({ providers: [], models: [] });
	});

	it("offers them as locked rows, with what they cost and what they replace", async () => {
		const user = userEvent.setup();
		setup();
		await waitFor(() => expect(modelCatalogGet).toHaveBeenCalled());

		await user.click(screen.getByLabelText("Model"));
		const offered = await screen.findByText("GLM 5.2");
		expect(offered.closest("button")).toHaveAttribute("aria-disabled", "true");
		// The number is the whole argument. A row that says only "DeepSeek" asks
		// the user to go and look the price up somewhere else.
		expect(screen.getByText("$4/M vs Opus 5")).toBeTruthy();
	});

	it("goes quiet once the user has a provider of their own — any provider", async () => {
		const user = userEvent.setup();
		modelCatalogGet.mockResolvedValue({
			providers: [{ id: "p1", kind: "custom", label: "My box", hasKey: false }],
			models: [],
		});
		setup();
		await waitFor(() => expect(modelCatalogGet).toHaveBeenCalled());

		await user.click(screen.getByLabelText("Model"));
		expect(screen.queryByText("GLM 5.2")).toBeNull();
		// The action never depends on the advertising.
		expect(screen.getByText("+ Connect a provider…")).toBeTruthy();
	});

	it("says nothing to an agent dev3 cannot route through the proxy", async () => {
		const user = userEvent.setup();
		setup(gemini);
		await waitFor(() => expect(modelCatalogGet).toHaveBeenCalled());

		await user.click(screen.getByLabelText("Model"));
		expect(screen.queryByText("GLM 5.2")).toBeNull();
	});

	it("opens the connect flow from the always-present row, and from a locked one", async () => {
		const user = userEvent.setup();
		const { onChange } = setup();
		await waitFor(() => expect(modelCatalogGet).toHaveBeenCalled());

		await user.click(screen.getByLabelText("Model"));
		await user.click(screen.getByText("+ Connect a provider…"));
		expect(await screen.findByTestId("connect-provider-modal")).toBeTruthy();
		// It is an action, not a model: the launch selection must not move.
		expect(onChange).not.toHaveBeenCalled();
	});

	it("starts the connect flow when a locked model is clicked, instead of dying quietly", async () => {
		const user = userEvent.setup();
		setup();
		await waitFor(() => expect(modelCatalogGet).toHaveBeenCalled());

		await user.click(screen.getByLabelText("Model"));
		await user.click(screen.getByText("Kimi K3"));
		expect(await screen.findByTestId("connect-provider-modal")).toBeTruthy();
	});
});

describe("editing the models behind a routed preset", () => {
	const routed = {
		...claude,
		configurations: [
			...claude.configurations,
			{ id: "seeded", name: "Best value", groupLabel: "Best value", modelRoles: { opus: "m1" } },
		],
	};

	beforeEach(() => {
		vi.clearAllMocks();
		modelCatalogGet.mockResolvedValue({
			providers: [{ id: "p1", kind: "openrouter", label: "OpenRouter", hasKey: true }],
			models: [{ id: "m1", providerId: "p1", name: "glm-5.2", modelId: "z-ai/glm-5.2" }],
		});
	});

	it("offers the pencil only while a role-bound preset is selected", async () => {
		const { rerender } = render(
			<I18nProvider>
				<AgentConfigPicker idPrefix="t" agents={[routed]} agentId={routed.id} configId="seeded" onChange={() => {}} />
			</I18nProvider>,
		);
		expect(await screen.findByTestId("t-edit-models")).toBeTruthy();

		// A built-in model pins one model dev3 does not own: nothing to edit.
		rerender(
			<I18nProvider>
				<AgentConfigPicker idPrefix="t" agents={[routed]} agentId={routed.id} configId={claude.defaultConfigId!} onChange={() => {}} />
			</I18nProvider>,
		);
		expect(screen.queryByTestId("t-edit-models")).toBeNull();
	});

	it("sends the user to the preset editor rather than changing the launch", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		const opened = vi.fn((e: Event) => (e as CustomEvent).detail);
		window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, opened);
		render(
			<I18nProvider>
				<AgentConfigPicker idPrefix="t" agents={[routed]} agentId={routed.id} configId="seeded" onChange={onChange} />
			</I18nProvider>,
		);
		await user.click(await screen.findByTestId("t-edit-models"));
		window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, opened);
		expect(opened).toHaveBeenCalled();
		const detail = opened.mock.results[0].value as { section: string; preset: { agentId: string; configId: string } };
		// A category id. Anything else resolves to the first category, so this
		// assertion is the only thing standing between the pencil and Appearance.
		expect(detail.section).toBe("agents");
		expect(isSettingsCategoryId(detail.section)).toBe(true);
		// And the record itself: a section alone lands the user on a page full of
		// presets with no idea which one the pencil meant.
		expect(detail.preset).toEqual({ agentId: routed.id, configId: "seeded" });
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe("a curated list that moved on after the user was seeded", () => {
	// No `seededRevision`: seeded before dev3 started stamping them, which is
	// exactly the population this prompt exists for.
	const stale = {
		...claude,
		configurations: [
			...claude.configurations,
			{ id: "seeded", name: "Best value", groupLabel: "Best value", modelRoles: { opus: "m1" } },
		],
	};

	beforeEach(() => {
		vi.clearAllMocks();
		modelCatalogGet.mockResolvedValue({
			providers: [{ id: "p1", kind: "openrouter", label: "OpenRouter", hasKey: true }],
			models: [{ id: "m1", providerId: "p1", name: "glm-5.2", modelId: "z-ai/glm-5.2" }],
		});
		modelCatalogSave.mockResolvedValue({ providers: [], models: [] });
		getAgents.mockResolvedValue([stale]);
		saveAgents.mockResolvedValue(undefined);
	});

	it("says so on the preset it would rewrite, and nowhere else", async () => {
		const { rerender } = render(
			<I18nProvider>
				<AgentConfigPicker idPrefix="t" agents={[stale]} agentId={stale.id} configId="seeded" onChange={() => {}} />
			</I18nProvider>,
		);
		expect(await screen.findByTestId("t-recommended-update")).toBeTruthy();

		rerender(
			<I18nProvider>
				<AgentConfigPicker idPrefix="t" agents={[stale]} agentId={stale.id} configId={claude.defaultConfigId!} onChange={() => {}} />
			</I18nProvider>,
		);
		expect(screen.queryByTestId("t-recommended-update")).toBeNull();
	});

	it("changes nothing until the user approves, then writes both sides", async () => {
		const user = userEvent.setup();
		render(
			<I18nProvider>
				<AgentConfigPicker idPrefix="t" agents={[stale]} agentId={stale.id} configId="seeded" onChange={() => {}} />
			</I18nProvider>,
		);
		await user.click(await screen.findByTestId("t-recommended-update"));
		// Both sides of every changing role are on screen — that is the consent.
		// `glm-5.2` is bound already, so it is NOT here: an unchanged role is not a
		// change, and listing it would inflate what the user is agreeing to.
		expect(await screen.findByTestId("recommended-update-modal")).toBeTruthy();
		expect(screen.getAllByText("kimi-k3").length).toBeGreaterThan(0);
		expect(screen.queryByText("glm-5.2")).toBeNull();
		expect(modelCatalogSave).not.toHaveBeenCalled();
		expect(saveAgents).not.toHaveBeenCalled();

		await user.click(screen.getByTestId("recommended-update-apply"));
		await waitFor(() => expect(saveAgents).toHaveBeenCalled());
		// The models have to be in the catalog before a preset may point at them.
		const savedCatalog = modelCatalogSave.mock.calls[0][0].catalog as ModelCatalogView;
		expect(savedCatalog.models.map((m) => m.modelId)).toContain("moonshotai/kimi-k3");
		const savedAgents = saveAgents.mock.calls[0][0].agents as typeof DEFAULT_AGENTS;
		const seeded = savedAgents[0].configurations.find((c) => c.id === "seeded")!;
		expect(Object.keys(seeded.modelRoles!).sort()).toEqual(["fable", "haiku", "opus", "sonnet"]);
		expect(seeded.seededRevision).toBe(RECOMMENDED_REVISION);
		// The answer is saved, but this surface was handed its agents as a prop:
		// without dropping the notice itself it would go on asking.
		await waitFor(() => expect(screen.queryByTestId("t-recommended-update")).toBeNull());
	});

	// The modal used to save the catalog snapshot it rendered from. Since
	// `modelCatalogSave` replaces the catalog wholesale and forgets the keys of
	// providers missing from it, a provider added in Settings while the launcher
	// sat open was deleted — API key and all — by pressing Apply.
	it("keeps a provider added while it sat open, instead of writing its own snapshot", async () => {
		const user = userEvent.setup();
		render(
			<I18nProvider>
				<AgentConfigPicker idPrefix="t" agents={[stale]} agentId={stale.id} configId="seeded" onChange={() => {}} />
			</I18nProvider>,
		);
		await user.click(await screen.findByTestId("t-recommended-update"));
		await screen.findByTestId("recommended-update-modal");

		// Meanwhile, in Settings.
		modelCatalogGet.mockResolvedValue({
			providers: [
				{ id: "p1", kind: "openrouter", label: "OpenRouter", hasKey: true },
				{ id: "p2", kind: "custom", label: "My box", baseUrl: "http://localhost:11434/v1", hasKey: true },
			],
			models: [{ id: "m1", providerId: "p1", name: "glm-5.2", modelId: "z-ai/glm-5.2" }],
		});

		await user.click(screen.getByTestId("recommended-update-apply"));
		await waitFor(() => expect(saveAgents).toHaveBeenCalled());

		const savedCatalog = modelCatalogSave.mock.calls[0][0].catalog as ModelCatalogView;
		expect(savedCatalog.providers.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
		// And the bindings resolve through that same fresh catalog, not through ids
		// invented for the stale one.
		const savedAgents = saveAgents.mock.calls[0][0].agents as typeof DEFAULT_AGENTS;
		const bound = Object.values(savedAgents[0].configurations.find((c) => c.id === "seeded")!.modelRoles!);
		const known = new Set(savedCatalog.models.map((m) => m.id));
		expect(bound.every((id) => known.has(id))).toBe(true);
	});

	it("takes no for an answer without touching the catalog or the models", async () => {
		const user = userEvent.setup();
		render(
			<I18nProvider>
				<AgentConfigPicker idPrefix="t" agents={[stale]} agentId={stale.id} configId="seeded" onChange={() => {}} />
			</I18nProvider>,
		);
		await user.click(await screen.findByTestId("t-recommended-update"));
		await user.click(await screen.findByTestId("recommended-update-keep"));

		await waitFor(() => expect(saveAgents).toHaveBeenCalled());
		expect(modelCatalogSave).not.toHaveBeenCalled();
		const savedAgents = saveAgents.mock.calls[0][0].agents as typeof DEFAULT_AGENTS;
		const seeded = savedAgents[0].configurations.find((c) => c.id === "seeded")!;
		// Their models stay theirs; only the "you have been asked" stamp moves.
		expect(seeded.modelRoles).toEqual({ opus: "m1" });
		expect(seeded.seededRevision).toBe(RECOMMENDED_REVISION);
	});
});
