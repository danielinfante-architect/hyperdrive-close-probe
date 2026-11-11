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
