Short: Resume keeps last agent conversation

Resume now continues the last agent's conversation after its pane exits, instead of starting a new one; previously the pane-exit cleanup dropped the conversation id when no agent pane was left. A keep-alive task now resumes its last agent after that pane closes, and a Codex started by hand in the leftover shell no longer overwrites the saved conversation.
