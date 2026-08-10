import { render, screen, waitFor } from "@testing-library/react";
import type { FilePreviewResult } from "../../../../shared/types";
import { isDiskImageSrc, resolveDiskImagePath } from "../markdown-images";
import { MarkdownDocument, renderMarkdownDocument } from "../markdown";
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

describe("isDiskImageSrc", () => {
	it.each([
		["docs/shot.png", true],
		["./shot.png", true],
		["../assets/shot.png", true],
		["/docs/shot.png", true],
		["https://example.com/a.png", false],
		["http://example.com/a.png", false],
		["data:image/png;base64,AAAA", false],
		["//example.com/a.png", false],
		["", false],
	])("classifies %s as disk-backed: %s", (src, expected) => {
		expect(isDiskImageSrc(src)).toBe(expected);
	});
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
		expect(renderMarkdownDocument("![board](docs/screenshots/board.png)")).toContain('src="docs/screenshots/board.png"');
	});
});

describe("MarkdownDocument images", () => {
	it("swaps a repo-relative image for the data URL read off disk", async () => {
		render(<MarkdownDocument body={"![board](screenshots/board.png)"} imageBaseDir="/wt/docs" />);
		await waitFor(() => expect(screen.getByAltText("board")).toHaveAttribute("src", PNG_DATA_URL));
		expect(readFilePreview).toHaveBeenCalledWith({ path: "/wt/docs/screenshots/board.png" });
		expect(screen.getByAltText("board").dataset.dev3MdImage).toBe("loaded");
	});

	// The swap lives in the HTML, not in the rendered <img> nodes: React rebuilds
	// that subtree on re-render, which would silently discard a DOM-level edit.
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
		render(<MarkdownRichDiff blocks={blocks!} imageBaseDir="/wt/docs" imageRootDir="/wt" />);
		await waitFor(() => expect(screen.getByAltText("new")).toHaveAttribute("src", PNG_DATA_URL));
		expect(readFilePreview).toHaveBeenCalledWith({ path: "/wt/docs/shots/new.png" });
	});
});
