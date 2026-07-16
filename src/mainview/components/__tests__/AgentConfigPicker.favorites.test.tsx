import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			listAgentAccounts: vi.fn().mockResolvedValue({
				claude: { accounts: [], activeId: null, systemIdentity: null },
				codex: { accounts: [], activeId: null, currentIdentity: null },
			}),
			setActiveAgentAccount: vi.fn(),
		},
	},
}));

import AgentConfigPicker, { type AgentConfigSelection } from "../AgentConfigPicker";
import { I18nProvider } from "../../i18n";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import type { CodingAgent, FavoriteAgentConfig } from "../../../shared/types";

// Nerd Font star glyphs used by the trigger (filled = saved, outline = not).
const STAR_FILLED = "\uf005";
const STAR_OUTLINE = "\uf006";

const claudeAgent: CodingAgent = {
	id: "builtin-claude",
	name: "Claude",
	baseCommand: "claude",
	configurations: [
		{ id: "fable-auto-medium", name: "Auto (Fable 5, Medium)", model: "claude-fable-5", permissionMode: "auto", effort: "medium" },
		{ id: "opus-bypass-xhigh", name: "Bypass (Opus 4.8, X-High)", model: "claude-opus-4-8[1m]", permissionMode: "bypassPermissions", effort: "xhigh" },
	],
	defaultConfigId: "fable-auto-medium",
};
const codexAgent: CodingAgent = {
	id: "builtin-codex",
	name: "Codex",
	baseCommand: "codex",
	configurations: [{ id: "codex-default", name: "Default (GPT-5.5)", model: "gpt-5.5" }],
	defaultConfigId: "codex-default",
};
const agents = [claudeAgent, codexAgent];

const fav = (agentId: string, configId: string, uses = 0, lastUsedAt = 0): FavoriteAgentConfig => ({ agentId, configId, uses, lastUsedAt });

// Simulates the surrounding launch modal's own Escape handler so we can assert
// the picker stages Escape (closes its menu first, does not bubble to the modal).
function OuterEscape({ onEscape, children }: { onEscape: () => void; children: React.ReactNode }) {
	useEscapeKey(onEscape);
	return <>{children}</>;
}

function Harness({
	initial,
	favorites = [],
	showFavorites = true,
	onChange,
	onToggleFavorite,
	onOuterEscape,
}: {
	initial: AgentConfigSelection;
	favorites?: FavoriteAgentConfig[];
	showFavorites?: boolean;
	onChange?: (n: AgentConfigSelection) => void;
	onToggleFavorite?: (agentId: string, configId: string) => void;
	onOuterEscape?: () => void;
}) {
	const [sel, setSel] = useState(initial);
	const picker = (
		<AgentConfigPicker
			idPrefix="test"
			agents={agents}
			agentId={sel.agentId}
			configId={sel.configId}
			onChange={(next) => {
				setSel(next);
				onChange?.(next);
			}}
			showFavorites={showFavorites}
			favorites={favorites}
			onToggleFavorite={onToggleFavorite}
		/>
	);
	return (
		<I18nProvider>
			{onOuterEscape ? <OuterEscape onEscape={onOuterEscape}>{picker}</OuterEscape> : picker}
		</I18nProvider>
	);
}

let container: HTMLElement;
const buttons = () => Array.from(container.querySelectorAll("button")) as HTMLButtonElement[];
// The single Favorites column trigger (also the menu anchor). Always present when
// showFavorites, regardless of how many favorites exist.
const trigger = () => buttons().find((b) => b.getAttribute("aria-haspopup") === "menu");
const starGlyph = () => trigger()?.querySelector("span[aria-hidden]") as HTMLElement | undefined;
const menu = () => screen.queryByRole("menu");
const saveRow = () => screen.queryByRole("menuitem"); // top Save/Remove toggle row
const menuItemLabels = () =>
	screen.queryAllByRole("menuitemradio").map((b) => b.textContent?.trim() ?? "");

