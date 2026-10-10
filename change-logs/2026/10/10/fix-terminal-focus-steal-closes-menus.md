Short: Right-click menus stay open beside the terminal

In the browser UI, a right-click menu opened while the task terminal had focus closed again after about 50 ms, because the terminal took focus back from it. The terminal now takes focus back only when nothing else took it, so sidebar context menus and other focusable controls keep it.
