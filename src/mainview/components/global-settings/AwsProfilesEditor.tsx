import type { BedrockProfile } from "../../../shared/types";
import type { TFunction } from "../../i18n";

const INPUT_CLASS =
	"min-w-0 px-2 py-1 bg-raised border border-edge rounded text-fg text-xs font-mono outline-none focus:border-accent/40 transition-colors";

/**
 * The named AWS profiles a Bedrock agent offers in the launch dialog. Each row
 * is a picker label plus the AWS_PROFILE / AWS_REGION values it injects; the
 * radio marks the entry a launch uses when nobody picked one.
 */
export default function AwsProfilesEditor({
	t,
	profiles,
	defaultProfile,
	onChange,
}: {
	t: TFunction;
	profiles: BedrockProfile[] | undefined;
	defaultProfile: string | undefined;
	onChange: (patch: { profiles?: BedrockProfile[]; defaultProfile?: string }) => void;
}) {
	const rows = profiles ?? [];

	function updateRow(index: number, patch: Partial<BedrockProfile>) {
		const prev = rows[index];
		const next = rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
		// A renamed default stays the default.
		const renamedDefault = patch.name !== undefined && prev.name === defaultProfile;
		onChange({ profiles: next, ...(renamedDefault ? { defaultProfile: patch.name } : {}) });
	}

	function removeRow(index: number) {
		const removed = rows[index];
		onChange({
			profiles: rows.filter((_, i) => i !== index),
			...(removed.name === defaultProfile ? { defaultProfile: undefined } : {}),
		});
	}

	return (
		<div data-testid="aws-profiles-editor">
			<span className="block text-fg-2 text-xs mb-1">{t("settings.awsProfiles")}</span>
			<p className="text-fg-3 text-xs mb-2">{t("settings.awsProfilesHint")}</p>
			{rows.length > 0 ? (
				<div className="rounded-lg border border-edge overflow-hidden divide-y divide-edge">
					<div className="grid grid-cols-[3.5rem_1fr_1.4fr_1fr_1.5rem] gap-2 px-3 py-1.5 bg-raised text-fg-3 text-micro">
						<span>{t("settings.awsProfileDefault")}</span>
						<span>{t("settings.awsProfileName")}</span>
						<span className="font-mono">AWS_PROFILE</span>
						<span className="font-mono">AWS_REGION</span>
						<span />
					</div>
					{rows.map((row, index) => (
						<div key={index} className="grid grid-cols-[3.5rem_1fr_1.4fr_1fr_1.5rem] gap-2 items-center px-3 py-2 bg-base">
							<input
								type="radio"
								name="aws-profile-default"
								aria-label={t("settings.awsProfileDefaultFor", { name: row.name || "-" })}
								checked={!!row.name && row.name === defaultProfile}
								disabled={!row.name.trim()}
								onChange={() => onChange({ defaultProfile: row.name })}
								onClick={() => {
									if (row.name === defaultProfile) onChange({ defaultProfile: undefined });
								}}
								className="accent-accent justify-self-start"
							/>
							<input
								className={INPUT_CLASS}
								value={row.name}
								aria-label={t("settings.awsProfileName")}
								placeholder="og"
								onChange={(e) => updateRow(index, { name: e.target.value })}
							/>
							<input
								className={INPUT_CLASS}
								value={row.awsProfile}
								aria-label="AWS_PROFILE"
								placeholder="og-aws-claude-code"
								onChange={(e) => updateRow(index, { awsProfile: e.target.value })}
							/>
							<input
								className={INPUT_CLASS}
								value={row.region ?? ""}
								aria-label="AWS_REGION"
								placeholder="us-west-2"
								onChange={(e) => updateRow(index, { region: e.target.value || undefined })}
							/>
							<button
								type="button"
								title={t("settings.awsProfileRemove")}
								aria-label={t("settings.awsProfileRemove")}
								onClick={() => removeRow(index)}
								className="text-fg-3 hover:text-danger text-sm leading-none transition-colors"
							>
								&times;
							</button>
						</div>
					))}
				</div>
			) : (
				<p className="text-fg-muted text-xs">{t("settings.awsProfilesEmpty")}</p>
			)}
			<button
				type="button"
				onClick={() => onChange({ profiles: [...rows, { name: "", awsProfile: "" }] })}
				className="mt-2 text-accent text-xs hover:text-accent-emphasis transition-colors"
			>
				+ {t("settings.awsProfileAdd")}
			</button>
		</div>
	);
}
