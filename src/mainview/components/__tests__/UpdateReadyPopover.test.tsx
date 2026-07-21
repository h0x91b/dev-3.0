import { render, screen } from "@testing-library/react";
import UpdateReadyPopover from "../UpdateReadyPopover";
import { I18nProvider } from "../../i18n";
import type { UpdateChangelog } from "../../../shared/types";

const CHANGELOG: UpdateChangelog = { features: ["A", "B"], featureCount: 2, fixCount: 1 };

function renderPopover(preview: boolean) {
	return render(
		<I18nProvider>
			<UpdateReadyPopover
				version="1.2.3"
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

	it("preview mimics the toast: static-countdown Restart + disabled Postpone", () => {
		renderPopover(true);
		const restart = screen.getByRole("button", { name: /Restart to Update \(205s\)/ });
		expect((restart as HTMLButtonElement).disabled).toBe(true);
		const postpone = screen.getByRole("button", { name: "Postpone" });
		expect((postpone as HTMLButtonElement).disabled).toBe(true);
	});
});
