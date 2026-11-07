import { ATTENTION_VIEW_ID } from "../../../shared/board-view-state";
import { useT, type TranslationKey } from "../../i18n";
import type { BoardService } from "../board-service";
import { normalizeAttentionLayout, type AttentionBucket, type AttentionLayout } from "./buckets";

const DEFAULT_NAME_KEYS: Record<string, TranslationKey> = {
	"needs-you": "boardView.attention.bucket.needsYou",
	ready: "boardView.attention.bucket.ready",
	stalled: "boardView.attention.bucket.stalled",
	"waiting-pr": "boardView.attention.bucket.waitingPr",
};

export function useBucketName(): (bucket: AttentionBucket) => string {
	const t = useT();
	return (bucket) => {
		if (bucket.name.trim()) return bucket.name;
		const key = DEFAULT_NAME_KEYS[bucket.id];
		return key ? t(key) : bucket.query.trim() || t("boardView.attention.unnamed");
	};
}

export function useAttentionLayout(board: BoardService): [AttentionLayout, (layout: AttentionLayout) => void] {
	const layout = normalizeAttentionLayout(board.layout<AttentionLayout>(ATTENTION_VIEW_ID));
	return [layout, (next) => board.setLayout(ATTENTION_VIEW_ID, next)];
}

