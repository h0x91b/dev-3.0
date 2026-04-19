# 038 — Diff viewer cache uuid includes content hash

## Context

Users saw stale content in the inline diff viewer after rebasing a branch. The
diff hunk headers reflected the fresh diff (correct line counts, correct hunk
ranges), but the body of the added lines showed content from an earlier state
of the branch that no longer exists anywhere in the working tree. A user
reported the bug after a `v4 → v5` rebase where the UI kept rendering the `v4`
variant names even though `grep` confirmed only `v5` exists in every commit.

## Investigation

The diff payload returned by `getTaskDiff` is fresh on every fetch — both the
`hunks` array and the `oldContent` / `newContent` strings come from `git diff`
/ `git show` calls at request time. Despite that, `@git-diff-view/core` was
rendering stale text. The root cause lives in
`node_modules/@git-diff-view/core/src/file.ts` → `getFile()`, which keys its
`File` cache by `uuid` alone:

```ts
let key = raw + "--" + __VERSION__ + "--" + theme + "--" + lang;
if (uuid) {
    key = uuid + "--" + __VERSION__ + "--" + theme + "--" + lang;
}
if (map.has(key)) return map.get(key);
```

`TaskDiffViewer.tsx` was passing `file.id` (the file path) as the `DiffFile`
uuid. Across rebases the path stays identical, so the library returned the
previously built `File` with stale `raw` content even though the caller passed
fresh `_newFileContent`.

## Decision

Mix a content hash into the uuid passed to `DiffFile`. `TaskDiffViewer.tsx`
now builds `const diffCacheUuid = "${file.id}:${getDiffFileContentHash(file)}"`
and passes that to the constructor. `getDiffFileContentHash` (exported from
`TaskDiffViewer.tsx`) hashes the concatenation of the hunk list and both sides
of the file content, so any change to the diff payload produces a new uuid
and forces a cache miss.

The regression is pinned by
`src/mainview/components/__tests__/TaskDiffViewer.stale-cache.test.ts`, which
demonstrates the raw library bug with a stable uuid and verifies that the new
content-hashed uuid renders fresh content.

## Risks

- If the library ever fixes its cache to include content in the key, our
  content-hashed uuid becomes slightly redundant but still correct. The
  regression test will start passing "the cache is not stale anymore" path
  naturally — worst case we get duplicate invalidations, not wrong output.
- The hash is a non-cryptographic djb2 variant; collisions are theoretically
  possible. In the context of this cache (small number of concurrent files,
  per-task) the collision probability is negligible.

## Alternatives considered

- **Pass `undefined` as the uuid.** This would also bypass the stale-cache
  problem (the library falls back to hashing the raw content into the key),
  but it disables an intentional cache-reuse optimisation across
  theme/language changes. Content-hashed uuid gives us both correctness and
  re-use when content is identical.
- **Patch `@git-diff-view/core` directly.** Out of scope — we do not vendor
  the library and upstreaming the fix is unnecessary for our use case.
