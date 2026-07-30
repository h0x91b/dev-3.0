Short: Native terminal host now ships on macOS and Linux

The experimental native terminal backend could not start from a packaged macOS or Linux build: the host bundle was only built on Windows and no package outside Windows carried a native host image. Both are now produced and verified on every platform, and a packaged app resolves and stages its own image without any environment override. Terminal backend defaults are unchanged — tmux still owns every task that has not explicitly opted in.
