import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Context } from "cordis";
import { I18nProvider } from "../../i18n";
import { getAppRoot } from "../../plugins/root";
import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import { BUILTIN_DESTINATION_BODIES, BUILTIN_DESTINATION_BODIES_PLUGIN } from "../builtins";
import { DestinationBody } from "../DestinationBody";
import { DestinationPropsContext, useDestinationProps } from "../props";
import { getDestinationBodyRegistry, type DestinationBodyProps, type DestinationId } from "../registry";

vi.mock("../../rpc", () => ({ api: { request: {} } }));

// Each stand-in prints the host's data props and exposes its callbacks as buttons, so a test sees the wiring.
function standIn(testId: string) {
	return {
		default: (props: Record<string, unknown>) => (
			<div data-testid={testId}>
				<span data-testid={`${testId}-data`}>
					{JSON.stringify(Object.fromEntries(Object.entries(props).filter(([, value]) => typeof value !== "function")))}
				</span>
				{Object.entries(props)
					.filter(([, value]) => typeof value === "function")
					.map(([name, fn]) => (
						<button key={name} type="button" onClick={() => (fn as (...args: unknown[]) => void)("arg")}>
							{name}
						</button>
					))}
			</div>
		),
	};
}
vi.mock("../../components/SessionsScreen", () => standIn("body-sessions"));
vi.mock("../../components/ProductivityStatsView", () => standIn("body-stats"));
vi.mock("../../components/Changelog", () => standIn("body-changelog"));
vi.mock("../../components/agent-traffic/AgentTrafficScreen", () => standIn("body-agent-traffic"));

type Case<D extends DestinationId> = { data: Record<string, unknown>; props: (spy: () => void) => DestinationBodyProps[D] };

const CASES: { [D in DestinationId]: Case<D> } = {
	sessions: {
		data: { projectId: "p1", projectName: "dev-3.0" },
		props: (spy) => ({ projectId: "p1", projectName: "dev-3.0", onOpenTask: spy }),
	},
	stats: { data: { canGoBack: true }, props: (spy) => ({ navigate: spy, goBack: spy, canGoBack: true }) },
	changelog: { data: { canGoBack: false }, props: (spy) => ({ navigate: spy, goBack: spy, canGoBack: false }) },
	"agent-traffic": {
		data: { projectId: null, focus: { taskId: "t1", projectId: "p1" } },
		props: (spy) => ({ projectId: null, focus: { taskId: "t1", projectId: "p1" }, onOpenTask: spy }),
	},
};
const DESTINATIONS = Object.keys(CASES) as DestinationId[];

async function settle(): Promise<void> {
	for (let tick = 0; tick < 50; tick++) await act(async () => {});
}

function renderBody(destination: DestinationId, spy: () => void = () => {}) {
	const props = CASES[destination].props(spy);
	return render(
		<I18nProvider>
			<DestinationBody destination={destination} props={props as never} />
		</I18nProvider>,
	);
}

beforeEach(() => resetPluginsForTests());

describe("DestinationBody", () => {
	it("registers exactly one built-in body per destination", async () => {
		applyBuiltinPlugins([], [BUILTIN_DESTINATION_BODIES_PLUGIN]);
		await settle();
		for (const destination of DESTINATIONS) {
			expect(getDestinationBodyRegistry().listRegion(destination).map((entry) => entry.def.id)).toEqual([`builtin:${destination}`]);
		}
	});

	it.each(DESTINATIONS)("draws the %s body from the slot with the host's props and callbacks", async (destination) => {
		applyBuiltinPlugins([], [BUILTIN_DESTINATION_BODIES_PLUGIN]);
		await settle();
		const spy = vi.fn();
		renderBody(destination, spy);
		expect(JSON.parse(screen.getByTestId(`body-${destination}-data`).textContent ?? "")).toEqual(CASES[destination].data);
		const callbacks = screen.getByTestId(`body-${destination}`).querySelectorAll("button");
		expect(callbacks.length).toBeGreaterThan(0);
		callbacks.forEach((button) => fireEvent.click(button));
		expect(spy).toHaveBeenCalledTimes(callbacks.length);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it.each(DESTINATIONS)("draws the %s built-in before any body has registered", (destination) => {
		renderBody(destination);
		expect(screen.getByTestId(`body-${destination}`)).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it.each(DESTINATIONS)("falls back to the %s built-in under the inline notice when the slot's body throws", async (destination) => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const Boom = () => {
			throw new Error("boom");
		};
		getAppRoot().plugin({
			name: "throwing-body",
			inject: ["destinationBodies"],
			apply(ctx: Context) {
				ctx.destinationBodies.register({ id: BUILTIN_DESTINATION_BODIES[destination].id, region: destination, component: Boom });
			},
		});
		await settle();
		renderBody(destination);
		expect(screen.getByRole("alert").textContent).toBe("This screen failed to load, so the built-in one is shown.");
		expect(JSON.parse(screen.getByTestId(`body-${destination}-data`).textContent ?? "")).toEqual(CASES[destination].data);
		errors.mockRestore();
	});

	it("refuses a body that asks for another destination's props, or renders outside any host", () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const WrongBody = () => <div>{String(useDestinationProps("sessions"))}</div>;
		expect(() =>
			render(
				<DestinationPropsContext.Provider value={{ destination: "stats", props: {} }}>
					<WrongBody />
				</DestinationPropsContext.Provider>,
			),
		).toThrow("sessions body rendered inside the stats <DestinationBody>");
		expect(() => render(<WrongBody />)).toThrow("sessions body rendered outside any <DestinationBody>");
		errors.mockRestore();
	});
});
