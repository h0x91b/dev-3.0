import { render, screen } from "@testing-library/react";
import type { Task } from "../../shared/types";
import { I18nProvider } from "../i18n";
import ForeignCodeMark from "../components/ForeignCodeMark";

function renderMark(task: Pick<Task, "foreignCode">) {
	return render(
		<I18nProvider>
			<ForeignCodeMark task={task} />
		</I18nProvider>,
	);
}

describe("ForeignCodeMark", () => {
	it("renders for a task about someone else's code", () => {
		renderMark({ foreignCode: true });
		expect(screen.getByTestId("foreign-code-mark")).toBeTruthy();
	});

	// The dense surfaces stay quiet: absent (every pre-existing task) and an
	// explicit false both render nothing at all.
	it("renders nothing when the flag is absent or cleared", () => {
		const absent = renderMark({});
		expect(absent.queryByTestId("foreign-code-mark")).toBeNull();
		absent.unmount();

		const cleared = renderMark({ foreignCode: false });
		expect(cleared.queryByTestId("foreign-code-mark")).toBeNull();
	});

	// Never colour-only — a glyph in a row of glyphs needs a name a screen reader
	// and a tooltip can both read.
	it("carries an accessible name, not just a colour", () => {
		renderMark({ foreignCode: true });
		const mark = screen.getByTestId("foreign-code-mark");
		expect(mark.getAttribute("role")).toBe("img");
		expect(mark.getAttribute("aria-label")).toBeTruthy();
	});
});
