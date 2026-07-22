Short: Fix update crash on dev builds

Manual "Check for Updates" no longer crashes on dev/source builds. Electrobun's updater disables updates on the dev channel and left its state uninitialized, so the download step threw a TypeError; the dev channel now shows an informational notice instead of attempting a download.
