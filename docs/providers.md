# Provider Compatibility

## Supported Providers

The plugin supports any OpenAI-compatible provider. Common examples:

| Provider | Default Port | Use Case | npm Package |
|----------|-------------|----------|-------------|
| Ollama | 11434 | Local model inference engine | `@ai-sdk/openai-compatible` |
| LM Studio | 1234 | Local LLM with UI | `@ai-sdk/openai-compatible` |
| LocalAI | 8080 | Self-hosted AI inference | `@ai-sdk/openai-compatible` |
| llama.cpp Server | 8080 | Standalone llama.cpp server | `@ai-sdk/openai-compatible` |
| Text Generation WebUI | 5000 | OpenAI-compatible extension | `@ai-sdk/openai-compatible` |
| FastChat (Vicuna) | 8001 | Multi-model serving | `@ai-sdk/openai-compatible` |
| vLLM | 8000 | High-performance inference | `@ai-sdk/openai-compatible` |
| DeepSeek | Cloud | OpenAI-compatible API with `/models` discovery endpoint | `@ai-sdk/openai-compatible` |
| CLIProxyAPI | 8317 | LLM proxy server | `@ai-sdk/anthropic` with `/v1` backend and `@ai-sdk/openai-compatible` |

## Anthropic API with Custom Backend

Providers using `@ai-sdk/anthropic` but backed by OpenAI-compatible servers are also supported:

```json
{
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/anthropic",
      "name": "Ollama (Anthropic Mode)",
      "options": {
        "baseURL": "http://127.0.0.1:11434/v1"
      }
    }
  }
}
```

## Cloud OpenAI-Compatible Services

Cloud services with OpenAI-compatible APIs are also supported, including:

- Cloudflare Workers AI
- Azure OpenAI Service with appropriate endpoint configuration
- Groq
- Together AI
- Perplexity AI
- Any custom OpenAI-compatible API

## Provider Detection

The plugin identifies OpenAI-compatible providers using these signals:

1. Strict detection: `npm === "@ai-sdk/openai-compatible"`
2. URL-based detection: `baseURL` contains a `/v1/` pattern
3. Endpoint override detection: `options.modelsDiscovery.endpoint` is configured

In addition, `options.modelsDiscovery.enabled === true` can force discovery even when the provider does not match the detection rules above.

A provider is considered discoverable if it matches any detection signal above, or if discovery is explicitly forced on.

## Supported Configuration Examples

### Standard OpenAI-Compatible Provider

```json
{
  "plugin": ["opencode-models-discovery"],
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama",
      "options": {
        "baseURL": "http://127.0.0.1:11434/v1"
      }
    }
  }
}
```

### Anthropic SDK with OpenAI-Compatible Backend

```json
{
  "plugin": ["opencode-models-discovery"],
  "provider": {
    "ollama-anthropic": {
      "npm": "@ai-sdk/anthropic",
      "name": "Ollama (Anthropic Mode)",
      "options": {
        "baseURL": "http://127.0.0.1:11434/v1"
      }
    }
  }
}
```

### Explicit Provider-Level Discovery

```json
{
  "plugin": [
    ["opencode-models-discovery", {
      "smartModelName": false
    }]
  ],
  "provider": {
    "lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LM Studio",
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

### Non-`/v1` Discovery Endpoint

```json
{
  "plugin": ["opencode-models-discovery"],
  "provider": {
    "deepseek": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DeepSeek",
      "options": {
        "baseURL": "https://api.deepseek.com",
        "modelsDiscovery": {
          "endpoint": "/models"
        }
      }
    }
  }
}
```

This means providers using `@ai-sdk/anthropic` with OpenAI-compatible backends are supported when the `baseURL` contains `/v1/`, when a provider-specific discovery endpoint is configured, or when provider-level discovery is explicitly forced on. It also means providers like DeepSeek can be discovered from a non-`/v1` baseURL as long as the models endpoint is configured explicitly.
