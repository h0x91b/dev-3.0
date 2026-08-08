Short: Windows builds now reach the canary channel

Windows (win-x64) now publishes to the canary update channel: the update manifest plus a downloadable .zip of the exact app tree CI launched and shut down cleanly, so a Windows user can install dev-3.0 for the first time instead of digging a build out of a workflow run. The build is not code-signed, so Windows shows a SmartScreen warning on first launch; the download instructions say so plainly. Tagged stable releases still ship no Windows build.
