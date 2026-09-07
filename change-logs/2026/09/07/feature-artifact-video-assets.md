Short: Video clips in HTML artifacts

HTML artifacts now bundle local MP4 and WebM clips: `dev3 show-artifact` collects them from a report directory or an explicit `--assets` list, and plain `<video controls playsinline>` markup with `<source>` alternatives and a local poster plays in the viewer, in the popup, in the browser and inside the downloaded ZIP. A clip is capped at 16 MB and all clips at 48 MB per artifact, with an error that names the file and what to do instead of dropping it silently.
