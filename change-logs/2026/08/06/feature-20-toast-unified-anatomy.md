Short: Toasts say which task they are about

Every in-app toast now has the same anatomy as a `dev3 notify` toast: a source line with the task number, project and title above the message, and a click that takes you to the task. A call site only has to say which task it is about — the toast host fills in the identity and the click target, so new toasts are correct by default. Global toasts that belong to no task stay bare instead of getting an invented source line.
