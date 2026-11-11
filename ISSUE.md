<!-- One section per field of the "Bug Report" form at https://github.com/cloudflare/workers-sdk/issues/new?template=bug-template.yaml -->

# Title

Hyperdrive: extended-protocol `Close` fails with `58000 Protocol Error: Unexpected protocol code: C` and closes the connection

# What versions & operating system are you using?

```
  System:
    OS: macOS 27.2.1
    CPU: (10) arm64 Apple M5
    Memory: 4.33 GB / 32.00 GB
    Shell: 5.9 - /bin/zsh
  Binaries:
    Node: 26.13.1 - ~/.vite-plus/js_runtime/node/26.13.1/bin/node
    Yarn: 4.18.1 - ~/.vite-plus/bin/yarn
    npm: 11.20.0 - ~/.vite-plus/js_runtime/node/26.13.1/bin/npm
    pnpm: 12.18.0 - ~/.vite-plus/bin/pnpm
    bun: 1.4.4 - ~/.vite-plus/bin/bun
  npmPackages:
    wrangler: 4.160.1 => 4.160.1
```

- Worker: compatibility date `2026-03-17`, `nodejs_compat`, deployed with `wrangler deploy`
- Hyperdrive: caching off, TLS to the client off
- Origin: PlanetScale Postgres, PostgreSQL 18.6 (`us-east-1`)
- Reproduction client: `pg` 8.23.1, low-level `client.connection`
- Client that hit it first: `@effect/sql-pg` 4.1.2 with `effect` 4.1.2 (its own wire-protocol client over `node:net`, not `pg`)

# Please provide a link to a minimal reproduction

https://github.com/danielinfante-architect/hyperdrive-close-probe

# Describe the Bug

Through Hyperdrive, every extended-protocol `Close` message (`'C'`) fails. Hyperdrive replies with an `ErrorResponse` that has SQLSTATE `58000` and the message `Protocol Error: Unexpected protocol code: C`, and then closes the client connection. This includes a lone `Close(S, name)` + `Sync` for a statement that was just prepared. PostgreSQL replies `CloseComplete` (`'3'`) to the same messages, also for a name that does not exist.

**Impact.** `@effect/sql-pg` 4.1.2 with its default `prepare: true` sends `Close` to drop a statement name after a query that carried a `Parse` fails, and when it evicts a statement from its cache. Behind Hyperdrive, the query that follows any failed query on the same connection fails with `58000` instead of running. A syntax error and a division by zero both trigger it. With `prepare: false` the client sends no `Close`, and errors are reported correctly. With the client's `multiplex: true` setting, the next query ends in a closed connection instead.

**Expected behavior.** Hyperdrive forwards or handles `Close` (target `'S'` or `'P'`) as PostgreSQL does: it replies `CloseComplete`, including for a name that does not exist, and processes the messages after it in the same write.

**Steps to reproduce.** The reproduction uses node-postgres's low-level `client.connection` to send protocol messages by hand, so it doesn't depend on `@effect/sql-pg`.

1. `npm install`
2. Put the ID of a Hyperdrive config for any PostgreSQL database in `wrangler.jsonc`. The scenarios only read and create no objects.
3. `npm run deploy`, then `curl https://hyperdrive-close-probe.<subdomain>.workers.dev`.
4. For comparison, run the same scenarios directly against PostgreSQL from Node: `npm run local -- "$DATABASE_URL"`.

Each scenario runs on a new connection and ends with a simple `select 1` to check that the connection still works (skipped when the connection is already closed):

| Scenario | Messages |
|---|---|
| `closePrepared` | `Parse s1` + `Sync`, then `Close(S, s1)` + `Sync` |
| `closeUnknown` | `Close(S, never_parsed)` + `Sync` |
| `effectSqlPgAfterParseError` | a named extended query with a syntax error, then `Close(S, previous)` + the next named extended query in one write (what `@effect/sql-pg` sends after a failed query) |
| `pipelinedCloseNoError` | a successful named extended query, then `Close(S, previous)` + the next named extended query in one write (what `@effect/sql-pg` sends when it evicts a statement from its cache) |

