# Issue #5: `/connect`-Backed Auth Discovery

## Context

Issue #5 reported that custom OpenAI-compatible providers could be defined in `opencode.json`, but model discovery at startup still failed unless the API key was duplicated in `provider.<name>.options.apiKey`.

The expected behavior was that credentials saved through OpenCode `/connect` should also be usable for startup-time model discovery.

## Problem Statement

The plugin performs discovery during the `config` hook, before the session is fully running.

At that point, the plugin could not reliably read credentials through the public SDK alone:

- `client.auth` only exposed `set/remove`, not read methods
- `ProviderHookContext.auth` existed only inside `provider.models(provider, ctx)`
- the plugin's current architecture performs multi-provider startup discovery through the `config` hook, not a single-provider `provider` hook
- `client.config.providers()` inside the `config` hook could recurse or stall, and in practice could cause discovery timeouts

## Final Approach

Discovery credential resolution now uses this precedence order:

1. `provider.<name>.options.apiKey`
2. resolved provider credentials from OpenCode, when available quickly enough during startup
3. a fallback read of the OpenCode auth store for same-id `type: "api"` credentials

The fallback read path is:

1. `OPENCODE_AUTH_CONTENT`
2. OpenCode auth file derived from the same `xdg-basedir` data location OpenCode uses for `Global.Path.data`

This keeps explicit config as the highest-priority source, while allowing `/connect`-managed credentials to work without duplicating secrets in `opencode.json`.

## Why This Design

This approach was chosen because it satisfies the feature request while minimizing behavior changes:

- existing explicit `apiKey` configs keep working unchanged
- custom providers can rely on `/connect`
- the plugin does not write credentials back into `opencode.json`
- secret values are not logged
- startup discovery remains compatible with the plugin's current multi-provider architecture

## Constraints Discovered During Investigation

### OpenCode `/connect`

Investigation confirmed that `/connect` saves API credentials via `client.auth.set(...)` and then triggers an instance restart flow, which causes the plugin `config` hook to run again.

That restart behavior is what makes newly saved credentials available to discovery on the next bootstrap.

### SDK Limitations

At the time of implementation:

- `client.auth` had no `get` or `list`
- `ctx.auth` was not available from `PluginInput.client`
- `provider` hooks were not a good match for the plugin's current startup-wide discovery strategy

### `client.config.providers()` Reliability

Testing showed that calling `client.config.providers()` during the `config` hook could time out or recurse into provider resolution, which in earlier attempts caused discovery regressions and missing models.

The current implementation therefore only attempts resolved provider access on demand and behind a short timeout.

## Validation

The implementation was validated with:

- explicit `apiKey` providers still discovering correctly
- `/connect`-managed custom providers discovering correctly after reconnect/bootstrap
- fallback behavior through `OPENCODE_AUTH_CONTENT`
- timeout handling when resolved provider lookup is slow or unavailable
- test coverage for precedence and failure cases

## Notes

- Primary validation was done on POSIX environments such as macOS and Linux.
- Windows behavior may still need broader confirmation.
- This remains a pragmatic fallback until OpenCode exposes a better public read path for auth during startup hooks.
