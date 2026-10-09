import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { api } from "../../rpc";
import { openFolderPicker } from "../../folder-picker";
import { toast } from "../../toast";

interface ArtifactTemplateFolderFieldProps {
	/** The stored folder; blank = the fallback named by `placeholderPath` or the default. */
	value: string;
	/** Shown when `value` is blank. Omit to show the default `~/.dev3.0` folder. */
	placeholderPath?: string;
	onChange: (path: string) => void;
	/** Names the project on the toast source line; settings otherwise. */
	projectId?: string;
}

/**
 * The "My template" folder: a path, a picker, and an Open button that first fills
 * an empty folder with a copy of the dev3 template, so there is always something
 * to start customizing from.
 */
export default function ArtifactTemplateFolderField({ value, placeholderPath, onChange, projectId }: ArtifactTemplateFolderFieldProps) {
	const t = useT();
	const [draft, setDraft] = useState(value);
	const [defaultPath, setDefaultPath] = useState("");

	useEffect(() => setDraft(value), [value]);
	useEffect(() => {
		api.request.prepareCustomArtifactTemplate({}).then((r) => setDefaultPath(r.path)).catch(() => {});
	}, []);

	const origin = projectId ? { projectId } : { source: "settings" as const };

	const commit = (next: string) => {
		const trimmed = next.trim();
		if (trimmed !== value.trim()) onChange(trimmed);
	};

	const browse = async () => {
		const picked = await openFolderPicker({ initialPath: draft || placeholderPath || defaultPath || null, allowCreateFolder: true });
		if (!picked) return;
		setDraft(picked);
		commit(picked);
	};

	const open = async () => {
		try {
			const result = await api.request.prepareCustomArtifactTemplate({ path: draft || placeholderPath || undefined, seed: true });
			if (result.seeded) toast.success(t("settings.artifactTemplateSeeded"), origin);
			await api.request.openFolder({ path: result.path });
		} catch (err) {
			toast.error(t("settings.artifactTemplateFolderError", { error: String(err) }), origin);
		}
	};

	return (
		<div className="space-y-2">
			<label htmlFor="artifact-template-folder" className="block text-fg-2 text-sm">
				{t("settings.artifactTemplateFolder")}
			</label>
			<div className="flex flex-col gap-2 sm:flex-row">
				<input
					id="artifact-template-folder"
					type="text"
					value={draft}
					placeholder={placeholderPath || defaultPath}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={() => commit(draft)}
					onKeyDown={(e) => {
						if (e.key === "Enter") commit(draft);
					}}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					className="streamer-private min-w-0 flex-1 px-3 py-2 bg-raised border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
				/>
				<div className="flex gap-2">
					<button
						type="button"
						onClick={() => void browse()}
						className="px-3 py-2 bg-raised border border-edge rounded-lg text-fg-2 text-sm hover:border-edge-active hover:text-fg transition-colors"
					>
						{t("settings.artifactTemplateBrowse")}
					</button>
					<button
						type="button"
						onClick={() => void open()}
						className="px-3 py-2 bg-raised border border-edge rounded-lg text-fg-2 text-sm hover:border-edge-active hover:text-fg transition-colors"
					>
						{t("settings.artifactTemplateOpenFolder")}
					</button>
				</div>
			</div>
			<p className="text-fg-3 text-xs">{t("settings.artifactTemplateFolderHint")}</p>
		</div>
	);
}
