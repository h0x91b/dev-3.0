import type { BoardRef, BoardViewState, NamedViewChange, NamedViewChangeResult } from "../../shared/board-view-state";
import type { BoardFilterState } from "../../shared/board-filter-state";
import { loadBoardFilterState, saveBoardFilterState } from "../board-filter-state-data";
import { changeNamedBoardView as changeNamed, loadBoardViewState, saveBoardViewState } from "../board-view-state-data";

async function getBoardViewState(params: { board: BoardRef }): Promise<BoardViewState> {
	return loadBoardViewState(params.board);
}

async function setBoardViewState(params: { board: BoardRef; state: BoardViewState }): Promise<BoardViewState> {
	return saveBoardViewState(params.board, params.state);
}

async function changeNamedBoardView(params: { board: BoardRef; change: NamedViewChange }): Promise<NamedViewChangeResult> {
	return changeNamed(params.board, params.change);
}

async function getBoardFilterState(params: { board: BoardRef }): Promise<BoardFilterState> {
	return loadBoardFilterState(params.board);
}

async function setBoardFilterState(params: { board: BoardRef; state: BoardFilterState }): Promise<BoardFilterState> {
	return saveBoardFilterState(params.board, params.state);
}

export const boardViewsHandlers = {
	getBoardViewState,
	setBoardViewState,
	changeNamedBoardView,
	getBoardFilterState,
	setBoardFilterState,
};
