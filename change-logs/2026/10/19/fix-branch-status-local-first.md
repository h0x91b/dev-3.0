Short: Faster branch status bar

The branch status poll now answers from local refs and fetches the remote in the background; fetches reuse the SSH connection, base and task branch share one fetch, an unpushed branch is not fetched, and the open task jumps the fetch queue. The refresh button and post-push/merge refresh force a real fetch, and a failed or 20 s/45 s timed-out status load shows an error with a Retry button instead of an endless spinner.

Contributed by @diverru (h0x91b/dev-3.0#2012)
