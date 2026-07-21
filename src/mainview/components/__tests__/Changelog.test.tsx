import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

		const { container } = renderChangelog();

		await screen.findByText("Fix on 26th");

		// Each date group is a <section>; its left column carries the formatted date.
		const sections = container.querySelectorAll("section");
		expect(sections).toHaveLength(3);
		const dateTexts = [...sections].map((s) => s.textContent ?? "");
		expect(dateTexts[0]).toContain("26");
		expect(dateTexts[1]).toContain("25");
		expect(dateTexts[2]).toContain("24");
	});

	it("expands an entry with a body to reveal the full text", async () => {
		const user = userEvent.setup();
		const entries: ChangelogEntry[] = [
			{
				date: "2026-02-26",
				type: "feature",
				slug: "f",
				title: "Short teaser",
				body: "Short teaser. And the full detailed body text here.",
			},
		];
		mockedApi.request.getChangelogs.mockResolvedValue(entries);
		renderChangelog();

		await screen.findByText("Short teaser");
		expect(screen.queryByText(/full detailed body/)).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /Short teaser/ }));
		expect(screen.getByText(/full detailed body/)).toBeInTheDocument();

		// Collapses again on second click.
		await user.click(screen.getByRole("button", { name: /Short teaser/ }));
		expect(screen.queryByText(/full detailed body/)).not.toBeInTheDocument();
	});

	it("does not make an entry without a body clickable", async () => {
		const entries: ChangelogEntry[] = [
			{ date: "2026-02-26", type: "fix", slug: "x", title: "Just a one-liner" },
		];
		mockedApi.request.getChangelogs.mockResolvedValue(entries);
		renderChangelog();

		await screen.findByText("Just a one-liner");
		expect(screen.queryByRole("button", { name: /Just a one-liner/ })).not.toBeInTheDocument();
	});

	it("filters entries by type", async () => {
		const user = userEvent.setup();
		const entries: ChangelogEntry[] = [
			{ date: "2026-02-26", type: "feature", slug: "a", title: "A feature entry" },
			{ date: "2026-02-26", type: "fix", slug: "b", title: "A fix entry" },
		];
		mockedApi.request.getChangelogs.mockResolvedValue(entries);
		renderChangelog();

		await screen.findByText("A feature entry");
		// Filter chips render for each present type; click the "fix" filter.
		await user.click(screen.getByRole("button", { name: "fix" }));
		expect(screen.queryByText("A feature entry")).not.toBeInTheDocument();
		expect(screen.getByText("A fix entry")).toBeInTheDocument();
	});
});
