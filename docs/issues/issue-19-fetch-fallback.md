# Issue 19: Fetch Timeout Fallback

## Context

Some OpenAI-compatible HTTP gateways can respond successfully to `curl` and Node's low-level `http` module while Node's built-in `fetch()` times out. This has been observed with plain HTTP local gateways such as OmniRoute on `http://127.0.0.1:20128`.

Node's global `fetch()` is implemented by undici. It is the preferred high-level request API for now, but it can behave differently from Node's lower-level `http` and `https` modules against non-standard or minimal HTTP servers.

## Current Patch Strategy

The current patch keeps `fetch()` as the primary request path and only falls back to Node's `http` / `https` modules when `fetch()` throws, such as on timeout or network-level failures.

Fallback should not run when `fetch()` receives a valid HTTP response. These cases must preserve the existing behavior:

- non-2xx HTTP responses
- successful responses with an empty model list
- successful responses with invalid or empty JSON bodies

The fallback helper should preserve the same observable behavior as the fetch path as much as possible:

- use the same timeout value
- pass the same headers, including `Authorization`
- only treat 2xx status codes as successful
- catch JSON parse errors
- destroy the request on timeout
- settle the Promise only once

## Follow-Up Refactor

This fallback is intentionally a patch-level compatibility fix, not the final HTTP client design.

Later, we plan to refactor model discovery requests to use a single low-level Node `http` / `https` request helper instead of `fetch()`. That refactor should be done separately because it changes the core request implementation and requires broader validation.

The future helper should cover at least:

- `http:` and `https:` URLs
- status code validation
- JSON parsing and parse failure handling
- timeout and request cleanup
- response stream errors
- shared headers and auth handling
- consistent return semantics for model discovery and model info discovery
- tests for success, non-2xx, invalid JSON, timeout, and transport errors
