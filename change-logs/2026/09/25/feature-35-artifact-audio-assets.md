Short: Audio files in HTML artifacts

HTML artifacts now bundle MP3, M4A, WAV and OGG audio like images and video: a report directory or `--assets` carries them, ordinary `<audio>` players load, seek and replay in the viewer, and `<a href="audio/x.mp3" download>` links save the file. A player or link that points at a local media file which is not bundled, not a supported format, or outside the report directory now stops `show-artifact` with the fix instead of publishing a player that never loads.
