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

function renderChangelog(props: { goBack?: () => void; canGoBack?: boolean } = {}) {
	return render(
		<I18nProvider>
			<Changelog navigate={vi.fn()} goBack={props.goBack ?? vi.fn()} canGoBack={props.canGoBack ?? false} />
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

		// Each date group is a <section>; its rail carries the formatted date.
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

	it("shows the authored short title as a feature headline", async () => {
		const entries: ChangelogEntry[] = [
			{
				date: "2026-02-26",
				type: "feature",
				slug: "f",
				title: "A long first sentence describing the feature.",
				short: "Snappy headline",
			},
		];
		mockedApi.request.getChangelogs.mockResolvedValue(entries);
		renderChangelog();

		await screen.findByText("Snappy headline");
		expect(screen.getByText(/long first sentence/)).toBeInTheDocument();
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
		// Filter chips render for each present type with a count; click the "fix" chip.
		await user.click(screen.getByRole("button", { name: /^fix\b/ }));
		expect(screen.queryByText("A feature entry")).not.toBeInTheDocument();
		expect(screen.getByText("A fix entry")).toBeInTheDocument();
	});

	it("supports multi-select type filters", async () => {
		const user = userEvent.setup();
		const entries: ChangelogEntry[] = [
			{ date: "2026-02-26", type: "feature", slug: "a", title: "A feature entry" },
			{ date: "2026-02-26", type: "fix", slug: "b", title: "A fix entry" },
			{ date: "2026-02-26", type: "chore", slug: "c", title: "A chore entry" },
		];
		mockedApi.request.getChangelogs.mockResolvedValue(entries);
		renderChangelog();

		await screen.findByText("A feature entry");
		await user.click(screen.getByRole("button", { name: /^feature\b/ }));
		await user.click(screen.getByRole("button", { name: /^fix\b/ }));
		expect(screen.getByText("A feature entry")).toBeInTheDocument();
		expect(screen.getByText("A fix entry")).toBeInTheDocument();
		expect(screen.queryByText("A chore entry")).not.toBeInTheDocument();
	});

	it("filters entries with the search box", async () => {
		const user = userEvent.setup();
		const entries: ChangelogEntry[] = [
			{ date: "2026-02-26", type: "feature", slug: "a", title: "Alpha thing shipped" },
			{ date: "2026-02-25", type: "feature", slug: "b", title: "Beta thing shipped" },
		];
		mockedApi.request.getChangelogs.mockResolvedValue(entries);
		renderChangelog();

		await screen.findByText("Alpha thing shipped");
		await user.type(screen.getByPlaceholderText("Search changelog…"), "alpha");
		expect(screen.getByText("Alpha thing shipped")).toBeInTheDocument();
		expect(screen.queryByText("Beta thing shipped")).not.toBeInTheDocument();
	});

	it("shows a no-results state whose reset button restores all entries", async () => {
		const user = userEvent.setup();
		const entries: ChangelogEntry[] = [
			{ date: "2026-02-26", type: "feature", slug: "a", title: "Alpha thing shipped" },
		];
		mockedApi.request.getChangelogs.mockResolvedValue(entries);
		renderChangelog();

		await screen.findByText("Alpha thing shipped");
		await user.type(screen.getByPlaceholderText("Search changelog…"), "zzz");
		expect(screen.queryByText("Alpha thing shipped")).not.toBeInTheDocument();
		expect(screen.getByText("Nothing matches your search or filters.")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Reset filters" }));
		expect(screen.getByText("Alpha thing shipped")).toBeInTheDocument();
	});

	it("renders day groups incrementally with a Show more control", async () => {
		const user = userEvent.setup();
		// 20 distinct days — more than the initial batch of 15.
		const entries: ChangelogEntry[] = Array.from({ length: 20 }, (_, i) => ({
			date: `2026-01-${String(i + 1).padStart(2, "0")}`,
			type: "fix",
			slug: `s${i + 1}`,
			title: `Entry ${i + 1}`,
		}));
		mockedApi.request.getChangelogs.mockResolvedValue(entries);
		renderChangelog();

		// Newest day (Jan 20) is in the first batch; oldest (Jan 1) is not.
		await screen.findByText("Entry 20");
		expect(screen.queryByText("Entry 1")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Show more" }));
		expect(screen.getByText("Entry 1")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
	});

	it("stages Escape: clears the search first, then navigates back", async () => {
		const user = userEvent.setup();
		const goBack = vi.fn();
		const entries: ChangelogEntry[] = [
			{ date: "2026-02-26", type: "feature", slug: "a", title: "Alpha thing shipped" },
		];
		mockedApi.request.getChangelogs.mockResolvedValue(entries);
		renderChangelog({ goBack, canGoBack: true });

		await screen.findByText("Alpha thing shipped");
		const input = screen.getByPlaceholderText("Search changelog…");
		await user.type(input, "alpha");

		await user.keyboard("{Escape}");
		expect(input).toHaveValue("");
		expect(goBack).not.toHaveBeenCalled();

		await user.keyboard("{Escape}");
		expect(goBack).toHaveBeenCalledTimes(1);
	});
});
