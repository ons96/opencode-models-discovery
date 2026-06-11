# Configuration Guide

This plugin supports both global plugin configuration and provider-level overrides.

For new setups, prefer `provider.<name>.options.modelsDiscovery` for provider-specific behavior. This keeps discovery rules close to the provider they affect and avoids older global rules unintentionally changing newer providers.

## Global Plugin Configuration

The plugin configuration is placed in the `plugin` array using tuple format `[
  "plugin-name",
  { config }
]`:

```json
{
  "plugin": [
    ["opencode-models-discovery", {
      "providers": {
        "include": [],
        "exclude": []
      },
      "models": {
        "includeRegex": [],
        "excludeRegex": []
      },
      "discovery": {
        "enabled": true
      },
      "smartModelName": false
    }]
  ]
}
```

Set `smartModelName` to `true` if you want discovered models to use human-friendly display names instead of raw model ids.

## Provider-Level Overrides

Each provider can override discovery behavior through `provider.<name>.options.modelsDiscovery`:

| Option | Type | Description |
|--------|------|-------------|
| `provider.<name>.options.modelsDiscovery.enabled` | `boolean` | Override global discovery and provider filters for a single provider |
| `provider.<name>.options.modelsDiscovery.endpoint` | `string` | Provider-specific models endpoint path. Defaults to `/v1/models` |
| `provider.<name>.options.modelsDiscovery.modelInfoEndpoint` | `string` | Provider-specific model info endpoint path. Metadata enrichment is disabled when omitted |
| `provider.<name>.options.modelsDiscovery.modelInfoFormat` | `string` | Model info response format. Currently supports `"litellm"` |
| `provider.<name>.options.modelsDiscovery.filterNonChat` | `boolean` | When model info is available, skip models whose `model_info.mode` is not `chat`. Defaults to `true` |
| `provider.<name>.options.modelsDiscovery.models.includeRegex` | `string[]` | Provider-specific model include filter |
| `provider.<name>.options.modelsDiscovery.models.excludeRegex` | `string[]` | Provider-specific model exclude filter |
| `provider.<name>.options.modelsDiscovery.smartModelName` | `boolean` | Override global `smartModelName` for a single provider |

Recommended approach:

1. Keep global plugin config minimal, or use it only as a broad default.
2. Put endpoint, enablement, and model filtering rules on each provider.
3. Use provider-level overrides whenever a provider does not follow the usual `/v1/models` convention.

If `provider.<name>.options.modelsDiscovery.endpoint` is omitted, the plugin uses `/v1/models`.

## Priority Rules

1. `provider.<name>.options.modelsDiscovery.enabled` overrides global `discovery.enabled` and `providers.include/exclude`.
2. If a provider defines its own `modelsDiscovery.models` filters, those filters replace global `models.includeRegex/excludeRegex` for that provider.
3. If a provider does not define its own model filters, global `models.includeRegex/excludeRegex` are used.
4. `provider.<name>.options.modelsDiscovery.smartModelName` overrides global `smartModelName`.

## Model Metadata Enrichment

LiteLLM exposes a richer `/v1/model/info` endpoint in addition to the OpenAI-compatible `/v1/models` endpoint. Because this endpoint is not part of the generic OpenAI-compatible API contract, metadata enrichment is opt-in.

Configure both `modelInfoEndpoint` and `modelInfoFormat` to enable it for a provider.

```json
{
  "plugin": ["opencode-models-discovery"],
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LiteLLM",
      "options": {
        "baseURL": "http://127.0.0.1:4000/v1",
        "modelsDiscovery": {
          "enabled": true,
          "endpoint": "/v1/models",
          "modelInfoEndpoint": "/v1/model/info",
          "modelInfoFormat": "litellm"
        }
      },
      "models": {}
    }
  }
}
```

When model info is available, the plugin uses LiteLLM `model_info` fields to populate OpenCode model configuration:

