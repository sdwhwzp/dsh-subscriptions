
import { test } from "node:test"
import assert from "node:assert/strict"
import { createVendorFromProfile, validateProfile } from "../lib/vendor-factory.js"

const PROFILE = {
  id: "myservice",
  displayName: "My Service",
  authUrl: "https://auth.myservice.com/authorize",
  tokenUrl: "https://auth.myservice.com/token",
  baseUrl: "https://api.myservice.com/v1",
  scope: "openid offline_access",
  tokenStyle: "form",
  clientId: "client123",
  redirectUri: "http://localhost:9999/callback",
  modelsPath: "/models",
  models: [{ id: "my-model", name: "My Model" }],
}

test("validateProfile accepts valid profile", () => {
  const p = validateProfile(PROFILE)
  assert.equal(p.id, "myservice")
  assert.equal(p.tokenStyle, "form")
})

test("validateProfile rejects missing required fields", () => {
  for (const key of ["id", "authUrl", "tokenUrl", "baseUrl", "clientId"]) {
    const broken = { ...PROFILE }
    delete broken[key]
    assert.throws(() => validateProfile(broken))
  }
})

test("validateProfile rejects bad id format", () => {
  assert.throws(() => validateProfile({ ...PROFILE, id: "9bad" }))
  assert.throws(() => validateProfile({ ...PROFILE, id: "has space" }))
})

test("OAuth profiles require HTTPS token endpoints outside loopback", () => {
  assert.throws(() => validateProfile({ ...PROFILE, tokenUrl: "http://auth.example.invalid/token" }), /tokenUrl/)
  assert.equal(validateProfile({ ...PROFILE, tokenUrl: "http://127.0.0.1:9876/token" }).tokenUrl, "http://127.0.0.1:9876/token")
})

const CHAT_PROFILE = {
  protocol: "chat",
  id: "staticvendor",
  baseUrl: "https://api.example.invalid/v1",
  models: ["fixture-model", { id: "second-model", name: "Second model", maxTokens: 4096 }],
}

test("static chat profiles validate endpoints and allow only request credential fields", () => {
  assert.throws(() => validateProfile({ ...CHAT_PROFILE, baseUrl: "http://api.example.invalid/v1" }), /baseUrl/)
  assert.throws(() => validateProfile({ ...CHAT_PROFILE, baseUrl: "https://user@api.example.invalid/v1" }), /baseUrl/)
  assert.throws(() => validateProfile({ ...CHAT_PROFILE, authorizeUrl: "data:text/plain,fixture" }), /authorizeUrl/)
  assert.throws(() => validateProfile({ ...CHAT_PROFILE, authorizeUrl: "http://auth.example.invalid/keys" }), /authorizeUrl/)
  for (const field of ["refreshToken", "idToken", "clientSecret", "constructor"]) {
    assert.throws(() => validateProfile({ ...CHAT_PROFILE, authFields: [field] }), /authFields/)
  }
  const profile = validateProfile({ ...CHAT_PROFILE, baseUrl: "http://[::1]:9876/v1", authFields: ["token"] })
  assert.equal(profile.baseUrl, "http://[::1]:9876/v1")
  assert.deepEqual(profile.authFields, ["token"])
})

test("static chat profiles stream with the first catalog model and a manual token", async () => {
  const vendor = createVendorFromProfile(validateProfile(CHAT_PROFILE))
  assert.deepEqual(vendor.defaults().models, ["fixture-model", "second-model"])
  assert.deepEqual(await vendor.listModels(), [
    { id: "fixture-model", name: "fixture-model" },
    CHAT_PROFILE.models[1],
  ])
  assert.throws(() => vendor.authorizeUrl(), { code: "AUTH" })
  const sent = []
  const controller = new AbortController()
  const fetchImpl = async (url, init) => {
    sent.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body), signal: init.signal })
    return new Response("data: [DONE]\n\n")
  }
  const options = { messages: [] }
  await Array.fromAsync(vendor.streamOnce({ blob: { apiKey: "manual-fixture" }, options, signal: controller.signal, fetchImpl }))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, "https://api.example.invalid/v1/chat/completions")
  assert.equal(sent[0].auth, "Bearer manual-fixture")
  assert.equal(sent[0].body.model, "fixture-model")
  assert.equal(sent[0].signal, controller.signal)
  await assert.rejects(Array.fromAsync(vendor.streamOnce({ blob: { refreshToken: "unused-fixture" }, options, fetchImpl })), { code: "AUTH" })
  assert.equal(sent.length, 1)
})

test("factory builds vendor with correct identity", () => {
  const v = createVendorFromProfile(validateProfile(PROFILE))
  assert.equal(v.id, "myservice")
  assert.deepEqual(v.providerInfo(), { id: "myservice", name: "My Service" })
})

test("authorizeUrl carries PKCE and client params", async () => {
  const v = createVendorFromProfile(validateProfile(PROFILE))
  const url = v.authorizeUrl(
    { clientId: "client123", redirectUri: "http://localhost:9999/callback", scope: "openid" },
    { challenge: "chk", state: "st" },
  )
  assert.match(url, /code_challenge=chk/)
  assert.match(url, /state=st/)
  assert.match(url, /client_id=client123/)
})

test("exchangeCode posts form to token endpoint", async () => {
  const v = createVendorFromProfile(validateProfile(PROFILE))
  let captured
  const fakeFetch = async (url, opts) => {
    captured = { url, body: String(opts.body) }
    return { ok: true, text: async () => JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }) }
  }
  const blob = await v.exchangeCode(PROFILE, { verifier: "v" }, "code123", fakeFetch)
  assert.equal(blob.accessToken, "at")
  assert.match(captured.url, /token/)
  assert.match(captured.body, /grant_type=authorization_code/)
})

test("streamOnce posts to baseUrl/responses", async () => {
  const v = createVendorFromProfile(validateProfile(PROFILE))
  let hit = ""
  const fakeFetch = async (url) => {
    hit = url
    return { ok: true, status: 200, body: (async function* () {})(), headers: { get: () => null, forEach: () => {} }, text: async () => "" }
  }
  const gen = v.streamOnce({ blob: { accessToken: "at" }, options: { model: "m", messages: [] }, fetchImpl: fakeFetch, headers: {}, config: {}, signal: undefined })
  // consume first chunk (stream is empty but fetch was called)
  try { await gen.next() } catch {}
  assert.match(hit, /\/responses$/)
})
