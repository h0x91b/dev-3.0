import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImageLightbox } from "../ImageLightbox";
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
