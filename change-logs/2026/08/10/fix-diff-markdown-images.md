Short: Markdown preview shows repo images

The Markdown preview and rich diff in the diff viewer now render images the document references from the repo (`![](docs/shot.png)`) instead of showing a broken box — the file is read off disk and inlined. Missing files show a labelled placeholder, remote URLs are untouched.
