Short: Replay no longer loses task events

Starting a replay in Agent traffic while the screen was still loading froze a timeline that had only messages on it, so recorded board movements and notifications never played back until a filter was toggled or Restart was pressed. The snapshot is now re-taken once, when every arm of the timeline has finished loading, keeping the reader on the same event and still ignoring anything that arrives after that.
