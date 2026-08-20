Short: Download images from the viewer

The shared image viewer (`dev3 show-image`) now has a Download button in its header, and right-clicking the image opens an in-app menu with Save image / Copy image path. The native WKWebView "Save Image As…" never worked there; the download uses the same anchor path as the artifact viewer, so it lands in ~/Downloads on the desktop and in the browser's download folder in remote mode. The same download button and right-click menu are now on the attachment lightbox (images attached to a task, a note or a scheduled message).
