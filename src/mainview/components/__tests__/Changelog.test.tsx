import { render, screen } from "@testing-library/react";
import Changelog from "../Changelog";
import { I18nProvider } from "../../i18n";
import type { ChangelogEntry } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getChangelogs: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";

const mockedApi = vi.mocked(api, true);

function renderChangelog() {
	return render(
		<I18nProvider>
			<Changelog navigate={vi.fn()} goBack={vi.fn()} canGoBack={false} />
		</I18nProvider>,
	);
}

describe("Changelog", () => {
	it("sorts date groups in descending order even when type sort reorders entries", async () => {
		// Feb 25 has only a "fix" entry, Feb 24 has a "feature" entry, Feb 26 has a "fix" entry.
		// After type-based sort, "feature" (24th) would come before "fix" (25th, 26th),
		// causing Map insertion order to put Feb 24 first — breaking date order.
		const entries: ChangelogEntry[] = [
			{ date: "2026-02-26", type: "fix", slug: "fix-26", title: "Fix on 26th" },
			{ date: "2026-02-25", type: "fix", slug: "fix-25", title: "Fix on 25th" },
			{ date: "2026-02-24", type: "feature", slug: "feat-24", title: "Feature on 24th" },
		];

		mockedApi.request.getChangelogs.mockResolvedValue(entries);

		renderChangelog();

		// Wait for entries to load
		await screen.findByText("Fix on 26th");

		// Get all date headings — they should be in descending order
		const headings = screen.getAllByRole("heading", { level: 3 });
		const headingTexts = headings.map((h) => h.textContent);

		// Verify order: Feb 26 → Feb 25 → Feb 24 (descending)
		expect(headingTexts).toHaveLength(3);
		expect(headingTexts[0]).toContain("26");
		expect(headingTexts[1]).toContain("25");
		expect(headingTexts[2]).toContain("24");
	});
});
