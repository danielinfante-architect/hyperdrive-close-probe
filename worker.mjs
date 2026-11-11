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
