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

- Worker: compatibility date `2026-03-17`, `nodejs_compat`, deployed with `wrangler deploy` (wrangler 4.160.1) on 2026-11-11
- Hyperdrive: caching off, TLS to the client off
- Origin: PlanetScale Postgres, PostgreSQL 18.6 (`us-east-1`)
- Client: `pg` 8.23.1, low-level `client.connection`

# Please provide a link to a minimal reproduction

https://github.com/danielinfante-architect/hyperdrive-close-probe

# Describe the Bug

Through Hyperdrive, every extended-protocol `Close` message (`'C'`) fails. Hyperdrive replies with an `ErrorResponse` that has SQLSTATE `58000` and the message `Protocol Error: Unexpected protocol code: C`, and then closes the client connection. This happens for a statement that was just prepared and for a name that was never prepared. PostgreSQL replies `CloseComplete` (`'3'`) to both.

Clients that cache prepared statements send `Close` to drop a statement they no longer need, so behind Hyperdrive their connection breaks the first time they do that.

### Expected behavior

Hyperdrive forwards or handles `Close` (target `'S'` or `'P'`) as PostgreSQL does: it replies `CloseComplete`, including for a name that does not exist, and processes the messages after it in the same write.

### Reproduction

The reproduction uses node-postgres's low-level `client.connection` to send the protocol messages by hand. It runs two scenarios, each on a new connection, and ends each one with a simple `select 1` to check that the connection still works (skipped when the connection is already closed):

| Scenario | Messages |
|---|---|
| `closePrepared` | `Parse("s1", "select 1")` + `Sync`, then `Close(S, "s1")` + `Sync` |
| `closeUnknown` | `Close(S, "never_parsed")` + `Sync` |

Steps, with the files from the linked repository:

1. `npm install`
2. Put the ID of a Hyperdrive config for any PostgreSQL database in `wrangler.jsonc`. The scenarios only read and create no objects.
3. `npm run deploy`, then `curl https://hyperdrive-close-probe.<subdomain>.workers.dev`.
4. For comparison, run the same scenarios directly against PostgreSQL from Node: `npm run local -- "$DATABASE_URL"`.

### Results

Messages received per step, direct to PostgreSQL 18.3 (local Docker) and through Hyperdrive (origin PlanetScale Postgres 18.6, caching off). The Hyperdrive column was the same in all 20 runs.

| Scenario | Step | Direct to PostgreSQL | Through Hyperdrive |
|---|---|---|---|
| `closePrepared` | `Parse s1` + `Sync` | `parseComplete readyForQuery` | `readyForQuery` |
| | `Close(S, s1)` + `Sync` | `closeComplete readyForQuery` | `error(58000: Protocol Error: Unexpected protocol code: C)`, then the connection closes |
| | control `select 1` | `rowDescription dataRow commandComplete readyForQuery` | not possible, connection closed |
| `closeUnknown` | `Close(S, never_parsed)` + `Sync` | `closeComplete readyForQuery` | `error(58000: Protocol Error: Unexpected protocol code: C)`, then the connection closes |
| | control `select 1` | `rowDescription dataRow commandComplete readyForQuery` | not possible, connection closed |

A separate difference, which can be a different issue: for a named `Parse` followed directly by `Sync`, Hyperdrive omitted `ParseComplete` in 39 of 43 runs (including earlier versions of this probe with the same step). PostgreSQL always sends it.

### Related

- #16421: Hyperdrive closes the client connection on a named `Parse` + `Describe` + `Flush` inside an aborted transaction. Different trigger: this sequence has no `Flush` and no transaction.

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
 ]
}
```
