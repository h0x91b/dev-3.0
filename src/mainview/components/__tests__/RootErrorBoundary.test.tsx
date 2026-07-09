import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RootErrorBoundary from "../RootErrorBoundary";
import { __resetDiagnosticsForTests, getDiagnostics } from "../../diagnostics";

const logRendererError = vi.fn().mockResolvedValue(undefined);
vi.mock("../../rpc", () => ({
	isElectrobun: false,
	getRpcConnectionState: () => "connected",
	reconnectRpc: vi.fn(),
	api: { request: { logRendererError: (...a: unknown[]) => logRendererError(...a) } },
}));

function Boom(): never {
	throw new Error("kaboom");
}

beforeEach(() => {
	__resetDiagnosticsForTests();
	logRendererError.mockClear();
	// React logs caught boundary errors to console.error — silence the expected noise.
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("RootErrorBoundary", () => {
	it("renders children when there is no error", () => {
		render(
			<RootErrorBoundary>
				<div>healthy child</div>
			</RootErrorBoundary>,
		);
		expect(screen.getByText("healthy child")).toBeInTheDocument();
	});

	it("shows the fallback and the error message when a child throws", () => {
		render(
			<RootErrorBoundary>
				<Boom />
			</RootErrorBoundary>,
		);
		expect(screen.getByText("Something went wrong")).toBeInTheDocument();
		// "kaboom" appears both in the error block and in the recent-diagnostics list.
		expect(screen.getAllByText("kaboom").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByRole("button", { name: "Reload app" })).toBeInTheDocument();
	});

	it("records the crash into the diagnostics store", () => {
		render(
			<RootErrorBoundary>
				<Boom />
			</RootErrorBoundary>,
		);
		const entries = getDiagnostics();
		expect(entries.some((e) => e.kind === "react" && e.message === "kaboom")).toBe(true);
	});

	it("best-effort logs the crash to the backend", () => {
		render(
			<RootErrorBoundary>
				<Boom />
			</RootErrorBoundary>,
		);
		expect(logRendererError).toHaveBeenCalledWith(
			expect.objectContaining({ source: "error", description: expect.stringContaining("kaboom") }),
		);
	});

	it("copies a crash report on Copy details", async () => {
		const user = userEvent.setup();
		// Override AFTER userEvent.setup() — setup installs its own clipboard stub.
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		render(
			<RootErrorBoundary>
				<Boom />
			</RootErrorBoundary>,
		);
		await user.click(screen.getByRole("button", { name: "Copy details" }));
		expect(writeText).toHaveBeenCalledWith(expect.stringContaining("kaboom"));
	});
});
