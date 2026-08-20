export const ARTIFACT_TEMPLATE_VERSION = 1;

export const ARTIFACT_TEMPLATE_FILES = [
	"AUTHORING.md",
	"index.html",
	"report.js",
	"app.css",
	"app.js",
	"dev3-icon.png",
] as const;

/** Directory name of the per-task starter, versioned so a new bundle never edits an old copy. */
export function artifactTemplateDirName(): string {
	return `artifact-template-v${ARTIFACT_TEMPLATE_VERSION}`;
}
