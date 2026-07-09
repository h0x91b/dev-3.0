import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BootstrapScreen from "../BootstrapScreen";
import { I18nProvider } from "../../i18n";
import { __resetDiagnosticsForTests, recordError } from "../../diagnostics";

function renderScreen(props: Partial<Parameters<typeof BootstrapScreen>[0]> = {}) {
	const onRetry = props.onRetry ?? vi.fn();
	render(
		<I18nProvider>
			<BootstrapScreen phase={props.phase ?? "connecting"} onRetry={onRetry} stuckAfterMs={props.stuckAfterMs ?? 20} />
		</I18nProvider>,
	);
	return { onRetry };
}

beforeEach(() => {
	__resetDiagnosticsForTests();
});

describe("BootstrapScreen", () => {
	it("shows the current phase label while loading", () => {
		renderScreen({ phase: "checking", stuckAfterMs: 100000 });
		expect(screen.getByText("Checking system…")).toBeInTheDocument();
	});

	it("names the connecting phase for a remote connection", () => {
		renderScreen({ phase: "connecting", stuckAfterMs: 100000 });
		expect(screen.getByText("Connecting to your computer…")).toBeInTheDocument();
	});

	it("flips to an actionable stuck panel after the timeout", async () => {
		renderScreen({ phase: "connecting", stuckAfterMs: 10 });
		expect(await screen.findByText("This is taking longer than usual")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
	});

	it("shows a connection-specific explanation for connection phases", async () => {
		renderScreen({ phase: "connecting", stuckAfterMs: 10 });
		expect(await screen.findByText(/can't reach your computer/i)).toBeInTheDocument();
	});

	it("surfaces the last captured error in the stuck panel", async () => {
		recordError("RPC \"getProjects\" timed out");
		renderScreen({ phase: "loading", stuckAfterMs: 10 });
		expect(await screen.findByText(/getProjects.*timed out/)).toBeInTheDocument();
	});

	it("calls onRetry when Retry is clicked", async () => {
		const user = userEvent.setup();
		const { onRetry } = renderScreen({ phase: "connecting", stuckAfterMs: 10 });
		const retry = await screen.findByRole("button", { name: "Retry" });
		await user.click(retry);
		expect(onRetry).toHaveBeenCalledTimes(1);
	});
});
