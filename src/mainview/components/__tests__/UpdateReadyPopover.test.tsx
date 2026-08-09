import { render, screen } from "@testing-library/react";
import UpdateReadyPopover from "../UpdateReadyPopover";
import { I18nProvider } from "../../i18n";
import type { UpdateChangelog } from "../../../shared/types";

const CHANGELOG: UpdateChangelog = { features: ["A", "B"], featureCount: 2, fixCount: 1 };

function renderPopover(preview: boolean, version = "1.2.3") {
	return render(
		<I18nProvider>
			<UpdateReadyPopover
				version={version}
				changelog={CHANGELOG}
				restarting={false}
				onRestart={() => {}}
				onSeeAllChanges={() => {}}
				preview={preview}
			/>
		</I18nProvider>,
	);
}

describe("UpdateReadyPopover", () => {
	it("real popover (non-preview) shows only a functional Restart, no Postpone", () => {
		renderPopover(false);
		const restart = screen.getByRole("button", { name: "Restart to Update" });
		expect((restart as HTMLButtonElement).disabled).toBe(false);
		expect(screen.queryByRole("button", { name: "Postpone" })).toBeNull();
	});

	// THE BUG A USER ACTUALLY HIT: switch to canary, get offered a build off main, and the
	// popover calls it the stable release by name — "v1.42.3 ready to install", "what's new
	// in v1.42.3". The channel is read off the offered version string, because during a
	// crossing the LOCAL channel is the one being left and would answer the wrong question.
	it("names the canary channel and the commit, without the suffix leaking into the copy", () => {
		renderPopover(false, "1.42.3+canary.a0981f55");
		expect(
			screen.getByText(/v1\.42\.3 ready to install/),
			"the title must name the release cleanly. Rendering the raw `v1.42.3+canary.a0981f55 ready to install` reads as a typo, and dropping the suffix without a badge is the original defect: a build off main wearing a stable release's name.",
		).toBeInTheDocument();
		expect(screen.getByText("Canary")).toBeInTheDocument();
		expect(
			screen.getByText("a0981f55"),
			"the short commit is the ONLY thing telling two canary builds apart — they all report the last release's version — so it cannot be dropped for tidiness.",
		).toBeInTheDocument();
		expect(
			screen.getByText("What's new since v1.42.3"),
			"on canary the heading must say SINCE. The changelog payload is the window after the previous release tag, so on a build off main those features are exactly the ones NOT in v1.42.3 — `What's new in v1.42.3` states the opposite of the truth.",
		).toBeInTheDocument();
	});

	it("adds nothing at all for a stable offer", () => {
		renderPopover(false);
		expect(
			screen.queryByText("Canary"),
			"a stable offer must render exactly as it did before this feature. A badge that shows for everyone is the wall-of-badges the UX bible bans, and it would also be a lie.",
		).toBeNull();
	});

	it("preview mimics the toast: static-countdown Restart + disabled Postpone", () => {
		renderPopover(true);
		const restart = screen.getByRole("button", { name: /Restart to Update \(205s\)/ });
		expect((restart as HTMLButtonElement).disabled).toBe(true);
		const postpone = screen.getByRole("button", { name: "Postpone" });
		expect((postpone as HTMLButtonElement).disabled).toBe(true);
	});
});