describe("AgentConfigPicker — favorites", () => {
	it("renders no favorites trigger when showFavorites is off", () => {
		({ container } = render(<Harness showFavorites={false} initial={{ agentId: "builtin-claude", configId: "fable-auto-medium" }} favorites={[fav("builtin-codex", "codex-default")]} />));
		expect(trigger()).toBeUndefined();
		expect(screen.queryByText("Favorites")).toBeNull();
	});

	it("always shows the trigger — even with no favorites — and its menu offers Save with an empty list", async () => {
		const user = userEvent.setup();
		({ container } = render(<Harness initial={{ agentId: "builtin-claude", configId: "fable-auto-medium" }} favorites={[]} />));
		expect(trigger()).toBeDefined();
		expect(menu()).toBeNull();
		await user.click(trigger()!);
		expect(menu()).not.toBeNull();
		expect(saveRow()?.textContent).toContain("Save this combo");
		expect(menuItemLabels()).toEqual([]);
	});

	it("the trigger star fills (gold) when the current combo is a favorite, outline otherwise", () => {
		({ container } = render(
			<Harness initial={{ agentId: "builtin-claude", configId: "opus-bypass-xhigh" }} favorites={[fav("builtin-claude", "opus-bypass-xhigh", 2, 2)]} />,
		));
		expect(starGlyph()?.textContent).toBe(STAR_FILLED);
		expect(starGlyph()?.className).toContain("text-favorite");
	});

	it("shows the outline star (not gold) when the current combo is not a favorite", () => {
		({ container } = render(
			<Harness initial={{ agentId: "builtin-claude", configId: "fable-auto-medium" }} favorites={[fav("builtin-codex", "codex-default")]} />,
		));
		expect(starGlyph()?.textContent).toBe(STAR_OUTLINE);
		expect(starGlyph()?.className).not.toContain("text-favorite");
	});

	it("the trigger opens a menu listing favorites ordered by usage with Provider · Model · Mode labels", async () => {
		const user = userEvent.setup();
		({ container } = render(
			<Harness
				initial={{ agentId: "builtin-claude", configId: "fable-auto-medium" }}
				favorites={[fav("builtin-claude", "opus-bypass-xhigh", 1, 5), fav("builtin-codex", "codex-default", 9, 1)]}
			/>,
		));
		expect(menu()).toBeNull();
		await user.click(trigger()!);
		expect(menu()).not.toBeNull();
		expect(menuItemLabels()).toEqual(["Codex · GPT-5.5 · Default", "Claude · Opus 4.8 · Bypass · X-High"]);
	});

	it("gives the favorites menu enough width for long configuration labels", async () => {
		const user = userEvent.setup();
		({ container } = render(
			<Harness
				initial={{ agentId: "builtin-claude", configId: "fable-auto-medium" }}
				favorites={[fav("builtin-claude", "opus-bypass-xhigh", 1, 5)]}
			/>,
		));

		await user.click(trigger()!);
		expect(menu()).toHaveStyle({ width: "360px" });
	});

	it("clicking a menu item selects that combo (does not launch) and closes the menu", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		({ container } = render(
			<Harness
				initial={{ agentId: "builtin-claude", configId: "fable-auto-medium" }}
				favorites={[fav("builtin-codex", "codex-default", 1, 1)]}
				onChange={onChange}
			/>,
		));
		await user.click(trigger()!);
		const item = screen.getByRole("menuitemradio", { name: /Codex/ });
		await user.click(item);
		expect(onChange).toHaveBeenCalledWith({ agentId: "builtin-codex", configId: "codex-default" });
		expect(menu()).toBeNull();
	});

	it("marks the active favorite (matching the current combo) as checked", async () => {
		const user = userEvent.setup();
		({ container } = render(
			<Harness
				initial={{ agentId: "builtin-claude", configId: "opus-bypass-xhigh" }}
				favorites={[fav("builtin-claude", "opus-bypass-xhigh", 2, 2), fav("builtin-codex", "codex-default", 1, 1)]}
			/>,
		));
		await user.click(trigger()!);
		const active = screen.getByRole("menuitemradio", { name: /Claude · Opus 4.8/ });
		expect(active).toHaveAttribute("aria-checked", "true");
		const other = screen.getByRole("menuitemradio", { name: /Codex/ });
		expect(other).toHaveAttribute("aria-checked", "false");
	});

	it("the Save row toggles the current combo (add) and keeps the menu open", async () => {
		const user = userEvent.setup();
		const onToggleFavorite = vi.fn();
		({ container } = render(
			<Harness
				initial={{ agentId: "builtin-claude", configId: "fable-auto-medium" }}
				favorites={[fav("builtin-codex", "codex-default", 1, 1)]}
				onToggleFavorite={onToggleFavorite}
			/>,
		));
		await user.click(trigger()!);
		expect(saveRow()?.textContent).toContain("Save this combo");
		await user.click(saveRow()!);
		expect(onToggleFavorite).toHaveBeenCalledWith("builtin-claude", "fable-auto-medium");
		// Saving must not dismiss the menu — the user sees the new entry appear.
		expect(menu()).not.toBeNull();
	});

	it("the Save row reads 'Remove this combo' and removes when the current combo is already a favorite", async () => {
		const user = userEvent.setup();
		const onToggleFavorite = vi.fn();
		({ container } = render(
			<Harness
				initial={{ agentId: "builtin-claude", configId: "opus-bypass-xhigh" }}
				favorites={[fav("builtin-claude", "opus-bypass-xhigh", 2, 2)]}
				onToggleFavorite={onToggleFavorite}
			/>,
		));
		await user.click(trigger()!);
		expect(saveRow()?.textContent).toContain("Remove this combo");
		await user.click(saveRow()!);
		expect(onToggleFavorite).toHaveBeenCalledWith("builtin-claude", "opus-bypass-xhigh");
	});

	it("disables the Save row when there is no current selection", async () => {
		const user = userEvent.setup();
		({ container } = render(<Harness initial={{ agentId: null, configId: null }} favorites={[fav("builtin-codex", "codex-default", 1, 1)]} />));
		await user.click(trigger()!);
		expect(saveRow()).toBeDisabled();
	});

	it("Escape closes the menu first without closing the surrounding modal, then closes the modal", async () => {
		const user = userEvent.setup();
		const onOuterEscape = vi.fn();
		({ container } = render(
			<Harness
				initial={{ agentId: "builtin-claude", configId: "fable-auto-medium" }}
				favorites={[fav("builtin-codex", "codex-default", 1, 1)]}
				onOuterEscape={onOuterEscape}
			/>,
		));
		await user.click(trigger()!);
		expect(menu()).not.toBeNull();
		// First Escape: dismiss only the menu — the modal's handler must NOT fire.
		await user.keyboard("{Escape}");
		expect(menu()).toBeNull();
		expect(onOuterEscape).not.toHaveBeenCalled();
		// Second Escape: menu already closed, so it falls through to the modal.
		await user.keyboard("{Escape}");
		expect(onOuterEscape).toHaveBeenCalledTimes(1);
	});

	it("the menu row × removes that favorite via its stored id", async () => {
		const user = userEvent.setup();
		const onToggleFavorite = vi.fn();
		({ container } = render(
			<Harness
				initial={{ agentId: "builtin-claude", configId: "fable-auto-medium" }}
				favorites={[fav("builtin-codex", "codex-default", 3, 3)]}
				onToggleFavorite={onToggleFavorite}
			/>,
		));
		await user.click(trigger()!);
		const remove = within(menu()!).getByRole("button", { name: "Remove favorite" });
		await user.click(remove);
		expect(onToggleFavorite).toHaveBeenCalledWith("builtin-codex", "codex-default");
	});
});
