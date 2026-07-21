Short: No more bypass-permission prompt

Claude sessions launched by dev3 no longer show the one-time "bypass permissions" confirmation on startup — dev3 now injects skipDangerousModePermissionPrompt into the managed Claude settings for every session, including when rate-limit tracking is off.

Reported by Ted Kostylev
