# Hyperdrive answers an extended-protocol `Close` message with `58000 Protocol Error: Unexpected protocol code: C`

## Summary

With `@effect/sql-pg` 4.1.2 and its default `prepare: true`, behind Hyperdrive, the query that follows any failed query on the same connection fails with an `ErrorResponse` that has SQLSTATE `58000` and the message `Protocol Error: Unexpected protocol code: C`. The same sequence against PostgreSQL directly succeeds.

Neither the message nor the code `58000` appears in the client's source, so Hyperdrive sends the `ErrorResponse`. In the frontend protocol, `C` is `Close`. The failing write is the only one in the sequence that starts with a `Close` message:

| Step | Client sends (one write) | PostgreSQL directly | Through Hyperdrive |
|---|---|---|---|
| 1 | `Parse("effect_a_1", "selec 1")`, `Bind`, `Describe(P)`, `Execute`, `Sync` | `ErrorResponse 42601`, `ReadyForQuery` | `ErrorResponse 42601` (correct) |
| 2 | `Close(S, "effect_a_1")`, `Parse("effect_a_2", "select $1::int")`, `Bind`, `Describe(P)`, `Execute`, `Sync` | `CloseComplete`, `ParseComplete`, `BindComplete`, `RowDescription`, `DataRow`, `CommandComplete`, `ReadyForQuery` | `ErrorResponse 58000 Protocol Error: Unexpected protocol code: C` |

The client sends the `Close` because a cycle that carried a `Parse` failed, so it drops that statement name before using a new one. A division-by-zero error on a prepared statement triggers the same `Close` and the same failure. With `prepare: false`, the client sends no `Close`, and through Hyperdrive every error is reported correctly and the connection keeps working (same `pg_backend_pid()` after the error).

With the client's `multiplex: true` setting, step 2 ends in a closed connection instead of the `58000` error.

The reproduction below shows that the client and the failed query are not needed: through Hyperdrive, every `Close` fails, including a lone `Close` + `Sync` for a statement that was just prepared. Hyperdrive sends the `58000` `ErrorResponse` and then closes the client connection.

## Expected behavior

Hyperdrive forwards or handles `Close` (`'C'`, target `'S'` or `'P'`) as PostgreSQL does: it replies `CloseComplete` (`'3'`), including for a name that does not exist, and processes the messages after it in the same write.

## Reproduction

The reproduction uses node-postgres 8.23.1's low-level `client.connection` to send the protocol messages by hand, so it doesn't depend on `@effect/sql-pg`. It runs four scenarios, each on a new connection, and ends each one with a simple `select 1` to show whether the connection still works (skipped when the connection is already closed):

| Scenario | Messages |
|---|---|
| `closePrepared` | `Parse s1` + `Sync`, then `Close(S, s1)` + `Sync` |
| `closeUnknown` | `Close(S, never_parsed)` + `Sync` |
| `effectSqlPgAfterParseError` | the two writes in the table above |
| `pipelinedCloseNoError` | a successful named extended query, then `Close(S, previous)` + the next named extended query in one write (what `@effect/sql-pg` sends when it evicts a statement from its cache) |

`close-probe.mjs`:

