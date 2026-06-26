# Changelog

All notable changes to `opencode-models-discovery` are documented here. Versions follow [SemVer](https://semver.org/). This project does NOT tag a new release for every PR — releases are cut from `main` via `bun run release`.

## Unreleased

### Fixed
- **#242**: Trimmed models re-appearing after `/v1/models` re-probe. Per-provider `models.includeRegex` / `models.excludeRegex` are now re-applied at the merge step (Phase 3) AND at the throttled cache-seed step. Trimmed-out model ids can never re-enter the live config.

### Added
- `provider.modelsDiscovery.preserve`: an explicit pin list of model ids the plugin MUST keep when already present and MUST NOT auto-add. Useful for models that are hosted outside `/v1/models` or for honoring curated keep-lists after a future probe.

## 0.11.1

- Mutate `p.models` in place to avoid forcing OpenCode TUI to re-render the entire picker on every change.
- Cache writes routed through OpenCode logger.
- Test cache isolated from real user cache.

## 0.11.0

- 24h throttle on model discovery to skip noisy probes on every startup.
- Added `MODELS_DISCOVERY_FORCE=1` to bypass throttle.

## 0.10.x

- Parallel discovery + persistent disk cache.
- Probe any provider with a `baseURL`, not just `@ai-sdk/openai-compatible` ones.
