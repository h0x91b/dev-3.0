import { useState } from "react";
import { extractImagePaths } from "../utils/imageAttachments";
import { ImageThumbnail } from "./ImageThumbnail";
import { ImageLightbox } from "./ImageLightbox";

interface ImageAttachmentsStripProps {
	text: string;
}

export function ImageAttachmentsStrip({ text }: ImageAttachmentsStripProps) {
	const paths = extractImagePaths(text);
	const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

	if (paths.length === 0) return null;

	return (
		<>
			<div className="flex flex-wrap gap-2 mt-1.5">
				{paths.map((path, i) => (
					<ImageThumbnail
						key={path}
						path={path}
						onClick={() => setLightboxIndex(i)}
					/>
				))}
			</div>

			{lightboxIndex !== null && (
				<ImageLightbox
					paths={paths}
					currentIndex={lightboxIndex}
					onClose={() => setLightboxIndex(null)}
				/>
			)}
		</>
	);
}
