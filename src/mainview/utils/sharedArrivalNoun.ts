/** What a `cliShowImage` push says arrived; absent means images (`dev3 show-image`). */
export type SharedArrivalKind = "image" | "video" | "audio" | "media";

/** The i18n key base (`<base>.toast` / `<base>.attention`) that names a batch of new shared items. */
export function sharedArrivalNoun(kind: SharedArrivalKind | undefined): "showImage" | "showVideo" | "showAudio" | "showMedia" {
	if (kind === "video") return "showVideo";
	if (kind === "audio") return "showAudio";
	if (kind === "media") return "showMedia";
	return "showImage";
}
