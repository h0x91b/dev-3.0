Short: Multi-line paste in remote terminal

Fixed multi-line paste (Ctrl+V) in the browser/remote terminal submitting after the first line — most visible on Windows where the clipboard carries CRLF. Text pastes now always route through ghostty's bracketed-paste path with newlines normalized to CR, instead of falling onto ghostty's raw container-focus paste handler.
