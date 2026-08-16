import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogView, ModelSidecarStatus } from "../../../../shared/types";
import { I18nProvider, type TFunction } from "../../../i18n";
import ModelCatalogSection from "../ModelCatalogSection";

vi.mock("../../../rpc", () => ({
	api: {
		request: {
			modelCatalogGet: vi.fn(),
			modelCatalogSave: vi.fn(),
			modelSidecarStatus: vi.fn(),
			modelSidecarStart: vi.fn(),
			modelSidecarStop: vi.fn(),
			modelCatalogListModels: vi.fn(),
			getAgents: vi.fn(),
		},
	},
}));

vi.mock("../../../confirm", () => ({ confirm: vi.fn(async () => true) }));

import { api } from "../../../rpc";
import { confirm } from "../../../confirm";

/** Stub translator: keys make assertions stable and locale-agnostic. */
const t = ((key: string) => key) as unknown as TFunction;

const CATALOG: ModelCatalogView = {
	providers: [{ id: "p-or", kind: "openrouter", label: "OpenRouter", hasKey: true }],
	models: [{ id: "m-fast", providerId: "p-or", name: "fast-gremlin", modelId: "deepseek/flash" }],
};

function status(over: Partial<ModelSidecarStatus> = {}): ModelSidecarStatus {
	return { running: false, starting: false, binaryAvailable: true, version: "v1.6.10", providerCount: 1, modelCount: 1, ...over };
}

function renderSection() {
	render(
		<I18nProvider>
			<ModelCatalogSection t={t} />
		</I18nProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(api.request.modelCatalogGet).mockResolvedValue(CATALOG);
	vi.mocked(api.request.modelSidecarStatus).mockResolvedValue(status());
	vi.mocked(api.request.modelCatalogSave).mockResolvedValue(CATALOG);
	vi.mocked(confirm).mockResolvedValue(true);
	vi.mocked(api.request.getAgents).mockResolvedValue([]);
});

describe("the proxy's state", () => {
	it("says the proxy is stopped and offers to start it", async () => {
		renderSection();
		expect(await screen.findByText("catalog.proxyStopped")).toBeTruthy();
		expect(screen.getByRole("button", { name: "catalog.startProxy" })).toBeTruthy();
	});

	it("says plainly when the build ships no proxy binary", async () => {
		vi.mocked(api.request.modelSidecarStatus).mockResolvedValue(status({ binaryAvailable: false }));
		renderSection();
		expect(await screen.findByText("catalog.binaryMissing")).toBeTruthy();
	});

	it("shows the failing process's own output rather than hiding it", async () => {
		vi.mocked(api.request.modelSidecarStatus).mockResolvedValue(
			status({ lastError: "config error: provider openrouter has no key" }),
		);
		renderSection();
		expect(await screen.findByText(/provider openrouter has no key/)).toBeTruthy();
	});

	it("offers to stop it once it is running", async () => {
		vi.mocked(api.request.modelSidecarStatus).mockResolvedValue(status({ running: true, port: 41234 }));
		renderSection();
		expect(await screen.findByRole("button", { name: "catalog.stopProxy" })).toBeTruthy();
	});
});