**Results.** Messages received per step, direct to PostgreSQL 18.3 (local Docker) and through Hyperdrive. The Hyperdrive column was the same in all 13 runs, except where noted.

| Scenario | Step | Direct to PostgreSQL | Through Hyperdrive |
|---|---|---|---|
| `closePrepared` | `Parse s1` + `Sync` | `parseComplete readyForQuery` | `readyForQuery` (9 of 13 runs) or `parseComplete readyForQuery` (4 of 13) |
| | `Close(S, s1)` + `Sync` | `closeComplete readyForQuery` | `error(58000)`, then the connection closes |
| `closeUnknown` | `Close(S, never_parsed)` + `Sync` | `closeComplete readyForQuery` | `error(58000)`, then the connection closes |
| `effectSqlPgAfterParseError` | failing named query | `error(42601) readyForQuery` | `error(42601) readyForQuery` |
| | `Close` + next named query | `closeComplete parseComplete bindComplete rowDescription dataRow commandComplete readyForQuery` | `error(58000)`, then the connection closes |
| `pipelinedCloseNoError` | named query | `parseComplete bindComplete rowDescription dataRow commandComplete readyForQuery` | same as direct |
| | `Close` + next named query | `closeComplete parseComplete bindComplete rowDescription dataRow commandComplete readyForQuery` | `error(58000)`, then the connection closes |

Direct to PostgreSQL, the control `select 1` succeeds after every scenario.

A separate difference, which can be a different issue: for a named `Parse` followed directly by `Sync`, Hyperdrive often omits `ParseComplete`. PostgreSQL always sends it. When `Bind`, `Describe` and `Execute` follow the `Parse`, `ParseComplete` was always present.

**Related.**

- #16421: Hyperdrive closes the client connection on a named `Parse` + `Describe` + `Flush` inside an aborted transaction. Different trigger: this sequence has no `Flush` and no transaction.
- Effect-TS/effect#8320 and #10151: `@effect/sql-pg` issues with prepared statements behind transaction-mode poolers, both fixed before 4.1.2. Neither covers `Close`.

# Please provide any relevant error logs

Response of the deployed reproduction Worker (one run through Hyperdrive):

```json
{
 "closePrepared": [
  {
   "label": "Parse s1 + Sync",
   "outcome": "ready",
   "received": [
    "readyForQuery"
   ]
  },
  {
   "label": "Close S s1 + Sync",
   "outcome": "connection closed",
   "received": [
    "error(58000: Protocol Error: Unexpected protocol code: C)"
   ]
  },
  {
   "label": "control: simple Query select 1",
   "outcome": "skipped: connection closed",
   "received": []
  }
 ],
 "closeUnknown": [
  {
   "label": "Close S never_parsed + Sync",
   "outcome": "connection closed",
   "received": [
    "error(58000: Protocol Error: Unexpected protocol code: C)"
   ]
  },
  {
   "label": "control: simple Query select 1",
   "outcome": "skipped: connection closed",
   "received": []
  }
 ],
 "effectSqlPgAfterParseError": [
  {
   "label": "named extended query with a syntax error",
   "outcome": "ready",
   "received": [
    "error(42601: syntax error at or near \"selec\")",
    "readyForQuery"
   ]
  },
  {
   "label": "Close S effect_a_1 + next named extended query",
   "outcome": "connection closed",
   "received": [
    "error(58000: Protocol Error: Unexpected protocol code: C)"
   ]
  },
  {
   "label": "control: simple Query select 1",
   "outcome": "skipped: connection closed",
   "received": []
  }
 ],
 "pipelinedCloseNoError": [
  {
   "label": "named extended query",
   "outcome": "ready",
   "received": [
    "parseComplete",
    "bindComplete",
    "rowDescription",
    "dataRow",
    "commandComplete",
    "readyForQuery"
   ]
  },
  {
   "label": "Close S effect_b_1 + next named extended query",
   "outcome": "connection closed",
   "received": [
    "error(58000: Protocol Error: Unexpected protocol code: C)"
   ]
  },
  {
   "label": "control: simple Query select 1",
   "outcome": "skipped: connection closed",
   "received": []
  }
 ]
}
```
