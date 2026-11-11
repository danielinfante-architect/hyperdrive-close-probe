# Hyperdrive: extended-protocol `Close` fails with `58000 Protocol Error: Unexpected protocol code: C` and closes the connection

## Summary

Through Hyperdrive, every extended-protocol `Close` message (`'C'`) fails. Hyperdrive replies with an `ErrorResponse` that has SQLSTATE `58000` and the message `Protocol Error: Unexpected protocol code: C`, and then closes the client connection. This happens for a statement that was just prepared and for a name that was never prepared. PostgreSQL replies `CloseComplete` (`'3'`) to both.

Clients that cache prepared statements send `Close` to drop a statement they no longer need, so behind Hyperdrive their connection breaks the first time they do that.

## Expected behavior

Hyperdrive forwards or handles `Close` (target `'S'` or `'P'`) as PostgreSQL does: it replies `CloseComplete`, including for a name that does not exist, and processes the messages after it in the same write.

## Reproduction

The reproduction uses node-postgres's low-level `client.connection` to send the protocol messages by hand. It runs two scenarios, each on a new connection, and ends each one with a simple `select 1` to check that the connection still works (skipped when the connection is already closed):

| Scenario | Messages |
|---|---|
| `closePrepared` | `Parse("s1", "select 1")` + `Sync`, then `Close(S, "s1")` + `Sync` |
| `closeUnknown` | `Close(S, "never_parsed")` + `Sync` |

Steps:

1. `npm install` (installs `pg` 8.23.1 and `wrangler` 4.160.1)
2. Create a Hyperdrive config for any PostgreSQL database and put its ID in `wrangler.jsonc`. The scenarios only read and create no objects.
3. `npm run deploy`, then `curl https://hyperdrive-close-probe.<subdomain>.workers.dev`.
4. For the direct column, run the same scenarios from Node: `npm run local -- "$DATABASE_URL"`.

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
    const onEnd = () => setTimeout(() => finish("connection closed"), 1000)
    const timer = setTimeout(() => finish(`no ReadyForQuery after ${timeoutMs} ms`), timeoutMs)
    connection.on("message", onMessage)
    connection.on("end", onEnd)
    send()
  })

export const scenarios = {
  closePrepared: (c) => [
    step(c, "Parse s1 + Sync", () => { c.parse({ name: "s1", text: "select 1", types: [] }); c.sync() }),
    step(c, "Close S s1 + Sync", () => { c.close({ type: "S", name: "s1" }); c.sync() }),
  ],
  closeUnknown: (c) => [
    step(c, "Close S never_parsed + Sync", () => { c.close({ type: "S", name: "never_parsed" }); c.sync() }),
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

`local-close.mjs`:

```js
import pg from "pg"
import { runScenarios } from "./close-probe.mjs"
const connect = async () => { const c = new pg.Client({ connectionString: process.argv[2] }); await c.connect(); return c }
console.log(JSON.stringify(await runScenarios(connect), null, 1))
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

## Results

Messages received per step, direct to PostgreSQL 18.3 (local Docker) and through Hyperdrive (origin PlanetScale Postgres 18.6, caching off). The Hyperdrive column was the same in all 20 runs.

| Scenario | Step | Direct to PostgreSQL | Through Hyperdrive |
|---|---|---|---|
| `closePrepared` | `Parse s1` + `Sync` | `parseComplete readyForQuery` | `readyForQuery` |
| | `Close(S, s1)` + `Sync` | `closeComplete readyForQuery` | `error(58000: Protocol Error: Unexpected protocol code: C)`, then the connection closes |
| | control `select 1` | `rowDescription dataRow commandComplete readyForQuery` | not possible, connection closed |
| `closeUnknown` | `Close(S, never_parsed)` + `Sync` | `closeComplete readyForQuery` | `error(58000: Protocol Error: Unexpected protocol code: C)`, then the connection closes |
| | control `select 1` | `rowDescription dataRow commandComplete readyForQuery` | not possible, connection closed |

A separate difference, which can be a different issue: for a named `Parse` followed directly by `Sync`, Hyperdrive omitted `ParseComplete` in 39 of 43 runs (including earlier versions of this probe with the same step). PostgreSQL always sends it.

## Related

- #16421: Hyperdrive closes the client connection on a named `Parse` + `Describe` + `Flush` inside an aborted transaction. Different trigger: this sequence has no `Flush` and no transaction.

## Environment

- Worker: compatibility date `2026-03-17`, `nodejs_compat`, deployed with `wrangler deploy` (wrangler 4.160.1) on 2026-11-11
- Hyperdrive: caching off, TLS to the client off
- Origin: PlanetScale Postgres, PostgreSQL 18.6 (`us-east-1`)
- Client: `pg` 8.23.1, low-level `client.connection`
