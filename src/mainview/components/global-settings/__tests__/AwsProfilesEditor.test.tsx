import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import AwsProfilesEditor from "../AwsProfilesEditor";
import { I18nProvider, useT } from "../../../i18n";
import type { BedrockProfile } from "../../../../shared/types";

type State = { profiles?: BedrockProfile[]; defaultProfile?: string };

function Harness({ initial, onState }: { initial: State; onState: (s: State) => void }) {
	const [state, setState] = useState<State>(initial);
	const t = useT();
	return (
		<AwsProfilesEditor
			t={t}
			profiles={state.profiles}
			defaultProfile={state.defaultProfile}
			onChange={(patch) => {
				const next = { ...state, ...patch };
				setState(next);
				onState(next);
			}}
		/>
	);
}

const renderEditor = (initial: State, onState = vi.fn()) => {
	render(<I18nProvider><Harness initial={initial} onState={onState} /></I18nProvider>);
	return onState;
};

describe("AwsProfilesEditor", () => {
	it("flags duplicate names and an entry with no AWS profile", () => {
		renderEditor({ profiles: [{ name: "og", awsProfile: "a" }, { name: "og", awsProfile: "b" }, { name: "kort", awsProfile: "" }] });
		expect(screen.getAllByText(/Another profile has this name/)).toHaveLength(2);
		expect(screen.getByText(/Not offered at launch until AWS_PROFILE is set/)).toBeTruthy();
	});

	it("checks only one default radio when names repeat", () => {
		renderEditor({ profiles: [{ name: "og", awsProfile: "a" }, { name: "og", awsProfile: "b" }], defaultProfile: "og" });
		const radios = screen.getAllByRole("radio") as HTMLInputElement[];
		expect(radios.filter((r) => r.checked)).toHaveLength(1);
	});

	it("clicking the radio of a same-named row keeps the default instead of clearing it", () => {
		const onState = renderEditor({ profiles: [{ name: "og", awsProfile: "a" }, { name: "og", awsProfile: "b" }], defaultProfile: "og" });
		fireEvent.click(screen.getAllByRole("radio")[1]);
		expect(onState.mock.calls.every(([state]) => state.defaultProfile === "og")).toBe(true);
	});

	it("blanking the default's name drops the default, so a blank row cannot inherit it", () => {
		const onState = renderEditor({ profiles: [{ name: "og", awsProfile: "a" }, { name: "", awsProfile: "" }], defaultProfile: "og" });
		const names = screen.getAllByLabelText("Name") as HTMLInputElement[];
		fireEvent.change(names[0], { target: { value: "" } });
		expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ defaultProfile: undefined }));
		fireEvent.change(names[1], { target: { value: "x" } });
		expect(onState.mock.calls[onState.mock.calls.length - 1][0].defaultProfile).toBeUndefined();
	});

	it("trims a row on blur and keeps it the default", () => {
		const onState = renderEditor({ profiles: [{ name: "og", awsProfile: "a" }], defaultProfile: "og" });
		const name = screen.getByLabelText("Name") as HTMLInputElement;
		fireEvent.change(name, { target: { value: " og2 " } });
		fireEvent.blur(name);
		expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ profiles: [{ name: "og2", awsProfile: "a" }], defaultProfile: "og2" }));
	});
});