describe("editing the catalog", () => {
	it("shows the providers and models already stored", async () => {
		renderSection();
		expect(await screen.findByDisplayValue("OpenRouter")).toBeTruthy();
		expect(screen.getByDisplayValue("fast-gremlin")).toBeTruthy();
	});

	it("says a key is stored without ever showing it", async () => {
		renderSection();
		expect(await screen.findByText("catalog.providerKeyStored")).toBeTruthy();
		const key = screen.getByPlaceholderText("••••••••") as HTMLInputElement;
		expect(key.value).toBe("");
	});

	it("keeps quiet until something actually changed", async () => {
		renderSection();
		await screen.findByDisplayValue("OpenRouter");
		expect(screen.queryByRole("button", { name: "catalog.save" })).toBeNull();
	});

	it("warns that saving restarts the proxy, before the user saves", async () => {
		renderSection();
		const name = await screen.findByDisplayValue("fast-gremlin");
		await userEvent.type(name, "-2");
		expect(screen.getByText("catalog.restartWarning")).toBeTruthy();
	});

	it("sends the edit and the typed key together", async () => {
		renderSection();
		const key = await screen.findByPlaceholderText("••••••••");
		await userEvent.type(key, "sk-new");
		await userEvent.click(screen.getByRole("button", { name: "catalog.save" }));
		await waitFor(() => expect(api.request.modelCatalogSave).toHaveBeenCalled());
		expect(vi.mocked(api.request.modelCatalogSave).mock.calls[0][0].providerKeys).toEqual({ "p-or": "sk-new" });
	});

	it("refuses to save a name that cannot travel on the wire", async () => {
		renderSection();
		const name = await screen.findByDisplayValue("fast-gremlin");
		await userEvent.clear(name);
		await userEvent.type(name, "fast gremlin");
		expect(screen.getByText("catalog.issue.invalid-name")).toBeTruthy();
		expect(screen.getByRole("button", { name: "catalog.save" })).toHaveProperty("disabled", true);
	});

	it("names the model-id filter after its field, not after its examples", async () => {
		renderSection();
		await screen.findByDisplayValue("fast-gremlin");
		await userEvent.click(document.getElementById("model-id-m-fast") as HTMLElement);
		expect(screen.getByRole("combobox", { name: "catalog.modelId" })).toBeTruthy();
	});

	it("renames a provider along with its kind, so no row lies about who it talks to", async () => {
		renderSection();
		await screen.findByDisplayValue("OpenRouter");
		// A fresh row is named after its kind; switching the kind must rename it.
		await userEvent.click(screen.getByRole("button", { name: "catalog.addProvider" }));
		expect(screen.getByDisplayValue("catalog.kind.openai")).toBeTruthy();
		const kinds = document.querySelectorAll<HTMLElement>("[id^=provider-kind-]");
		await userEvent.click(kinds[kinds.length - 1]);
		await userEvent.click(screen.getByRole("option", { name: "catalog.kind.anthropic" }));
		expect(screen.getByDisplayValue("catalog.kind.anthropic")).toBeTruthy();
		expect(screen.queryByDisplayValue("catalog.kind.openai")).toBeNull();
	});

	it("keeps a name the user typed when the kind changes", async () => {
		renderSection();
		const name = await screen.findByDisplayValue("OpenRouter");
		await userEvent.clear(name);
		await userEvent.type(name, "work account");
		await userEvent.click(document.getElementById("provider-kind-p-or") as HTMLElement);
		await userEvent.click(screen.getByRole("option", { name: "catalog.kind.openai" }));
		expect(screen.getByDisplayValue("work account")).toBeTruthy();
	});

	it("says how many models a provider takes down with it", async () => {
		renderSection();
		await userEvent.click(await screen.findByRole("button", { name: "catalog.removeProvider" }));
		await waitFor(() => expect(confirm).toHaveBeenCalled());
		expect(vi.mocked(confirm).mock.calls[0][0].message).toBe("catalog.removeProviderOrphans");
	});

	it("says how many presets a deletion would break", async () => {
		vi.mocked(api.request.getAgents).mockResolvedValue([
			{
				id: "a1",
				name: "Claude",
				baseCommand: "claude",
				configurations: [{ id: "c1", name: "Mix", modelRoles: { opus: "m-fast" } }],
			},
		] as never);
		renderSection();
		await userEvent.click(await screen.findByRole("button", { name: "catalog.removeModel" }));
		await waitFor(() => expect(confirm).toHaveBeenCalled());
		expect(vi.mocked(confirm).mock.calls[0][0].message).toBe("catalog.removeModelInUse");
	});

	it("drops nothing when the user cancels the removal", async () => {
		vi.mocked(confirm).mockResolvedValue(false);
		renderSection();
		await userEvent.click(await screen.findByRole("button", { name: "catalog.removeProvider" }));
		await waitFor(() => expect(confirm).toHaveBeenCalled());
		expect(screen.getByDisplayValue("OpenRouter")).toBeTruthy();
	});

	it("cannot add a model before there is a provider to hang it on", async () => {
		vi.mocked(api.request.modelCatalogGet).mockResolvedValue({ providers: [], models: [] });
		renderSection();
		expect(await screen.findByText("catalog.noProviders")).toBeTruthy();
		expect(screen.getByRole("button", { name: "catalog.addModel" })).toHaveProperty("disabled", true);
	});
});

