# Upgrading

## Refresh Plugin Cache After Upgrade

If you upgrade `opencode-models-discovery` and OpenCode still behaves like it is using an older version, refresh the OpenCode plugin cache and restart OpenCode.

This is worth checking when:

- a newly released feature does not appear after upgrading
- behavior still matches an older plugin build
- issue fixes seem not to have taken effect locally

OpenCode may continue using a cached plugin package even after the npm package has been updated.

## Recommended Upgrade Checklist

1. Upgrade the npm package version you use.
2. Restart OpenCode.
3. If behavior still looks stale, refresh the OpenCode plugin cache.
4. Start OpenCode again and verify the plugin version now matches the expected build.

## When This Matters Most

This is especially relevant after upgrades that change startup-time behavior, such as:

- model discovery behavior
- `/connect` credential discovery
- provider-specific discovery endpoints
- model filtering or metadata enrichment
