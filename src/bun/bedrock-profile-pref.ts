import type { LaunchVariant } from "../shared/types";
import * as data from "./data";
import { createLogger } from "./logger";

const log = createLogger("bedrock-profile-pref");

/** Remember a launch's explicit AWS profile pick for the project's next dialog.
 *  Best effort: a failed preference write never blocks a launch. */
export function rememberVariantBedrockProfile(projectId: string, variants: Pick<LaunchVariant, "bedrockProfile">[]): void {
	const picks = variants.map((v) => v.bedrockProfile);
	if (picks.every((pick) => pick === undefined)) return;
	void (async () => {
		try {
			await data.rememberBedrockProfile(projectId, picks);
		} catch (err) {
			log.warn("Failed to remember AWS profile pick (non-fatal)", { error: String(err) });
		}
	})();
}
