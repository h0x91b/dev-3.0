import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENTS } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import AgentConfigPicker from "../AgentConfigPicker";

const claude = DEFAULT_AGENTS.find((a) => a.id === "builtin-claude")!;
// The cost-trick preset is now its own Model group ("Fable 5 (cost trick)"),
// so the gating lives on the Model dropdown, not the Mode leaf.
const COST_TRICK = /Fable 5 \(cost trick\)/;

function setup(pxpipeProxyEnabled: boolean) {
	const onChange = vi.fn();
	render(
		<I18nProvider>
			<AgentConfigPicker
				idPrefix="test"
				agents={[claude]}
				agentId="builtin-claude"
				// A plain Fable 5 preset so the cost-trick variant shows as its own
				// gated entry in the Model dropdown.
				configId="claude-auto-fable5-medium"
				onChange={onChange}
				pxpipeProxyEnabled={pxpipeProxyEnabled}
			/>
		</I18nProvider>,
	);
	return { onChange };
}

describe("AgentConfigPicker — pxpipe-gated model", () => {
	it("renders the cost-trick model disabled and does not select it while the proxy is off", async () => {
		const user = userEvent.setup();
		const { onChange } = setup(false);

		await user.click(screen.getByLabelText("Model"));
		const option = screen.getByText(COST_TRICK);
		expect(option.closest("button")).toHaveAttribute("aria-disabled", "true");

		await user.click(option);
		// Gated click must not commit a selection.
		expect(onChange).not.toHaveBeenCalledWith(
			expect.objectContaining({ configId: "claude-fable5-cost-trick-bypass-medium" }),
		);
	});

	it("makes the cost-trick model selectable when the proxy is enabled", async () => {
		const user = userEvent.setup();
		const { onChange } = setup(true);

		await user.click(screen.getByLabelText("Model"));
		const option = screen.getByText(COST_TRICK);
		expect(option.closest("button")).not.toHaveAttribute("aria-disabled");

		await user.click(option);
		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({ configId: "claude-fable5-cost-trick-bypass-medium" }),
		);
	});
});
