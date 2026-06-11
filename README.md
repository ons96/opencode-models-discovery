# opencode-models-discovery

[![npm version](https://img.shields.io/npm/v/opencode-models-discovery.svg?color=blue)](https://www.npmjs.com/package/opencode-models-discovery)
[![npm downloads](https://img.shields.io/npm/dt/opencode-models-discovery.svg)](https://www.npmjs.com/package/opencode-models-discovery)
[![release](https://github.com/yuhp/opencode-models-discovery/actions/workflows/release.yml/badge.svg)](https://github.com/yuhp/opencode-models-discovery/actions/workflows/release.yml)
[![license](https://img.shields.io/github/license/yuhp/opencode-models-discovery)](https://github.com/yuhp/opencode-models-discovery/blob/main/LICENSE)
[![OpenCode](https://img.shields.io/badge/OpenCode-%3E%3D1.4.0-blueviolet)](https://opencode.ai)

> A universal OpenCode plugin for dynamic model discovery across any OpenAI-compatible provider.

Originally inspired by [opencode-lmstudio](https://github.com/nicktasios/opencode-lmstudio), this project has been refactored into a general-purpose model discovery plugin with provider-level discovery controls, model filtering, metadata enrichment, and `/connect`-backed credential support.

## Features

- Works with any OpenAI-compatible provider
- Discovers models dynamically from provider model endpoints
- Injects discovered models into OpenCode provider config automatically
- Supports provider-level include, exclude, and endpoint overrides
- Supports regex-based model filtering
- Can enrich model limits and reasoning metadata from provider-specific endpoints
- Supports OpenCode `/connect` credentials for custom providers

## Installation

```bash
npm install opencode-models-discovery
# or
bun add opencode-models-discovery
```

## Quick Start

Add the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-models-discovery@latest"
  ],
  "provider": {
    "lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LM Studio (local)",
      "options": {
        "baseURL": "http://127.0.0.1:1234/v1",
        "modelsDiscovery": {
          "enabled": true
        }
      }
    }
  }
}
```

On startup, the plugin will query the provider's models endpoint and merge discovered models into the active OpenCode config.

## Upgrade Note

If you upgrade the plugin and OpenCode still behaves like it is using an older build, refresh the OpenCode plugin cache and restart OpenCode.

This can happen because OpenCode may continue using a previously cached package after the npm package itself has been updated.

## `/connect` Support

For custom OpenAI-compatible providers, you still define the provider in `opencode.json` so OpenCode and this plugin know the provider id, npm package, and `baseURL`.

If the API credential is managed through OpenCode `/connect`, you do not need to duplicate the same key in `provider.<name>.options.apiKey`.

Discovery auth precedence is:

1. `provider.<name>.options.apiKey`
2. OpenCode resolved provider key, when available during plugin startup
3. OpenCode `/connect` auth store for same-id `type: "api"` credentials

Details and examples: [`docs/connect-and-auth.md`](docs/connect-and-auth.md)

## Documentation

- Configuration guide: [`docs/configuration.md`](docs/configuration.md)
- `/connect` credentials and auth-backed discovery: [`docs/connect-and-auth.md`](docs/connect-and-auth.md)
- Provider compatibility and detection rules: [`docs/providers.md`](docs/providers.md)
- Upgrade notes: [`docs/upgrading.md`](docs/upgrading.md)

## Requirements

- OpenCode with plugin support
- At least one OpenAI-compatible provider running locally or remotely
- Provider API accessible through either a `/v1`-style base URL or an explicitly configured discovery endpoint

## Logging

When available, the plugin writes logs through OpenCode's structured server log API via `client.app.log(...)` using the service name `opencode-models-discovery`.

If structured logging is unavailable in the runtime, the plugin falls back to prefixed `console.*` output. Key log categories are emitted through metadata such as `plugin`, `config`, `discovery`, `event`, and `filtering` to make local debugging easier with `opencode --print-logs`.

## Star History

<a href="https://www.star-history.com/?repos=yuhp%2Fopencode-models-discovery&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=yuhp/opencode-models-discovery&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=yuhp/opencode-models-discovery&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=yuhp/opencode-models-discovery&type=date&legend=top-left" />
 </picture>
</a>

## Contributing

Contributions are welcome. Please feel free to submit a Pull Request.

## License

MIT

## Disclaimer

This project is not built by the OpenCode team and is not affiliated with OpenCode in any way.
