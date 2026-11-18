import { test } from "node:test"
import assert from "node:assert/strict"
import { startLoopback } from "../lib/loopback.js"

async function listeningFlow(t, hostname, onCode) {
  const listening = Promise.withResolvers()
  const flow = startLoopback({
    redirectUri: `http://${hostname}:0/callback`,
    timeoutMs: 5000,
    onCode,
    onListening: listening.resolve,
  })
  t.after(async () => {
    flow.close("test ended")
    await flow.catch(() => {})
  })
  const port = await Promise.race([
    listening.promise,
    flow.then(() => { throw new Error("flow settled before listening") }),
  ])
  return { flow, callback: `http://${hostname}:${port}/callback` }
}

test("loopback: rejects non-loopback redirect", () => {
  assert.throws(
    () => startLoopback({ redirectUri: "https://console.anthropic.com/callback", onCode: async () => "" }),
    /loopback redirect requires localhost/,
  )
})

test("loopback: catches code/state and completes", async t => {
  let received = null
  const { flow, callback } = await listeningFlow(t, "127.0.0.1", async params => {
    received = { code: params.get("code"), state: params.get("state") }
    return "<html>ok</html>"
  })
  const res = await fetch(`${callback}?code=abc&state=xyz`, { headers: { Connection: "close" } })
  const text = await res.text()
  assert.equal(res.status, 200)
  assert.ok(text.includes("ok"))
  assert.deepEqual(received, { code: "abc", state: "xyz" })
  await flow
  await assert.rejects(() => fetch(callback), /fetch failed|ECONNREFUSED/)
})

test("loopback: onCode throw -> ERR_HTML, server closes", async t => {
  const { flow, callback } = await listeningFlow(t, "localhost", async () => { throw new Error("boom") })
  const res = await fetch(`${callback}?code=bad`, { headers: { Connection: "close" } })
  const text = await res.text()
  assert.equal(res.status, 200)
  assert.ok(text.includes("Login failed"))
  await flow
  await assert.rejects(() => fetch(callback), /fetch failed|ECONNREFUSED/)
})
