import { render, screen } from "@testing-library/react";
import NativeBackendMark, { isNativeBackendTask } from "../NativeBackendMark";
import { I18nProvider } from "../../i18n";
import type { Task } from "../../../shared/types";

function renderMark(task: Pick<Task, "terminalBackend">) {
	return render(
		<I18nProvider>
			<NativeBackendMark task={task} />
		</I18nProvider>,
	);
}

describe("NativeBackendMark", () => {
	it("marks a task whose record explicitly carries the native identity", () => {
		renderMark({ terminalBackend: "native" });

		const mark = screen.getByTestId("native-backend-mark");
		expect(mark).toHaveAttribute("aria-label", "Native terminal backend");
		expect(mark).toHaveAttribute("role", "img");
	});

	it("renders nothing for an explicit tmux task", () => {
		renderMark({ terminalBackend: "tmux" });

		expect(screen.queryByTestId("native-backend-mark")).toBeNull();
	});

	it("renders nothing for a legacy record with no identity field", () => {
		renderMark({});

		expect(screen.queryByTestId("native-backend-mark")).toBeNull();
	});

	it("refuses to guess when the persisted value is not a known identity", () => {
		renderMark({ terminalBackend: "wat" as unknown as Task["terminalBackend"] });

		expect(screen.queryByTestId("native-backend-mark")).toBeNull();
	});

	it("carries a caller-supplied test id so each surface is addressable", () => {
		render(
			<I18nProvider>
				<NativeBackendMark task={{ terminalBackend: "native" }} testId="surface-mark" />
			</I18nProvider>,
		);

		expect(screen.getByTestId("surface-mark")).toBeInTheDocument();
	});
});

describe("isNativeBackendTask", () => {
	it("is true only for the explicit native identity", () => {
		expect(isNativeBackendTask({ terminalBackend: "native" })).toBe(true);
		expect(isNativeBackendTask({ terminalBackend: "tmux" })).toBe(false);
		expect(isNativeBackendTask({})).toBe(false);
	});
});
