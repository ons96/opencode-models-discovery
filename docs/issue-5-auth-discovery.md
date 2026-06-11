# Issue #5: Auth-Backed Model Discovery for Custom Providers

## Summary

Issue #5 asks whether `opencode-models-discovery` can use credentials stored by OpenCode's `/connect` flow instead of requiring `provider.<id>.options.apiKey` in `opencode.json`.

The initial concern looked like it might overlap with built-in OpenCode providers, because built-in providers connected through `/connect` usually already expose their model lists through OpenCode itself. The follow-up clarified that the affected case is different: a custom OpenAI-compatible provider uses `/connect` for credentials, but still needs this plugin for dynamic model discovery.

## User Scenario

The reported setup is a local LiteLLM proxy configured as a custom OpenAI-compatible provider:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-models-discovery", {
      "providers": { "include": ["breeze"] },
      "smartModelName": true
    }]
  ],
  "provider": {
    "breeze": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Breeze",
      "options": {
        "baseURL": "http://localhost:4000/v1"
      }
    }
  }
}
```

OpenCode `/connect` is then used with the `other custom provider` flow. OpenCode stores the API credential under the same provider id:

```json
{
  "breeze": {
    "type": "api",
    "key": "sk-..."
  }
}
```

OpenCode stores the credential successfully, but it does not automatically discover and expose the LiteLLM model list for this custom provider. This plugin is expected to perform that discovery, but it currently sends the model discovery request without the `/connect` credential.

## Current Behavior

The plugin currently discovers models during the `config` hook. For each provider it reads only the API key from provider options:

```ts
const apiKey = p.options?.apiKey
```

That value is passed to the model discovery request and, when present, becomes a Bearer token:

```ts
headers["Authorization"] = `Bearer ${apiKey}`
```

If the provider config omits `options.apiKey`, the discovery request is unauthenticated. For auth-protected LiteLLM or gateway deployments, `/v1/models` then fails or returns no usable result.

## Expected Behavior

For custom OpenAI-compatible providers, the plugin should ideally be able to reuse the provider credential already resolved by OpenCode when all of the following are true:

1. The provider is configured in `opencode.json`.
2. The provider id matches a credential created through `/connect`.
3. The credential is available through an official OpenCode plugin or SDK API.
4. No explicit `provider.<id>.options.apiKey` is configured.

An explicit `options.apiKey` should keep priority over any resolved auth credential to preserve existing behavior and user intent.

## Why Built-In Providers Are Different

For built-in providers, OpenCode typically owns both authentication and model listing. The documented flow is:

1. Run `/connect`.
2. Add the provider credential.
3. Run `/models` and select from the provider's available models.

For those providers, this plugin should not need to read OpenCode auth or duplicate model discovery. Duplicating discovery could conflict with OpenCode's provider directory, Models.dev metadata, or provider-specific model definitions.

The issue is therefore scoped to custom providers whose credentials are managed by OpenCode but whose models are not automatically populated by OpenCode.

## Why Direct `auth.json` Reads Are Risky

The plugin should avoid directly reading `~/.local/share/opencode/auth.json`.

Reasons:

1. The path is an OpenCode implementation detail and may vary by platform, version, or environment.
2. The file format is an internal storage format, not a stable plugin API.
3. Reading auth files directly expands the plugin's security responsibility.
4. It could bypass future OpenCode auth behavior such as refresh, migration, encryption, provider aliases, or workspace-specific auth resolution.

The right target is not `auth.json` as a file. The right target is OpenCode's resolved provider authentication, if exposed through a supported API.

## Relevant OpenCode Plugin APIs

The installed `@opencode-ai/plugin` types show a provider hook with auth context:

```ts
export type ProviderHookContext = {
  auth?: Auth
}

