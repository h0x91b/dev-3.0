Short: Pick the AWS profile per launch

A Bedrock agent can list named AWS profiles (Settings → Coding Agents, or `dev3 agent aws-profiles set`), and the launch, spawn and column-agent dialogs then offer an AWS profile dropdown whose pick sets AWS_PROFILE and AWS_REGION over the project env. The pick is remembered per project and reused on resume, so one Bedrock agent covers every AWS account.
