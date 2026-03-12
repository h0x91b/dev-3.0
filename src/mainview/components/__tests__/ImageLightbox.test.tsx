import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImageLightbox, cacheSet, cacheGet, dataUrlCache, DATA_URL_CACHE_MAX } from "../ImageLightbox";
import { I18nProvider } from "../../i18n";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			readImageBase64: vi.fn().mockResolvedValue(null),
			openImageFile: vi.fn(),
		},
	},
}));

const paths = ["/img1.png", "/img2.png", "/img3.png"];

function renderLightbox(
	currentIndex = 0,
	onClose = vi.fn(),
) {
	return render(
		<I18nProvider>
			<ImageLightbox paths={paths} currentIndex={currentIndex} onClose={onClose} />
		</I18nProvider>,
	);
}

describe("ImageLightbox keyboard shortcuts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("Escape calls onClose", async () => {
		const onClose = vi.fn();
		renderLightbox(0, onClose);
		await userEvent.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});

	it("ArrowRight advances to the next image", async () => {
		renderLightbox(0);
		expect(screen.getByText("1 / 3")).toBeInTheDocument();
		await userEvent.keyboard("{ArrowRight}");
		expect(screen.getByText("2 / 3")).toBeInTheDocument();
	});

	it("ArrowLeft goes to the previous image", async () => {
		renderLightbox(1);
		expect(screen.getByText("2 / 3")).toBeInTheDocument();
		await userEvent.keyboard("{ArrowLeft}");
		expect(screen.getByText("1 / 3")).toBeInTheDocument();
	});

	it("ArrowRight does nothing on the last image", async () => {
		renderLightbox(2);
		await userEvent.keyboard("{ArrowRight}");
		expect(screen.getByText("3 / 3")).toBeInTheDocument();
	});

	it("ArrowLeft does nothing on the first image", async () => {
		renderLightbox(0);
		await userEvent.keyboard("{ArrowLeft}");
		expect(screen.getByText("1 / 3")).toBeInTheDocument();
	});

	it("ArrowRight advances multiple times", async () => {
		renderLightbox(0);
		await userEvent.keyboard("{ArrowRight}");
		await userEvent.keyboard("{ArrowRight}");
		expect(screen.getByText("3 / 3")).toBeInTheDocument();
	});
});

describe("ImageLightbox LRU cache", () => {
	beforeEach(() => {
		dataUrlCache.clear();
	});

	it("stores and retrieves values", () => {
		cacheSet("a", "data-a");
		expect(cacheGet("a")).toBe("data-a");
	});

	it("returns undefined for missing keys", () => {
		expect(cacheGet("missing")).toBeUndefined();
	});

	it("evicts oldest entries when exceeding max size", () => {
		for (let i = 0; i < DATA_URL_CACHE_MAX + 5; i++) {
			cacheSet(`key-${i}`, `val-${i}`);
		}
		expect(dataUrlCache.size).toBe(DATA_URL_CACHE_MAX);
		// First 5 keys should be evicted
		for (let i = 0; i < 5; i++) {
			expect(cacheGet(`key-${i}`)).toBeUndefined();
		}
		// Last entries should still exist
		expect(cacheGet(`key-${DATA_URL_CACHE_MAX + 4}`)).toBe(`val-${DATA_URL_CACHE_MAX + 4}`);
	});

	it("accessing a key promotes it (LRU behavior)", () => {
		for (let i = 0; i < DATA_URL_CACHE_MAX; i++) {
			cacheSet(`key-${i}`, `val-${i}`);
		}
		// Access the oldest key to promote it
		cacheGet("key-0");
		// Add one more to trigger eviction — key-1 should be evicted, not key-0
		cacheSet("new-key", "new-val");
		expect(dataUrlCache.size).toBe(DATA_URL_CACHE_MAX);
		expect(cacheGet("key-0")).toBe("val-0");
		expect(cacheGet("key-1")).toBeUndefined();
	});

	it("updating an existing key does not increase size", () => {
		cacheSet("a", "v1");
		cacheSet("a", "v2");
		expect(dataUrlCache.size).toBe(1);
		expect(cacheGet("a")).toBe("v2");
	});
});
