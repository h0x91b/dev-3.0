import { act, render, screen } from "@testing-library/react";
import type { Context } from "cordis";
import { I18nProvider } from "../../i18n";
import { getAppRoot } from "../../plugins/root";
import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import { BUILTIN_DESTINATION_BODIES, BUILTIN_DESTINATION_BODIES_PLUGIN } from "../builtins";
import { DestinationBody } from "../DestinationBody";
import { getDestinationBodyRegistry, type DestinationBodyProps } from "../registry";

vi.mock("../../rpc", () => ({ api: { request: {} } }));
vi.mock("../../components/SessionsScreen", () => ({
	default: ({ projectId, projectName }: DestinationBodyProps["sessions"]) => (
		<div data-testid="sessions-screen">{`${projectId}/${projectName}`}</div>
	),
}));

const SESSIONS_PROPS: DestinationBodyProps["sessions"] = { projectId: "p1", projectName: "dev-3.0", onOpenTask: () => {} };

async function settle(): Promise<void> {
	for (let tick = 0; tick < 50; tick++) await act(async () => {});
}

function renderSessions() {
	return render(
		<I18nProvider>
			<DestinationBody destination="sessions" props={SESSIONS_PROPS} />
		</I18nProvider>,
	);
}

beforeEach(() => resetPluginsForTests());

describe("DestinationBody", () => {
	it("draws the sessions body from the slot with the host's props, without a notice", async () => {
		applyBuiltinPlugins([], [BUILTIN_DESTINATION_BODIES_PLUGIN]);
		await settle();
		expect(getDestinationBodyRegistry().listRegion("sessions").map((entry) => entry.def.id)).toEqual(["builtin:sessions"]);
		renderSessions();
		expect(screen.getByTestId("sessions-screen").textContent).toBe("p1/dev-3.0");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("draws the built-in before any body has registered", () => {
		renderSessions();
		expect(screen.getByTestId("sessions-screen")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("falls back to the built-in under the inline notice when the slot's body throws", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const Boom = () => {
			throw new Error("boom");
		};
		getAppRoot().plugin({
			name: "throwing-body",
			inject: ["destinationBodies"],
			apply(ctx: Context) {
				ctx.destinationBodies.register({ id: BUILTIN_DESTINATION_BODIES.sessions.id, region: "sessions", component: Boom });
			},
		});
		await settle();
		renderSessions();
		expect(screen.getByRole("alert").textContent).toBe("This screen failed to load, so the built-in one is shown.");
		expect(screen.getByTestId("sessions-screen").textContent).toBe("p1/dev-3.0");
		errors.mockRestore();
	});
});