```js
const MESSAGE_EVENTS = [
  "errorMessage", "readyForQuery", "rowDescription", "dataRow", "commandComplete",
  "parseComplete", "bindComplete", "closeComplete", "noData", "portalSuspended",
  "emptyQuery", "parameterDescription", "notice",
]

const step = (connection, label, send, syncs = 1, timeoutMs = 3000) => () =>
  new Promise((resolve) => {
    const received = []
    let ready = 0
    const finish = (outcome) => {
      connection.off("message", onMessage)
      connection.off("end", onEnd)
      clearTimeout(timer)
      resolve({ label, outcome, received })
    }
    const onMessage = (msg) => {
      received.push(msg.name === "error" ? `error(${msg.code}: ${msg.message})` : msg.name)
      if (msg.name === "readyForQuery" && ++ready === syncs) finish("ready")
    }
    // A Worker socket can report the close before the last message, so wait for trailing messages.
    const onEnd = () => setTimeout(() => finish("connection closed"), 250)
    const timer = setTimeout(() => finish(`no ReadyForQuery after ${timeoutMs} ms`), timeoutMs)
    connection.on("message", onMessage)
    connection.on("end", onEnd)
    send()
  })

const extendedQuery = (connection, name, text, values = []) => {
  connection.parse({ name, text, types: [] })
  connection.bind({ portal: "", statement: name, values })
  connection.describe({ type: "P", name: "" })
  connection.execute({ portal: "", rows: 0 })
}

export const scenarios = {
  closePrepared: (c) => [
    step(c, "Parse s1 + Sync", () => { c.parse({ name: "s1", text: "select 1", types: [] }); c.sync() }),
    step(c, "Close S s1 + Sync", () => { c.close({ type: "S", name: "s1" }); c.sync() }),
  ],
  closeUnknown: (c) => [
    step(c, "Close S never_parsed + Sync", () => { c.close({ type: "S", name: "never_parsed" }); c.sync() }),
  ],
  effectSqlPgAfterParseError: (c) => [
    step(c, "named extended query with a syntax error", () => { extendedQuery(c, "effect_a_1", "selec 1"); c.sync() }),
    step(c, "Close S effect_a_1 + next named extended query", () => {
      c.close({ type: "S", name: "effect_a_1" })
      extendedQuery(c, "effect_a_2", "select $1::int as i", ["1"])
      c.sync()
    }),
  ],
  pipelinedCloseNoError: (c) => [
    step(c, "named extended query", () => { extendedQuery(c, "effect_b_1", "select 2 as two"); c.sync() }),
    step(c, "Close S effect_b_1 + next named extended query", () => {
      c.close({ type: "S", name: "effect_b_1" })
      extendedQuery(c, "effect_b_2", "select $1::int as i", ["1"])
      c.sync()
    }),
  ],
}

export const runScenarios = async (connect) => {
  const results = {}
  for (const [name, build] of Object.entries(scenarios)) {
    const client = await connect()
    client.on("error", () => {})
    const connection = client.connection
    for (const event of MESSAGE_EVENTS) connection.removeAllListeners(event)
    const steps = []
    for (const run of build(connection)) {
      const result = await run()
      steps.push(result)
      if (result.outcome !== "ready") break
    }
    if (steps.at(-1).outcome === "connection closed") steps.push({ label: "control: simple Query select 1", outcome: "skipped: connection closed", received: [] })
    else steps.push(await step(connection, "control: simple Query select 1", () => connection.query("select 1"))())
    results[name] = steps
    await client.end().catch(() => {})
  }
  return results
}
```

`worker.mjs`:

```js
import pg from "pg"
import { runScenarios } from "./close-probe.mjs"

export default {
  async fetch(_request, env) {
    const connect = async () => {
      const client = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString })
      await client.connect()
      return client
    }
    return Response.json(await runScenarios(connect))
  },
}
```

`wrangler.jsonc`:

```jsonc
{
  "name": "hyperdrive-close-probe",
  "main": "worker.mjs",
  "compatibility_date": "2026-03-17",
  "compatibility_flags": ["nodejs_compat"],
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<hyperdrive-config-id>" }]
}
```

Steps:

1. `npm install` (installs `pg` 8.23.1 and `wrangler` 4.160.1)
2. Create a Hyperdrive config for any PostgreSQL database and put its ID in `wrangler.jsonc`. The scenarios only read and create no objects.
3. `npm run deploy`, then `curl https://hyperdrive-close-probe.<subdomain>.workers.dev`.
4. For the direct column, run the same scenarios from Node: `npm run local -- "$DATABASE_URL"`, where `local-close.mjs` is:

   ```js
   import pg from "pg"
   import { runScenarios } from "./close-probe.mjs"
   const connect = async () => { const c = new pg.Client({ connectionString: process.argv[2] }); await c.connect(); return c }
   console.log(JSON.stringify(await runScenarios(connect), null, 1))
   ```

## Results