- `max_input_tokens`, `max_output_tokens`, and `max_tokens` become `limit.context`, `limit.input`, and `limit.output`
- `supports_reasoning` enables `reasoning`
- `supports_*_reasoning_effort` and `supported_openai_params` create reasoning `variants`
- By default, entries whose `model_info.mode` is not `chat` are skipped

For providers with custom metadata paths or non-standard behavior:

```json
{
  "provider": {
    "custom": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:9000/v1",
        "modelsDiscovery": {
          "modelInfoEndpoint": "/custom/model-info",
          "modelInfoFormat": "litellm",
          "filterNonChat": false
        }
      }
    }
  }
}
```

## Example Configurations

### Mixed Providers

```json
{
  "plugin": [
    ["opencode-models-discovery", {
      "discovery": {
        "enabled": false
      }
    }]
  ],
  "provider": {
    "lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LM Studio",
      "options": {
        "baseURL": "http://127.0.0.1:1234/v1",
        "modelsDiscovery": {
          "enabled": true,
          "endpoint": "/v1/models",
          "models": {
            "includeRegex": ["^gpt-"]
          },
          "smartModelName": true
        }
      },
      "models": {}
    },
    "deepseek": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DeepSeek",
      "options": {
        "baseURL": "https://api.deepseek.com",
        "apiKey": "sk-example-deepseek-key",
        "modelsDiscovery": {
          "enabled": true,
          "endpoint": "/models",
          "smartModelName": true
        }
      },
      "models": {}
    }
  }
}
```

In this example:

1. `lmstudio` explicitly enables discovery and uses the default `/v1/models` endpoint.
2. `lmstudio` limits discovery to models matching `^gpt-`.
3. `deepseek` explicitly enables discovery but uses `"/models"` instead of `/v1/models`.
4. The API key uses an example placeholder and should be replaced in real configs.

### Provider-First Style

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-models-discovery", {
      "smartModelName": false
    }]
  ],
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama",
      "options": {
        "baseURL": "http://127.0.0.1:11434/v1",
        "modelsDiscovery": {
          "enabled": true,
          "models": {
            "includeRegex": ["^qwen/"]
          }
        }
      }
    },
    "deepseek": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DeepSeek",
      "options": {
        "baseURL": "https://api.deepseek.com",
        "apiKey": "YOUR_DEEPSEEK_API_KEY",
        "modelsDiscovery": {
          "enabled": true,
          "endpoint": "/models",
          "smartModelName": true
        }
      }
    }
  }
}
```

In this example:

1. The global plugin config only keeps a shared default.
2. `ollama` uses the default discovery path derived from its `/v1` baseURL.
3. `deepseek` does not rely on `/v1/models` and explicitly uses `"/models"`.
4. Each provider can evolve independently without changing global include or endpoint rules.

## Provider Filtering

Control which providers are discovered:

| Option | Type | Description |
|--------|------|-------------|
| `providers.include` | `string[]` | If non-empty, only these providers will be discovered |
| `providers.exclude` | `string[]` | These providers will be skipped when `include` is empty |

```json
{
  "plugin": [
    ["opencode-models-discovery", {
      "providers": {
        "include": ["ollama"],
        "exclude": ["lmstudio"]
      }
    }]
  ]
}
```

## Model Filtering

Control which discovered models are auto-injected with regular expressions:

| Option | Type | Description |
|--------|------|-------------|
| `models.includeRegex` | `string[]` | If non-empty, only discovered model ids matching at least one regex will be added |
| `models.excludeRegex` | `string[]` | Discovered model ids matching any regex will be skipped when `includeRegex` is empty |

Regex filtering only applies to auto-discovered models. Models already explicitly configured by the user are preserved.

```json
{
  "plugin": [
    ["opencode-models-discovery", {
      "models": {
        "includeRegex": ["^qwen/", "gpt-4"],
        "excludeRegex": ["embedding", "test"]
      }
    }]
  ]
}
```
