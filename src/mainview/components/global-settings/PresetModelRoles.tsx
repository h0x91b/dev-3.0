import { useMemo } from "react";
import type { AgentConfiguration, ModelCatalogView } from "../../../shared/types";
import {
	modelRolesForAgent,
	orphanedRoleBindings,
	roleBindingWarnings,
} from "../../../shared/model-catalog";
import Select, { type SelectOption } from "../Select";
import type { TFunction } from "../../i18n";

/** Bind this preset to catalog models through the roles its own agent CLI
 *  exposes. Hidden when the agent has no roles or the catalog is empty. */
export default function PresetModelRoles({
	t,
	baseCommand,
	config,
	catalog,
	onChange,
}: {
	t: TFunction;
	baseCommand: string;
	config: AgentConfiguration;
	catalog: ModelCatalogView | null;
	onChange: (patch: Partial<AgentConfiguration>) => void;
}) {
	const roles = modelRolesForAgent(baseCommand);
	const bindings = config.modelRoles;

	const asCatalog = useMemo(
		() => ({ providers: catalog?.providers ?? [], models: catalog?.models ?? [] }),
		[catalog],
	);
	const warnings = roleBindingWarnings(baseCommand, bindings, asCatalog);
	const orphans = orphanedRoleBindings(bindings, asCatalog);

	if (roles.length === 0 || !catalog || catalog.models.length === 0) return null;

	const options: SelectOption[] = [
		{ value: "", label: t("catalog.roleUnassigned") },
		...catalog.models.map((model) => ({
			value: model.id,
			label: `${model.name} · ${catalog.providers.find((p) => p.id === model.providerId)?.label ?? "?"}`,
		})),
	];

	const setRole = (roleId: string, modelId: string) => {
		const next = { ...(bindings ?? {}) };
		if (modelId) next[roleId] = modelId;
		else delete next[roleId];
		onChange({ modelRoles: Object.keys(next).length > 0 ? next : undefined });
	};

	return (
		<div className="rounded-xl border border-edge bg-raised p-3 space-y-3">
			<div>
				<p className="text-fg text-sm font-semibold">{t("catalog.rolesTitle")}</p>
				<p className="text-fg-3 text-xs mt-0.5">{t("catalog.rolesHint")}</p>
			</div>

			<div className="grid gap-3 sm:grid-cols-2">
				{roles.map((role) => (
					<div key={role.id} className="min-w-0">
						<label htmlFor={`role-${role.id}`} className="block text-fg-2 text-xs font-semibold mb-1">
							{t(role.labelKey as Parameters<TFunction>[0])}
						</label>
						<Select
							id={`role-${role.id}`}
							value={bindings?.[role.id] ?? ""}
							options={options}
							onChange={(value) => setRole(role.id, value)}
						/>
						<span className="block text-fg-3 text-xs mt-1">{t(role.hintKey as Parameters<TFunction>[0])}</span>
					</div>
				))}
			</div>

			{orphans.length > 0 ? (
				<p className="text-danger text-xs">{t("catalog.roleOrphan", { roles: orphans.join(", ") })}</p>
			) : null}

			{warnings.length > 0 ? (
				<div className="rounded-lg border border-warning/30 bg-warning/10 p-2.5">
					<p className="text-warning text-xs font-semibold">{t("catalog.warnOpenRouterTitle")}</p>
					<p className="text-fg-2 text-xs leading-relaxed mt-0.5">{t("catalog.warnOpenRouterBody")}</p>
				</div>
			) : null}
		</div>
	);
}
