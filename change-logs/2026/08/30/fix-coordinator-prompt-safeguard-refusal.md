Short: Coordinator tasks start again on Opus

The built-in Coordinator preset prompt contained a sentence that Anthropic's safeguards flagged as a reasoning-extraction attempt, so every coordinator task launched on Opus died on its first message with an API refusal before the agent could do anything. The sentence is gone and the paragraph around it already carried the same instruction.
