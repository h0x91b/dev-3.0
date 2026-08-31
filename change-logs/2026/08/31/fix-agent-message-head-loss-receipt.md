Short: Long agent messages keep a recoverable copy

A `dev3 message` over 1 500 bytes now also lands on disk next to the receiving task, and the envelope names that copy on its last line, just before the closing tag. A receiver that finds a closing `</dev3-ai-message>` with no opening line knows the delivery lost its head and can read the whole message from the named file instead of acting on half a ruling. Each task keeps its newest 50 receipts.

Suggested by @yhattav (h0x91b/dev-3.0#1608)
