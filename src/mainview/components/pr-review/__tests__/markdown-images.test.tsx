import { render, screen, waitFor } from "@testing-library/react";
import type { FilePreviewResult } from "../../../../shared/types";
import { resolveDiskImagePath } from "../markdown-images";
import { MarkdownDocument } from "../markdown";
import { I18nProvider } from "../../../i18n";
import { MarkdownRichDiff, buildMarkdownDiffBlocks } from "../markdown-diff";

const readFilePreview = vi.fn<(params: { path: string }) => Promise<FilePreviewResult>>();

vi.mock("../../../rpc", () => ({
	isElectrobun: false,
	api: {
		request: {
			get readFilePreview() {
				return readFilePreview;
			},
		},
	},
}));

const PNG_DATA_URL = "data:image/png;base64,AAAA";

beforeEach(() => {
	readFilePreview.mockReset();
	readFilePreview.mockImplementation(async () => ({ kind: "image", dataUrl: PNG_DATA_URL, size: 3 }));
});

describe("resolveDiskImagePath", () => {
	it("resolves against the document directory", () => {
		expect(resolveDiskImagePath("screenshots/board.png", "/wt/docs")).toBe("/wt/docs/screenshots/board.png");
	});

	it("collapses . and .. segments", () => {
		expect(resolveDiskImagePath("./a/../b/shot.png", "/wt/docs")).toBe("/wt/docs/b/shot.png");
		expect(resolveDiskImagePath("../assets/shot.png", "/wt/docs")).toBe("/wt/assets/shot.png");
	});

	it("never escapes above the filesystem root", () => {
		expect(resolveDiskImagePath("../../../../etc/passwd", "/wt")).toBe("/etc/passwd");
	});

	it("resolves a root-relative src against the checkout root", () => {
		expect(resolveDiskImagePath("/docs/shot.png", "/wt/docs/deep", "/wt")).toBe("/wt/docs/shot.png");
	});

	it("gives up on a root-relative src with no root", () => {
		expect(resolveDiskImagePath("/docs/shot.png", "/wt/docs")).toBeNull();
	});

	it("strips a query or fragment and decodes percent escapes", () => {
		expect(resolveDiskImagePath("my%20shot.png?v=2", "/wt/docs")).toBe("/wt/docs/my shot.png");
		expect(resolveDiskImagePath("shot.png#frag", "/wt/docs")).toBe("/wt/docs/shot.png");
	});
});

describe("markdown image sanitization", () => {
	it("keeps a repo-relative img src through the sanitizer", () => {
		render(<MarkdownDocument body={"![board](docs/screenshots/board.png)"} />);
		expect(screen.getByAltText("board")).toHaveAttribute("src", "docs/screenshots/board.png");
	});

	it("ignores a hand-written token instead of reading it off disk", () => {
		const forged = "https://dev3.invalid/0/..%2F..%2F..%2Fetc%2Fpasswd";
		render(<MarkdownDocument body={`![x](${forged})`} imageBaseDir="/wt/docs" />);
		expect(readFilePreview).not.toHaveBeenCalled();
		expect(screen.getByAltText("x")).toHaveAttribute("src", forged);
	});

	it("keeps reference-style repo images through the sanitizer", () => {
		render(<MarkdownDocument body={"![board][shot]\n\n[shot]: docs/screenshots/board.png"} />);
		expect(screen.getByAltText("board")).toHaveAttribute("src", "docs/screenshots/board.png");
	});
});

describe("MarkdownDocument images", () => {
	it("swaps a repo-relative image for the data URL read off disk", async () => {
		render(<MarkdownDocument body={"![board](screenshots/board.png)"} imageBaseDir="/wt/docs" />);
		await waitFor(() => expect(screen.getByAltText("board")).toHaveAttribute("src", PNG_DATA_URL));
		expect(readFilePreview).toHaveBeenCalledWith({ path: "/wt/docs/screenshots/board.png" });
		expect(screen.getByAltText("board").dataset.dev3MdImage).toBe("loaded");
	});

	it("keeps the resolved image across a re-render", async () => {
		const { rerender } = render(<MarkdownDocument body={"![board](screenshots/board.png)"} imageBaseDir="/wt/docs" />);
		await waitFor(() => expect(screen.getByAltText("board")).toHaveAttribute("src", PNG_DATA_URL));
		rerender(<MarkdownDocument body={"![board](screenshots/board.png)"} imageBaseDir="/wt/docs" className="mx-auto" />);
		expect(screen.getByAltText("board")).toHaveAttribute("src", PNG_DATA_URL);
	});

	it("marks the image missing when the file is not on disk", async () => {
		readFilePreview.mockResolvedValue({ kind: "not-found" });
		render(<MarkdownDocument body={"![gone](gone.png)"} imageBaseDir="/wt/docs" />);
		await waitFor(() => expect(screen.getByAltText("gone").dataset.dev3MdImage).toBe("missing"));
		expect(screen.getByAltText("gone")).not.toHaveAttribute("src");
	});

	it("leaves remote images untouched and reads nothing off disk", async () => {
		render(<MarkdownDocument body={"![remote](https://example.com/a.png)"} imageBaseDir="/wt/docs" />);
		expect(screen.getByAltText("remote")).toHaveAttribute("src", "https://example.com/a.png");
		expect(readFilePreview).not.toHaveBeenCalled();
	});

	it("does nothing without a base directory", async () => {
		render(<MarkdownDocument body={"![board](screenshots/board.png)"} />);
		expect(screen.getByAltText("board")).toHaveAttribute("src", "screenshots/board.png");
		expect(readFilePreview).not.toHaveBeenCalled();
	});
});

describe("MarkdownRichDiff images", () => {
	it("resolves images inside diff blocks", async () => {
		const blocks = buildMarkdownDiffBlocks("# Title\n\nintro", "# Title\n\n![new](shots/new.png)");
		expect(blocks).not.toBeNull();
		render(
			<I18nProvider>
				<MarkdownRichDiff blocks={blocks!} imageBaseDir="/wt/docs" imageRootDir="/wt" />
			</I18nProvider>,
		);
		await waitFor(() => expect(screen.getByAltText("new")).toHaveAttribute("src", PNG_DATA_URL));
		expect(readFilePreview).toHaveBeenCalledWith({ path: "/wt/docs/shots/new.png" });
	});
});
