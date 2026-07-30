import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TerminalBackendSetting from "../global-settings/TerminalBackendSetting";
import { I18nProvider, useT, type TFunction } from "../../i18n";
import type { NativeTerminalAvailability } from "../../../shared/types";
import type { TerminalBackendIdentity } from "../../../shared/terminal-backend-identity";

const AVAILABLE: NativeTerminalAvailability = { available: true, tmuxSupported: true, diagnostics: [] };

function Harness({
	value,
	availability,
	onChange,
}: {
	value: TerminalBackendIdentity | undefined;
	availability: NativeTerminalAvailability | null;
	onChange: (backend: TerminalBackendIdentity) => void;
}) {
	const t: TFunction = useT();
	return <TerminalBackendSetting t={t} value={value} availability={availability} onChange={onChange} />;
}

function setup(
	value: TerminalBackendIdentity | undefined,
	availability: NativeTerminalAvailability | null = AVAILABLE,
) {
	const onChange = vi.fn();
	render(
		<I18nProvider>
			<Harness value={value} availability={availability} onChange={onChange} />
		</I18nProvider>,
	);
	return { onChange };
}

const tmuxOption = () => screen.getByRole("radio", { name: /^tmux \(current default\)/ });
const nativeOption = () => screen.getByRole("radio", { name: /^Native terminal \(experimental\)/ });

describe("TerminalBackendSetting", () => {
	it("shows tmux as the selected default when nothing is stored", () => {
		setup(undefined);
		expect(tmuxOption()).toHaveAttribute("aria-checked", "true");
		expect(nativeOption()).toHaveAttribute("aria-checked", "false");
	});

	it("reflects a stored native preference", () => {
		setup("native");
		expect(nativeOption()).toHaveAttribute("aria-checked", "true");
	});

	it("reports the chosen backend upward", async () => {
		const { onChange } = setup(undefined);
		await userEvent.click(nativeOption());
		expect(onChange).toHaveBeenCalledWith("native");
	});

	it("keeps native visible but disabled, with the reason and the fix, when no host resolves", async () => {
		const { onChange } = setup(undefined, {
			available: false,
			tmuxSupported: true,
			diagnostics: ["Packaged host image unusable: manifest hash mismatch"],
		});
		expect(nativeOption()).toBeDisabled();
		expect(screen.getByText(/cannot launch a native terminal host/i)).toBeInTheDocument();
		expect(screen.getByText(/manifest hash mismatch/)).toBeInTheDocument();
		expect(screen.getByText(/build:native/)).toBeInTheDocument();

		await userEvent.click(nativeOption());
		expect(onChange).not.toHaveBeenCalled();
	});

	it("selects native and disables tmux on a host with no tmux runtime", () => {
		setup(undefined, { available: true, tmuxSupported: false, diagnostics: [] });
		expect(nativeOption()).toHaveAttribute("aria-checked", "true");
		expect(tmuxOption()).toBeDisabled();
		expect(screen.getByText(/does not run on Windows/i)).toBeInTheDocument();
	});

	it("moves the selection with the arrow keys, skipping an unavailable choice", async () => {
		const { onChange } = setup(undefined);
		tmuxOption().focus();
		await userEvent.keyboard("{ArrowDown}");
		expect(onChange).toHaveBeenCalledWith("native");

		onChange.mockClear();
		render(<div />);
		const blocked = setup(undefined, { available: false, tmuxSupported: true, diagnostics: ["no host"] });
		screen.getAllByRole("radio")[0].focus();
		await userEvent.keyboard("{ArrowDown}");
		expect(blocked.onChange).not.toHaveBeenCalled();
	});

	it("stays inert until the availability probe answers", async () => {
		const { onChange } = setup(undefined, null);
		expect(tmuxOption()).toBeDisabled();
		expect(nativeOption()).toBeDisabled();
		await userEvent.click(nativeOption());
		expect(onChange).not.toHaveBeenCalled();
	});
});
