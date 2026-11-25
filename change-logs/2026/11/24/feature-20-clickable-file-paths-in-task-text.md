Short: Clickable file paths in task text

File paths in task descriptions, notes, overviews and agent messages now open the in-app file preview when the file exists, at the written line for `path:12`, with the full path on hover; Windows paths (`C:\Users\me\x.md`, `src\app.ts`) count too, in task text and in terminal output. A file in another project is written `path:<project>/<path>`, which dev3 fills in when an agent writes a task, note or overview for another board, or when a To Do task moves to another project, and which agents read with its absolute path. Task references like `seq:12` in such notes, overviews and moved tasks now keep pointing at the board they were written on, too. Task and PR chips can now be selected and copied with the surrounding text.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2451)
