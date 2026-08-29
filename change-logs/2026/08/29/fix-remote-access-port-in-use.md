Short: App survives a taken remote port

A remote-access port that was already in use used to take the whole app down a moment after the window appeared, silently killing task rehydration and every background scheduler with it. The app now keeps starting, remote access alone stays down, and Settings → System says which port is taken and offers Try again without an app restart.
