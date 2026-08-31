Short: Two messages in one turn no longer weld

Several `dev3 message` deliveries that land inside one quiet window are typed as a single agent turn, and until now they arrived welded together — the closing tag of one report and the opening tag of the next sat on the same line, so a coordinator reading a multi-part report could not tell where one child stopped and the next began. Every message after the first now goes in behind a blank line, and so does the board snapshot that trails a burst.

Suggested by @yhattav (h0x91b/dev-3.0#1608)
