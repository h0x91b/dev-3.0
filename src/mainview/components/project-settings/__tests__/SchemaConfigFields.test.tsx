import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { CONFIG_KEYS, fieldUi } from "../../../../shared/config-schema";

vi.mock("../../../rpc", () => ({ api: { request: {} } }));
vi.mock("../../../i18n", () => ({
	useT: () => Object.assign((key: string) => key, { plural: (key: string) => key }),
}));

// Turn one field generic, as a freshly added schema field would be.
vi.mock("../../../../shared/config-schema", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../../shared/config-schema")>();
	return { ...actual, fieldUi: (key: string) => (key === "defaultCompareRefMode" ? "generic" : actual.fieldUi(key as never)) };
});

import { ConfigForm } from "../ConfigForm";

function renderForm(onChange = vi.fn()) {
	return render(
		<ConfigForm config={{ sparseCheckoutEnabled: true }} onChange={onChange} projectId="p" envStorageScope="repo" />,
	);
}

describe("Project Settings follows the config schema", () => {
	// Acceptance: a field added to the schema appears in the UI with no other edit.
	it("renders a control for every schema field that is not marked ui: none", () => {
		const { container } = renderForm();
		for (const key of CONFIG_KEYS) {
			const found = container.querySelector(`[data-config-keys~="${key}"]`);
			if (fieldUi(key) === "none") expect(found, key).toBeNull();
			else expect(found, key).not.toBeNull();
		}
	});

	it("renders a generic field from its schema and saves its value", () => {
		const onChange = vi.fn();
		const { container } = renderForm(onChange);
		const field = container.querySelector('[data-config-keys="defaultCompareRefMode"]')!;
		expect(field.textContent).toContain("defaultCompareRefMode");
		const select = field.querySelector("select")!;
		expect([...select.options].map((o) => o.value)).toEqual(["", "remote", "local"]);
		fireEvent.change(select, { target: { value: "local" } });
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ defaultCompareRefMode: "local" }));
	});
});
