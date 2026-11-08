Short: Expired Bedrock SSO opens the login

A Claude task launched on Bedrock with a picked AWS profile now runs `aws sso login` for that profile when its SSO session has expired, so the browser login opens instead of the task stopping at "Could not load AWS credentials".
