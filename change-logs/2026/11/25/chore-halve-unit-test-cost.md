The unit test suite costs about half the CPU it used to: the renderer and backend tests run on vitest's vm pools with a guard that restores whatever a test file patched in the shared context.
