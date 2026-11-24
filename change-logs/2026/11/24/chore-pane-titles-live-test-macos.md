The live pane title bar test now passes on macOS: its panes run `cat` instead of `sh`, because macOS /bin/sh runs bash and tmux reports the pane command as `bash`.
