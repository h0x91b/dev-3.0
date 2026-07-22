import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RemoteBetaWarning from "../RemoteBetaWarning";
import { isRemote } from "../../../utils/platform";

vi.mock("../../../utils/platform", () => ({
	isRemote: vi.fn(() => true),
	isMac: vi.fn(() => true),
}));

const isRemoteMock = vi.mocked(isRemote);

beforeEach(() => {
	isRemoteMock.mockReturnValue(true);
});

describe("RemoteBetaWarning", () => {
	it("shows the warning text in remote mode", () => {
		render(<RemoteBetaWarning text="beta over remote" />);
		expect(screen.getByText("beta over remote")).toBeInTheDocument();
	});

	it("renders nothing in the desktop shell", () => {
		isRemoteMock.mockReturnValue(false);
		const { container } = render(<RemoteBetaWarning text="beta over remote" />);
		expect(container).toBeEmptyDOMElement();
		expect(screen.queryByText("beta over remote")).not.toBeInTheDocument();
	});
});
