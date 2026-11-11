import pg from "pg"
import { runScenarios } from "./close-probe.mjs"
const connect = async () => { const c = new pg.Client({ connectionString: process.argv[2] }); await c.connect(); return c }
console.log(JSON.stringify(await runScenarios(connect), null, 1))
