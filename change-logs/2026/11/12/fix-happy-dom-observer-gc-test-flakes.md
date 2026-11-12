Renderer tests no longer fail at random under load: happy-dom is pinned to 20.14.6, because 20.9.0 dropped every MutationObserver after a garbage collection, which silenced `waitFor` and the artifact viewer's theme tracking in tests. A GC regression test guards the fix, and the Attention view tick test now waits with real polling timers.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2265)
