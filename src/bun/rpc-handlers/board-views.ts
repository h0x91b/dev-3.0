import type { BoardRef, BoardViewState } from "../../shared/board-view-state";
import { loadBoardViewState, saveBoardViewState } from "../board-view-state-data";

async function getBoardViewState(params: { board: BoardRef }): Promise<BoardViewState> {
	return loadBoardViewState(params.board);
}

async function setBoardViewState(params: { board: BoardRef; state: BoardViewState }): Promise<BoardViewState> {
	return saveBoardViewState(params.board, params.state);
}

export const boardViewsHandlers = {
	getBoardViewState,
	setBoardViewState,
};
