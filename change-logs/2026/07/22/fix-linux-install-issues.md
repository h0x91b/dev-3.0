Short: Linux install fixes

Fixed several issues hit while installing dev3 on a fresh Linux box via Homebrew. The brew formula now ships the artifact-template next to the binary, so launching a task no longer fails with "Bundled dev3 artifact template not found"; a missing template also degrades gracefully now instead of blocking task launch. The AI install guide (ai-install.txt) now documents `brew trust` as a required step on Homebrew 6.0+ rather than an optional legacy command.
