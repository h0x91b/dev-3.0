import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { _resetCompletionOffersForTests, offerCompletion, setCompletionOfferStyle } from "../../completion-offers";
import CompletionOfferMark from "../CompletionOfferMark";

function renderMark() {
	return render(<I18nProvider><CompletionOfferMark task={{ id: "t1" }} testId="mark" /></I18nProvider>);
}

async function offerAgent() {
	await act(async () => { void offerCompletion({ taskId: "t1", projectId: "p1", kind: "agent" }); });
}

afterEach(() => _resetCompletionOffersForTests());

describe("CompletionOfferMark", () => {
	it("shows no marker on the default dialog style", async () => {
		renderMark();
		await offerAgent();
		expect(screen.queryByTestId("mark")).not.toBeInTheDocument();
	});

	it("marks a task whose offer waits on it, on the inline style", async () => {
		setCompletionOfferStyle("inline");
		renderMark();
		await offerAgent();
		expect(screen.getByTestId("mark")).toHaveAttribute("data-kinds", "agent");
	});

	it("keeps marking an offer a switch to Dialog left on its task", async () => {
		setCompletionOfferStyle("inline");
		renderMark();
		await offerAgent();
		await act(async () => { setCompletionOfferStyle("dialog"); });
		expect(screen.getByTestId("mark")).toBeInTheDocument();
	});
});
