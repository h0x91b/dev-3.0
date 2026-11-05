Short: Completion dialog closes once task is done

An agent's "requests completion" or "requests cancellation" dialog now closes itself the moment its task is completed, cancelled or deleted by any other path (the board, a merged PR), and never opens for a task that already finished; the same holds for agent launch requests whose target is deleted. The waiting `dev3 task move` gets an immediate answer: success when the task already reached the requested status, otherwise its usual decline code with a "voided" message.