export type ProviderHook = {
  id: string
  models?: (provider: ProviderV2, ctx: ProviderHookContext) => Promise<Record<string, ModelV2>>
}
```

This suggests that `provider.models` may be the official auth-aware path for dynamic model listing. However, this project currently uses the `config` hook to mutate provider configuration, so adopting `provider.models` may require an architectural change or an additional code path.

The SDK types also expose resolved providers with fields such as `id`, `source`, `key`, `options`, and `models`. This may allow investigation into whether `client.config.providers()` can return a resolved provider key during the `config` hook, but that needs runtime validation.

## Possible Implementation Paths

### Option 1: Resolve Provider Key During Config Hook

Investigate whether `client.config.providers()` can be called from the `config` hook and whether it returns the `/connect` credential as `provider.key` for custom providers.

Benefits:

1. Minimal disruption to the current architecture.
2. Existing config mutation behavior can remain mostly unchanged.
3. Provider-level filtering and model enrichment can continue to work in the same path.

Risks:

1. The resolved provider list may not be available yet during the config hook.
2. Calling config/provider resolution from inside a config hook may be recursive or unstable.
3. The returned `key` field may not be intended for plugin use.

### Option 2: Add or Migrate to Provider Models Hook

Use OpenCode's `provider.models` hook, where `ctx.auth` appears to be provided explicitly.

Benefits:

1. Likely the most official auth-aware mechanism.
2. Avoids direct auth store access.
3. Better semantic fit for dynamic model listing.

Risks:

1. The hook shape appears to target one provider id at a time, while this plugin currently discovers models for all configured providers.
2. It may require users to configure the plugin differently or require one hook per provider.
3. Existing behavior based on config injection may need compatibility handling.
4. Model metadata enrichment and provider/model filters would need to be mapped into the hook flow.

### Option 3: Document Explicit Credential Workarounds Only

Keep the current plugin behavior and document that discovery credentials must be configured explicitly for custom providers.

Recommended examples:

```jsonc
{
  "provider": {
    "breeze": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Breeze",
      "options": {
        "baseURL": "http://localhost:4000/v1",
        "apiKey": "{env:BREEZE_API_KEY}"
      }
    }
  }
}
```

```jsonc
{
  "provider": {
    "breeze": {
      "options": {
        "baseURL": "http://localhost:4000/v1",
        "apiKey": "{file:~/.secrets/breeze-key}"
      }
    }
  }
}
```

Benefits:

1. No dependency on uncertain OpenCode plugin behavior.
2. Keeps security and behavior explicit.
3. Works today.

Risks:

1. Users must duplicate credentials outside `/connect`.
2. The plugin remains less integrated with OpenCode's auth flow.
3. The issue's core request remains unresolved.

## Recommended Direction

Treat the issue as a valid feature request for custom providers, but do not implement direct `auth.json` parsing.

Recommended investigation order:

1. Verify whether resolved auth can be accessed safely from the current `config` hook.
2. If not, verify whether `provider.models` can support this plugin's multi-provider discovery model.
3. If neither official path works, document explicit credential configuration as the supported approach and explain why `/connect` credentials cannot currently be reused.

## Implementation Direction

The plugin now follows Option 1 for the current config-hook architecture.

During model discovery it attempts to read OpenCode's resolved providers through `client.config.providers()`. When OpenCode returns a provider entry with a `key`, the plugin can use that key as the discovery credential for the matching configured provider id.

Credential precedence is:

1. `provider.<id>.options.apiKey`
2. Resolved OpenCode provider `key`, which may come from `/connect` auth or environment resolution
3. No credential

This keeps explicit project configuration as the highest-priority source while allowing custom providers such as `test_provider` or `breeze` to omit `options.apiKey` and reuse credentials saved through `/connect`.

If `client.config.providers()` is unavailable, fails, or returns an unexpected shape, discovery falls back to the previous behavior and continues without resolved auth. The plugin still does not read `auth.json` directly.

Runtime validation showed that `client.config.providers()` can time out when called from the OpenCode `config` hook. To keep existing providers working, the plugin only attempts this lookup when a provider does not already have `options.apiKey`, and the lookup has a short timeout.

Because the resolved provider API is not currently reliable in the config hook, the implementation includes a constrained fallback for `/connect` credentials:

1. Respect `OPENCODE_AUTH_CONTENT` when present, matching OpenCode's own auth override behavior.
2. Read the OpenCode auth store from `path.join(xdgData, "opencode", "auth.json")`, matching OpenCode's `Global.Path.data` construction from `xdg-basedir`, only when no explicit `options.apiKey` exists and resolved provider lookup did not provide a key.
3. Use only same-id `type: "api"` credentials for discovery.
4. Never write the credential back into `opencode.json` or log the credential value.

This fallback is less ideal than a first-class plugin auth API, but it is currently necessary for auth-backed discovery from the config hook.

## Temporary Workarounds

Users can provide the LiteLLM or gateway credential explicitly without hardcoding it in the config.

Environment variable:

```jsonc
"options": {
  "baseURL": "http://localhost:4000/v1",
  "apiKey": "{env:BREEZE_API_KEY}"
}
```

File substitution:

```jsonc
"options": {
  "baseURL": "http://localhost:4000/v1",
  "apiKey": "{file:~/.secrets/breeze-key}"
}
```

## Open Questions

1. Does `client.config.providers()` return `provider.key` for a custom provider connected through `/connect` during the `config` hook?
2. If it does, is that field part of a stable API contract for plugins?
3. Does calling `client.config.providers()` from the `config` hook cause recursion or timing issues?
4. Can a plugin register dynamic `provider.models` behavior for arbitrary configured providers, or only for a fixed provider id?
5. Can the current config-hook injection path coexist with a provider-hook path without duplicate model entries?
6. How should OAuth or non-API-key auth types behave for OpenAI-compatible discovery requests?
7. Should auth-backed discovery be opt-in per provider, or should it be the default fallback when `options.apiKey` is absent?