Direct to PostgreSQL 18.3 (local Docker) and through Hyperdrive (origin PlanetScale Postgres 18.6, caching off), messages received per step. The Hyperdrive column is the same in all 13 runs, except for the `Parse s1` + `Sync` step, which is described below the table.

| Scenario | Step | Direct to PostgreSQL | Through Hyperdrive |
|---|---|---|---|
| `closePrepared` | `Parse s1` + `Sync` | `parseComplete readyForQuery` | `readyForQuery` (9 of 13 runs) or `parseComplete readyForQuery` (4 of 13) |
| | `Close(S, s1)` + `Sync` | `closeComplete readyForQuery` | `error(58000: Protocol Error: Unexpected protocol code: C)`, then the connection closes |
| | control `select 1` | `rowDescription dataRow commandComplete readyForQuery` | not possible, connection closed |
| `closeUnknown` | `Close(S, never_parsed)` + `Sync` | `closeComplete readyForQuery` | `error(58000: Protocol Error: Unexpected protocol code: C)`, then the connection closes |
| | control `select 1` | `rowDescription dataRow commandComplete readyForQuery` | not possible, connection closed |
| `effectSqlPgAfterParseError` | failing named query | `error(42601) readyForQuery` | `error(42601) readyForQuery` |
| | `Close` + next named query | `closeComplete parseComplete bindComplete rowDescription dataRow commandComplete readyForQuery` | `error(58000: Protocol Error: Unexpected protocol code: C)`, then the connection closes |
| | control `select 1` | `rowDescription dataRow commandComplete readyForQuery` | not possible, connection closed |
| `pipelinedCloseNoError` | named query | `parseComplete bindComplete rowDescription dataRow commandComplete readyForQuery` | `parseComplete bindComplete rowDescription dataRow commandComplete readyForQuery` |
| | `Close` + next named query | `closeComplete parseComplete bindComplete rowDescription dataRow commandComplete readyForQuery` | `error(58000: Protocol Error: Unexpected protocol code: C)`, then the connection closes |
| | control `select 1` | `rowDescription dataRow commandComplete readyForQuery` | not possible, connection closed |

A separate difference, which can be a different issue: for a named `Parse` followed directly by `Sync`, Hyperdrive often omits `ParseComplete`. PostgreSQL always sends it. In the other scenarios, where `Bind`, `Describe` and `Execute` follow the `Parse`, `ParseComplete` was always present.

Already observed through Hyperdrive with `@effect/sql-pg` 4.1.2 on a deployed Worker with `prepare: true`, every time:

- syntax error, then `Close` + next query on a reserved connection: step 2 fails with `58000 Protocol Error: Unexpected protocol code: C` (2 of 2 runs)
- `select 1/0`, then `Close` + `select * from missing_table`: the second query fails with the same `58000` instead of `42P01` (5 of 5 runs)

With `prepare: false`, the same queries return `42601` and `42P01`, and the connection keeps working (5 runs; the same-connection check, with the same `pg_backend_pid()` before and after, ran in 2 of them).

## Environment

- Worker: compatibility date `2026-03-17`, `nodejs_compat`. The `@effect/sql-pg` failures came from a Workers Builds preview deployment. The reproduction was deployed with `wrangler deploy` (wrangler 4.160.1) on 2026-11-11.
- Hyperdrive: caching off, TLS to the client off
- Origin: PlanetScale Postgres, PostgreSQL 18.6 (`us-east-1`)
- Client that hit it first: `@effect/sql-pg` 4.1.2 with `effect` 4.1.2 (its own wire-protocol client over `node:net`, not `pg`)
- Reproduction client: `pg` 8.23.1, low-level `client.connection`

## Related

- #16421: Hyperdrive closes the client connection on a named `Parse` + `Describe` + `Flush` inside an aborted transaction. Different trigger: our sequence has no `Flush` and no transaction.
- Effect-TS/effect#8320 and #10151: `@effect/sql-pg` issues with prepared statements behind transaction-mode poolers, both fixed before 4.1.2. Neither covers `Close`.
