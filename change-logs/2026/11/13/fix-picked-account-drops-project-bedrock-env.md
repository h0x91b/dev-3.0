Short: Picked account no longer runs on Bedrock

Picking a Claude subscription account for a task now unsets the project's Bedrock switch and Bedrock model ids from its env, so a project that sets Bedrock in `.dev3/config` can still run subscription tasks next to Bedrock ones. Tasks with no account pick keep the project env as before.
