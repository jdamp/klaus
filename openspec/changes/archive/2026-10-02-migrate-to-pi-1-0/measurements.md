# MCP exposure fixture measurements

Measured on 2026-10-02 against the pinned Pi 1.0 packages on Node 22.23.x. The test fixture is
synthetic and does not represent Klaus's production Home Assistant or Kaneo catalogues.

## Initial declarations

The deterministic comparison used 24 MCP fixture declarations. Each had a short description and a
TypeBox object schema with a query and optional limit. Direct exposure declared all 24 tools;
deferred exposure declared only `tool_search` initially.

| Exposure | Initial declarations | Pi estimated tokens |
| --- | ---: | ---: |
| Direct | 24 | 1,976 |
| Deferred | 1 | 77 |

The estimated declaration payload fell by 96.1% for this fixture. The estimate uses Pi 1.0's
`estimateTokens()` over a system message's `toolsAdded`, which applies a characters-divided-by-four
heuristic. It excludes the shared native Klaus tools, provider-specific schema serialization, and
any additional declarations loaded after discovery.

## Discovery timing

A session recreation test used a local stdio MCP fixture with six tools in its updated catalogue.
Elapsed time from creating the Pi session to registration of the newly added tool was 405 ms. The
first local `tool_search` execution took 2 ms. These are one-run measurements on the test host; the
search timing excludes the extra model request/response needed to decide to search and use the newly
loaded tool. No remote MCP server or provider network latency was included.

Repeat with:

```sh
KLAUS_MCP_MEASURE_FILE=/tmp/klaus-pi-mcp-measurements.jsonl \
  npm test -- test/mcp-pi.test.ts -t 'estimates fewer|changed unrestricted'
```

The optional environment variable makes the tests append their raw measurements as JSON lines.
