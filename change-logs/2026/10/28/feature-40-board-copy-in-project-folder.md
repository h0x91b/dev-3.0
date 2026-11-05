Short: Keep a copy of the board

A project can now keep a copy of its board in its own folder: turn on "Keep a copy of the board in this project" when adding the project or in Project Settings > Board, and dev3 writes tasks, notes, labels and custom columns to `.dev3/board/` a few seconds after each change (the folder ignores itself in git). Adding that folder again on a new machine, or after the dev3 data folder was lost, offers to restore the board from the copy; `dev3 board export` writes it on demand.
