import { fireEvent, render, screen } from "@testing-library/react";
import BoardLoadFailed from "../BoardLoadFailed";
import { hasLoadedExtensions, restartWithExtensionsOff } from "../../board-views/plugins";

vi.mock("../../board-views/plugins", () => ({
	hasLoadedExtensions: vi.fn(() => false),
	restartWithExtensionsOff: vi.fn(async () => {}),
}));
vi.mock("../../hooks/useDiagnostics", () => ({ useRpcStatus: () => "connected" }));
vi.mock("../../i18n", () => ({ useT: () => ((key: string) => key) }));

describe("BoardLoadFailed — extensions escape", () => {
	it("offers no extension escape while no third-party code runs", () => {
		render(<BoardLoadFailed onRetry={vi.fn()} />);
		expect(screen.queryByTestId("restart-without-extensions")).not.toBeInTheDocument();
	});

	it("offers Restart with extensions off when an extension may be the cause", () => {
		vi.mocked(hasLoadedExtensions).mockReturnValue(true);
		render(<BoardLoadFailed onRetry={vi.fn()} />);
		fireEvent.click(screen.getByTestId("restart-without-extensions"));
		expect(restartWithExtensionsOff).toHaveBeenCalledTimes(1);
	});
});
