Short: Cheaper artifact panel resize

Dragging the artifact panel divider no longer relayouts the artifact iframe and refits the terminal on every pointer move. A ghost line follows the pointer during the drag and the new width is applied once, on release, which removes the CPU spike (and the repeated tmux SIGWINCH repaints) while resizing.
