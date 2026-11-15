Short: Picked account no longer runs on Bedrock

Picking a Claude account for a task (explicitly, through Auto, or the account the project's own Claude folder is signed in to) now unsets the project env's Bedrock/Vertex/Foundry switch, API key, auth token, base URL and model ids for that session, so a project that sets Bedrock in `.dev3/config` can still run subscription tasks next to Bedrock ones, and a resumed or restarted task stays on its account. Tasks with no account pick keep the project env as before.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2304)