describe("telling the user what to do", () => {
	it("names the first step instead of showing a screen of dead controls", async () => {
		vi.mocked(api.request.modelCatalogGet).mockResolvedValue({ providers: [], models: [] });
		renderSection();
		expect(await screen.findByText("catalog.firstRunTitle")).toBeTruthy();
		expect(screen.getByText("catalog.firstRunStep1")).toBeTruthy();
	});

	it("drops the first-run guidance once the catalog has content", async () => {
		renderSection();
		await screen.findByDisplayValue("OpenRouter");
		expect(screen.queryByText("catalog.firstRunTitle")).toBeNull();
	});

	// A greyed button that explains nothing is what made the user read the whole
	// screen as broken; the precondition has to be on screen, not implied.
	it("says why the proxy cannot start yet", async () => {
		vi.mocked(api.request.modelCatalogGet).mockResolvedValue({ providers: [], models: [] });
		renderSection();
		expect(await screen.findByText("catalog.startNeedsProvider")).toBeTruthy();
		expect(screen.getByRole("button", { name: "catalog.startProxy" })).toHaveProperty("disabled", true);
	});

	// A saved provider is the whole precondition: asking it what models it offers
	// is the step BEFORE naming any of them, so models cannot be required here.
	it("lets the proxy start on a saved provider alone, before any model is named", async () => {
		vi.mocked(api.request.modelCatalogGet).mockResolvedValue({
			providers: [{ id: "p-or", kind: "openrouter", label: "OpenRouter", hasKey: true }],
			models: [],
		});
		renderSection();
		await screen.findByDisplayValue("OpenRouter");
		expect(screen.queryByText("catalog.startNeedsProvider")).toBeNull();
		expect(screen.getByRole("button", { name: "catalog.startProxy" })).toHaveProperty("disabled", false);
	});

	// The order on screen is the order of the work: providers, then ask them what
	// they offer, then name the ones you want.
	it("puts the proxy panel between the providers and the models", async () => {
		renderSection();
		await screen.findByDisplayValue("OpenRouter");
		const order = Array.from(document.querySelectorAll("table, button")).filter(
			(el) => el.tagName === "TABLE" || el.textContent === "catalog.refreshModels",
		);
		expect(order.map((el) => (el.tagName === "TABLE" ? "table" : "load"))).toEqual(["table", "load", "table"]);
	});

	it("says why a model cannot be added yet", async () => {
		vi.mocked(api.request.modelCatalogGet).mockResolvedValue({ providers: [], models: [] });
		renderSection();
		expect(await screen.findByText("catalog.addModelNeedsProvider")).toBeTruthy();
	});

	it("lays the providers and models out as tables with named columns", async () => {
		renderSection();
		await screen.findByDisplayValue("OpenRouter");
		expect(screen.getAllByRole("table")).toHaveLength(2);
		expect(screen.getByRole("columnheader", { name: "catalog.providerKind" })).toBeTruthy();
		expect(screen.getByRole("columnheader", { name: "catalog.modelId" })).toBeTruthy();
	});
});

describe("the live model list", () => {
	it("does not offer to load models when the build ships no proxy", async () => {
		vi.mocked(api.request.modelSidecarStatus).mockResolvedValue(status({ binaryAvailable: false }));
		renderSection();
		await screen.findByText("catalog.binaryMissing");
		expect(screen.getByRole("button", { name: "catalog.refreshModels" })).toHaveProperty("disabled", true);
	});

	// Two buttons that both started the proxy is what made the disabled one look
	// broken; starting it now has exactly one owner.
	it("does not offer to load models while the proxy is down, and says why", async () => {
		renderSection();
		expect(await screen.findByText("catalog.listNeedsProxy")).toBeTruthy();
		expect(screen.getByRole("button", { name: "catalog.refreshModels" })).toHaveProperty("disabled", true);
	});

	it("says how many ids it loaded, instead of rendering nothing on success", async () => {
		vi.mocked(api.request.modelSidecarStatus).mockResolvedValue(status({ running: true, port: 1 }));
		vi.mocked(api.request.modelCatalogListModels).mockResolvedValue({ models: ["openrouter/a", "openrouter/b"] });
		renderSection();
		await userEvent.click(await screen.findByRole("button", { name: "catalog.refreshModels" }));
		expect(await screen.findByText("catalog.listLoaded")).toBeTruthy();
	});

	it("says an empty listing is empty, rather than looking like a no-op", async () => {
		vi.mocked(api.request.modelSidecarStatus).mockResolvedValue(status({ running: true, port: 1 }));
		vi.mocked(api.request.modelCatalogListModels).mockResolvedValue({ models: [] });
		renderSection();
		await userEvent.click(await screen.findByRole("button", { name: "catalog.refreshModels" }));
		expect(await screen.findByText("catalog.listEmpty")).toBeTruthy();
	});

	it("never lets a failed listing look like an empty provider", async () => {
		vi.mocked(api.request.modelSidecarStatus).mockResolvedValue(status({ running: true, port: 1 }));
		vi.mocked(api.request.modelCatalogListModels).mockRejectedValue(new Error("proxy down"));
		renderSection();
		await userEvent.click(await screen.findByRole("button", { name: "catalog.refreshModels" }));
		expect(await screen.findByText("catalog.listUnavailable")).toBeTruthy();
	});
});
