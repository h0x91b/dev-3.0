/**
 * RPC surface of the model catalog: read it, write it, and drive its proxy
 * sidecar. Credentials go in and never come back out — the renderer only ever
 * learns whether a provider has a key.
 */

import type { ModelCatalogView, ModelSidecarStatus } from "../../shared/types";
import { sidecarProviderKey, validateCatalog, type ModelCatalog } from "../../shared/model-catalog";
import { createLogger } from "../logger";
import {
	forgetProviderKeys,
	loadModelCatalog,
	loadProviderKeys,
	saveModelCatalog,
	setProviderKey,
} from "../model-catalog-store";
import {
	getModelSidecarStatus,
	ensureModelSidecar,
	listSidecarModels,
	restartModelSidecar,
	stopModelSidecar,
} from "../model-sidecar";

const log = createLogger("model-catalog");

function toView(catalog: ModelCatalog, keys: Record<string, string>): ModelCatalogView {
	return {
		providers: catalog.providers.map((p) => ({
			id: p.id,
			kind: p.kind,
			label: p.label,
			baseUrl: p.baseUrl,
			apiFormat: p.apiFormat,
			hasKey: Boolean(keys[p.id]),
		})),
		models: catalog.models.map((m) => ({ ...m })),
	};
}

function fromView(view: ModelCatalogView): ModelCatalog {
	return {
		providers: view.providers.map((p) => ({
			id: p.id,
			kind: p.kind,
			label: p.label,
			baseUrl: p.baseUrl,
			apiFormat: p.apiFormat,
		})),
		models: view.models.map((m) => ({ ...m })),
	};
}

export async function modelCatalogSave(params: {
	catalog: ModelCatalogView;
	providerKeys?: Record<string, string>;
}): Promise<ModelCatalogView> {
	const catalog = fromView(params.catalog);
	// The settings table blocks every one of these before its Save button lights
	// up, but the connect flow and the recommended-models prompt both write a
	// catalog without ever seeing that table. A bad one reaches the generated
	// config and fails at launch, far from where it was introduced.
	const issue = validateCatalog(catalog)[0];
	if (issue?.code === "duplicate-provider") {
		const provider = catalog.providers.find((p) => p.id === issue.providerId);
		const key = provider ? sidecarProviderKey(provider) : "this provider";
		throw new Error(`A provider already serves "${key}". Edit the existing one in Settings → API models instead of adding a second.`);
	}
	if (issue) {
		throw new Error(`This catalog cannot be saved (${issue.code}). Fix it in Settings → API models.`);
	}
	saveModelCatalog(catalog);
	for (const [providerId, key] of Object.entries(params.providerKeys ?? {})) {
		setProviderKey(providerId, key);
	}
	// A removed provider must not leave its key behind on disk.
	forgetProviderKeys(catalog.providers);

	// The sidecar reads its config once at startup, so edits need a fresh process.
	const status = getModelSidecarStatus();
	if (status.running || status.starting) {
		await restartModelSidecar().catch((err) => log.warn("Sidecar restart after save failed", { error: String(err) }));
	}
	return toView(catalog, loadProviderKeys());
}

export const modelCatalogHandlers = {
	modelCatalogGet: (): ModelCatalogView => toView(loadModelCatalog(), loadProviderKeys()),
	modelCatalogSave,
	modelSidecarStatus: (): ModelSidecarStatus => getModelSidecarStatus(),
	modelSidecarStart: async (): Promise<ModelSidecarStatus> => {
		await ensureModelSidecar();
		return getModelSidecarStatus();
	},
	modelSidecarStop: async (): Promise<ModelSidecarStatus> => {
		await stopModelSidecar();
		return getModelSidecarStatus();
	},
	modelCatalogListModels: async (params: { providerKey?: string }): Promise<{ models: string[] }> => ({
		models: await listSidecarModels(params?.providerKey),
	}),
};
