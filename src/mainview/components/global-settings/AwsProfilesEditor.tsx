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
	const defaultIndex = defaultProfile ? rows.findIndex((row) => row.name === defaultProfile) : -1;
	const nameCount = new Map<string, number>();
	for (const row of rows) nameCount.set(row.name.trim(), (nameCount.get(row.name.trim()) ?? 0) + 1);
	// What the launch dialog will refuse to offer, said at the row instead of dropped silently.
	const rowProblem = (row: BedrockProfile) =>
		row.name.trim() && (nameCount.get(row.name.trim()) ?? 0) > 1
			? t("settings.awsProfileDuplicate")
			: row.name.trim() && !row.awsProfile.trim()
				? t("settings.awsProfileNeedsValue")
				: null;

	function updateRow(index: number, patch: Partial<BedrockProfile>) {
		const next = rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
		// A renamed default stays the default; a blank name is no default at all.
		const renamedDefault = patch.name !== undefined && index === defaultIndex;
		onChange({ profiles: next, ...(renamedDefault ? { defaultProfile: patch.name?.trim() ? patch.name : undefined } : {}) });
	}

	/** Names and values are matched exactly at launch, so stray spaces go on blur. */
	function trimRow(index: number) {
		const row = rows[index];
		const trimmed = { ...row, name: row.name.trim(), awsProfile: row.awsProfile.trim(), region: row.region?.trim() || undefined };
		if (trimmed.name === row.name && trimmed.awsProfile === row.awsProfile && trimmed.region === row.region) return;
		const next = rows.map((r, i) => (i === index ? trimmed : r));
		onChange({ profiles: next, ...(index === defaultIndex ? { defaultProfile: trimmed.name || undefined } : {}) });
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
					{rows.map((row, index) => {
						const problem = rowProblem(row);
						return (
						<div key={index} onBlur={() => trimRow(index)} className="grid grid-cols-[3.5rem_1fr_1.4fr_1fr_1.5rem] gap-2 items-center px-3 py-2 bg-base">
							<input
								type="radio"
								name="aws-profile-default"
								aria-label={t("settings.awsProfileDefaultFor", { name: row.name || "-" })}
								checked={index === defaultIndex}
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
								placeholder={t("settings.awsProfileRegionOptional")}
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
							{problem && (
								<p role="alert" className="col-span-full text-warning text-micro">{problem}</p>
							)}
						</div>
						);
					})}
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
