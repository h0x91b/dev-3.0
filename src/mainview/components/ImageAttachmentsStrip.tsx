import { useState } from "react";
import { extractImagePaths, extractFilePaths } from "../utils/imageAttachments";
import { ImageThumbnail } from "./ImageThumbnail";
import { ImageLightbox } from "./ImageLightbox";
import { FileAttachmentCard } from "./FileAttachmentCard";

interface ImageAttachmentsStripProps {
	text: string;
	onRemovePath?: (path: string) => void;
}

export function ImageAttachmentsStrip({ text, onRemovePath }: ImageAttachmentsStripProps) {
	const paths = extractImagePaths(text);
	const filePaths = extractFilePaths(text);
	const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

	if (paths.length === 0 && filePaths.length === 0) return null;

	return (
		<>
			<div className="flex flex-wrap gap-2 mt-1.5">
				{paths.map((path, i) => (
					<ImageThumbnail
						key={path}
						path={path}
						onClick={() => setLightboxIndex(i)}
						onRemove={onRemovePath ? () => onRemovePath(path) : undefined}
					/>
				))}
				{filePaths.map((path) => (
					<FileAttachmentCard
						key={path}
						path={path}
						onRemove={onRemovePath ? () => onRemovePath(path) : undefined}
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
