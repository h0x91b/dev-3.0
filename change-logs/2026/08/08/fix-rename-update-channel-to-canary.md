Short: Second update channel renamed canary

The second update channel is now called Canary instead of Unstable — the old name could never actually be built, because the build tool only accepts channel names from its own list and quietly produced a development build for anything else. Nothing had been published under the old name, so nobody needs to do anything; a saved choice simply reads back as Stable. The hourly publishing job is running again, and the picker stays disabled until a build is actually readable in the release bucket.
