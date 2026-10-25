Short: Image paste works in the Linux app

Pasting a clipboard image with Ctrl+V in the Linux desktop app now attaches it in task terminals and in task, note and scheduled-message fields, instead of silently doing nothing. WebKitGTK hands the page an empty paste event for images, so on a real user paste the Linux desktop shell now reads the image from the system clipboard; an unreadable image shows an error, an empty clipboard stays quiet, and browser/remote mode is unchanged.

Suggested by @gonpra (h0x91b/dev-3.0#2041)
