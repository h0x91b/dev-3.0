# The FolderPicker CI flake waited on an element that is always there

## Context

`components/__tests__/FolderPickerModal.test.tsx > FolderPickerHost confined to a project
root > refuses a typed path that escapes the root and says so` failed on ubuntu CI
(shard 5/5) while the file on its own was green 21/21 on macOS. Reported as a flake, with a
hypothesis that `user.type` is slow and `findByText`'s 1000 ms default runs out.

## Investigation

The hypothesis was wrong, and the failure dump already contained the disproof: the
breadcrumb strip showed a crumb `etc` whose title was **`/Users/test/repo/etc`**. The app
had not been asked for `/etc` at all — it had been asked for a path *inside* the confine
root, which is legal, so the refusal correctly never rendered.

The sequence, confirmed by gating the first `listDirectory` call and printing the input's
value at each step:

| Step | `Folder path` value |
|---|---|
| after `findByTestId("folder-picker-backdrop")` | `""` |
| after `user.clear(input)` | `""` |
| after the initial listing lands | `"/Users/test/repo"` |
| after `user.type(input, "/etc{Enter}")` | `"/Users/test/repo/etc"` |

The backdrop is in the DOM from the **first** render, while the path input stays empty
until the initial listing resolves. So `user.clear` ran against an empty input and did
nothing, the confine root then arrived and filled it, and `/etc` was appended.

Deterministic mutant: make **only the first** `listDirectory` call `await setTimeout(D)`.

| `D` | Unfixed test |
|---|---|
| 1, 2, 3, 4, 5, 6, 8, 10, 12 ms | fails every run |
| 16 ms and up | passes |

Past ~16 ms the listing lands *after* the Enter, so the refusal renders and `findByText`
resolves before the late listing clobbers it. That narrow window is why the file alone is
green, why a shard is needed to see it, and why an earlier attempt with a fixed 40 ms and
300 ms delay "proved" the test was fine.

## Decision

`components/__tests__/FolderPickerModal.test.tsx` waits for the state it actually depends
on before touching the input:

```ts
await waitFor(() =>
    expect(screen.getByLabelText("Folder path")).toHaveValue("/Users/test/repo"),
);
```

Not a timeout bump — no timeout was involved. With the fix, `D` = 1, 4, 8 and 12 ms all
pass; shard 5/5 ran green 3/3 (`vitest list --shard=5/5` confirms the file is in that
shard).

## Risks

- Only this one case is fixed. Any other test that touches the picker's path input right
  after the backdrop has the same latent trap; today no other one does.

## Alternatives considered

- **Raise `findByText`'s timeout.** Would not help: the refusal is never rendered at all
  because the app was handed a legal path.
- **Wait on `folder-picker-sidebar` or a tree row instead.** Works by accident for some
  cases; the input's value is the state the test actually depends on, so that is what it
  waits on.
- **Make `navigateTo` ignore a late initial listing.** A product change to fix a test that
  synchronises on the wrong thing, and the late-listing overwrite is correct behaviour for
  a real user who has not typed anything.
