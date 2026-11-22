import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Fiber } from "cordis";
import { I18nProvider } from "../../i18n";
import GoToPalette, { type GoToMode } from "../../components/GoToPalette";
import type { Project } from "../../../shared/types";
import { getAppRoot } from "../../plugins/root";
import { getGoToSourceRegistry, type GoToSourceItem } from "../registry";
import { installGoToSourceBuiltins } from "./install-builtins";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAgents: vi.fn(() => Promise.resolve([])),
			getSpaces: vi.fn(() => Promise.resolve({ version: 1, spaces: [], order: [] })),
			getAllProjectTasks: vi.fn(() => Promise.resolve([])),
			getTaskLineage: vi.fn(() => Promise.resolve({ nodes: [] })),
			getEpics: vi.fn(() => Promise.resolve({ version: 1, epics: [] })),
		},
	},
}));

const project = (id: string, name: string): Project => ({ id, name, path: `/tmp/${id}`, setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" }) as Project;
const PROJECTS = [project("p1", "users-service"), project("p2", "auth-gateway")];

function renderPalette(mode: GoToMode = "project", onSelectProject = vi.fn()) {
	return render(
		<I18nProvider>
			<GoToPalette
				mode={mode}
				onModeChange={() => {}}
				projects={PROJECTS}
				projectById={new Map(PROJECTS.map((p) => [p.id, p]))}
				taskPorts={new Map()}
				onSelectProject={onSelectProject}
				onSelectSpace={vi.fn()}
				onSelectTask={vi.fn()}
				onClose={vi.fn()}
			/>
		</I18nProvider>,
	);
}

const options = () => screen.queryAllByRole("option").map((o) => o.textContent);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function contribute(source: GoToSourceItem<string>): Promise<Fiber> {
	const fiber = getAppRoot().plugin({ name: "acme", inject: ["goToSources"], apply: (ctx) => void ctx.goToSources.register(source) });
	await settle();
	return fiber;
}

const acme = (extra: Partial<GoToSourceItem<string>> = {}): GoToSourceItem<string> => ({
	id: "acme:docs",
	order: 40,
	modes: ["project", "combined"],
	rows: () => [{ id: "acme:readme", text: "Acme readme", value: "readme" }],
	matches: (row, query) => query.free === "" || row.text.toLowerCase().includes(query.free),
	right: () => <span data-testid="acme-right">docs</span>,
	select: vi.fn(),
	...extra,
});

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
	await installGoToSourceBuiltins();
	localStorage.clear();
	errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errors.mockRestore());

describe("goToSources slot", () => {
	it("is a contribution slot with dev3's three sources in merge order", () => {
		const registry = getGoToSourceRegistry();
		expect(registry.kind).toBe("contribute");
		expect(registry.list().map(({ def }) => [def.id, def.modes])).toEqual([
			["builtin:projects", ["project", "combined"]],
			["builtin:tasks", ["task", "combined"]],
			["builtin:spaces", ["project", "combined"]],
		]);
	});

	it("merges a contributed source's rows after dev3's, ranks them on free text, and selects through it", async () => {
		const source = acme();
		await contribute(source);
		renderPalette();
		expect(options()).toEqual(["users-service", "auth-gateway", "Acme readmedocs"]);
		const user = userEvent.setup();
		await user.type(screen.getByRole("textbox"), "acme");
		expect(options()).toEqual(["Acme readmedocs"]);
		await user.keyboard("{Enter}");
		expect(source.select).toHaveBeenCalledWith(expect.objectContaining({ id: "acme:readme", value: "readme" }), expect.objectContaining({ projects: PROJECTS }));
	});

	it("builds rows once per data change, not on every keystroke", async () => {
		const rows = vi.fn(() => [{ id: "acme:readme", text: "Acme readme", value: "readme" }]);
		await contribute(acme({ rows }));
		renderPalette();
		// Agents, spaces and lineage land asynchronously and rebuild the data once; typing must not.
		for (let tick = 0; tick < 10; tick++) await act(settle);
		const before = rows.mock.calls.length;
		await userEvent.setup().type(screen.getByRole("textbox"), "users");
		expect(rows.mock.calls.length).toBe(before);
	});

	it("drops a throwing source's rows or matches, keeps dev3's, and logs each callback once", async () => {
		const boom = () => {
			throw new Error("boom");
		};
		await contribute(acme({ matches: boom, right: boom }));
		getAppRoot().plugin({ name: "broken", inject: ["goToSources"], apply: (ctx) => void ctx.goToSources.register({ ...acme(), id: "acme:broken", rows: boom }) });
		await settle();
		renderPalette();
		const user = userEvent.setup();
		await user.type(screen.getByRole("textbox"), "u");
		await user.clear(screen.getByRole("textbox"));
		expect(options()).toEqual(["users-service", "auth-gateway"]);
		const reports = errors.mock.calls.map((call: unknown[]) => String(call[0])).filter((line: string) => line.includes("go-to source"));
		expect(reports.sort()).toEqual(["[goToSources] matches of go-to source acme:docs threw:", "[goToSources] rows of go-to source acme:broken threw:"]);
	});

	it("logs every failing select, since each is a click rather than a render", async () => {
		await contribute(acme({ right: undefined, select: () => { throw new Error("select boom"); } }));
		renderPalette();
		const user = userEvent.setup();
		await waitFor(() => expect(options()).toContain("Acme readme"));
		await user.click(screen.getByText("Acme readme"));
		renderPalette();
		await waitFor(() => expect(screen.getAllByText("Acme readme")).toHaveLength(2));
		await user.click(screen.getAllByText("Acme readme")[1]);
		const reports = errors.mock.calls.map((call: unknown[]) => String(call[0])).filter((line: string) => line.includes("go-to source"));
		expect(reports).toEqual(["[goToSources] select of go-to source acme:docs threw:", "[goToSources] select of go-to source acme:docs threw:"]);
	});

	it("keeps a row whose trailing content throws or crashes, without that content", async () => {
		const Crash = () => {
			throw new Error("render boom");
		};
		await contribute(acme({ right: () => <Crash /> }));
		renderPalette();
		await waitFor(() => expect(options()).toEqual(["users-service", "auth-gateway", "Acme readme"]));
		const reports = errors.mock.calls.map((call: unknown[]) => String(call[0])).filter((line: string) => line.includes("go-to source"));
		expect(reports).toEqual(["[goToSources] render of go-to source acme:docs threw:"]);
	});

	it("[dispose] drops a plugin's rows from the open palette when the plugin unloads, keeping dev3's", async () => {
		const fiber = await contribute(acme());
		renderPalette("combined");
		await waitFor(() => expect(options()).toContain("Acme readmedocs"));
		await act(async () => {
			await fiber.dispose();
		});
		expect(getGoToSourceRegistry().get("acme:docs")).toBeUndefined();
		expect(options()).toEqual(["users-service", "auth-gateway"]);
	});
});
