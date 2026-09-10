Short: Bedrock ids that actually launch

Fixed the Bedrock model ids dev3 derives after launching every preset against the real endpoints: Codex now routes through Bedrock Runtime with a <geo>.openai.<family> inference profile (the default gpt-6-astra preset was a 404 on the previous provider) and gets the same region selector as Claude; the haiku and opus-4-6 aliases use Bedrock's dated ids; the dead apac region option is replaced by jp; rows a region does not serve are marked in Settings; the misleading ~/.codex/config.toml warning is gone.
