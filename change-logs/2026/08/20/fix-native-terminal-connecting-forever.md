Short: Dead native terminal offers a restart

A native-backend task whose terminal host process was killed used to sit on "Connecting..." forever, with no timeout and no way out. The backend now says outright that the session is gone, and the task terminal offers a Restart terminal button within a few seconds instead of a spinner that could never resolve.
