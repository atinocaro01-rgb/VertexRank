import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { parseServiceAccount, signJwt, createGscAuth, GscError, GSC_SCOPE, TOKEN_ENDPOINT } from "../lib/gscAuth.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const keyFile = { type: "service_account", client_email: "vertexrank@proj.iam.gserviceaccount.com", private_key: privateKey, token_uri: "https://evil.example/token" };
const json = JSON.stringify(keyFile);
const dec = (s) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

test("parseServiceAccount: raw JSON, base64 JSON, double-escaped newlines, and not-configured", () => {
  assert.equal(parseServiceAccount(""), null); assert.equal(parseServiceAccount(undefined), null); assert.equal(parseServiceAccount("   "), null);
  for (const v of [json, Buffer.from(json).toString("base64")]) { const sa = parseServiceAccount(v); assert.equal(sa.clientEmail, keyFile.client_email); assert.equal(sa.privateKey, privateKey); }
  const escaped = JSON.stringify({ ...keyFile, private_key: privateKey.replace(/\n/g, "\\n") });
  assert.equal(parseServiceAccount(escaped).privateKey, privateKey);
});

test("parseServiceAccount: unusable values are refused with messages that never echo the value", () => {
  for (const bad of ["not json", "{}", JSON.stringify({ client_email: "a@b.c" }), JSON.stringify({ client_email: "nope", private_key: privateKey }), JSON.stringify({ client_email: "a@b.c", private_key: "SECRET-NOT-A-KEY" })]) {
    assert.throws(() => parseServiceAccount(bad), (e) => e instanceof GscError && e.code === "BAD_CONFIG" && !e.message.includes("SECRET-NOT-A-KEY") && !e.message.includes("PRIVATE"), bad.slice(0, 30));
  }
});

test("the JWT is a valid RS256 token with the right claims, signed by the key", () => {
  const sa = parseServiceAccount(json);
  const jwt = signJwt(sa, 1_800_000_000);
  const [h, c, s] = jwt.split(".");
  assert.deepEqual(dec(h), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(dec(c), { iss: keyFile.client_email, scope: GSC_SCOPE, aud: TOKEN_ENDPOINT, iat: 1_800_000_000, exp: 1_800_003_600 });
  assert.equal(GSC_SCOPE, "https://www.googleapis.com/auth/webmasters.readonly"); // read-only, never a write scope
  const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
  assert.equal(ok, true, "signature verifies against the public key");
  assert.ok(!/[+/=]/.test(jwt), "base64url, no padding");
  assert.throws(() => signJwt({ clientEmail: "a@b.c", privateKey: "-----BEGIN PRIVATE KEY-----\nbroken\n-----END PRIVATE KEY-----" }, 1), (e) => e.code === "BAD_CONFIG" && !e.message.includes("broken"));
});

function fakeTokenFetch(handler) { const calls = []; const f = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); }; f.calls = calls; return f; }
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test("token exchange posts to Google's fixed endpoint, ignoring the key file's token_uri; the token is cached until a minute before expiry", async () => {
  let t = 1_000_000;
  const f = fakeTokenFetch(() => ok({ access_token: "tok-1", expires_in: 3600 }));
  const auth = createGscAuth({ env: { GOOGLE_SERVICE_ACCOUNT_JSON: json }, fetchImpl: f, now: () => t });
  assert.equal(auth.configured(), true); assert.equal(auth.serviceAccountEmail(), keyFile.client_email);
  assert.equal(await auth.getAccessToken(), "tok-1");
  assert.equal(f.calls[0].url, TOKEN_ENDPOINT); assert.ok(!f.calls[0].url.includes("evil.example"));
  const form = new URLSearchParams(f.calls[0].init.body);
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer"); assert.equal(form.get("assertion").split(".").length, 3);
  t += 3000 * 1000; await auth.getAccessToken(); assert.equal(f.calls.length, 1, "still cached");
  t += 600 * 1000; await auth.getAccessToken(); assert.equal(f.calls.length, 2, "refreshed after expiry");
});

test("concurrent callers share one exchange", async () => {
  const f = fakeTokenFetch(async () => { await new Promise((r) => setTimeout(r, 20)); return ok({ access_token: "shared", expires_in: 3600 }); });
  const auth = createGscAuth({ env: { GOOGLE_SERVICE_ACCOUNT_JSON: json }, fetchImpl: f });
  const tokens = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
  assert.deepEqual(tokens, ["shared", "shared", "shared"]); assert.equal(f.calls.length, 1);
});

test("failures are mapped to clear errors and never leak the key", async () => {
  const run = (handler, env = { GOOGLE_SERVICE_ACCOUNT_JSON: json }) => createGscAuth({ env, fetchImpl: fakeTokenFetch(handler) }).getAccessToken();
  await assert.rejects(run(() => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) })), (e) => e.code === "BAD_KEY" && !e.message.includes("PRIVATE KEY"));
  await assert.rejects(run(() => ({ ok: false, status: 500, json: async () => ({ error: "backend_error" }) })), (e) => e.code === "AUTH_FAILED" && /backend_error/.test(e.message));
  await assert.rejects(run(() => ({ ok: true, status: 200, json: async () => ({}) })), { code: "AUTH_FAILED" });
  await assert.rejects(run(() => { throw new Error(`socket error ${privateKey}`); }), (e) => e.code === "NETWORK" && !e.message.includes("PRIVATE"));
  await assert.rejects(run(() => ok({}), {}), { code: "NOT_CONFIGURED" });
  const none = createGscAuth({ env: {} }); assert.equal(none.configured(), false); assert.equal(none.serviceAccountEmail(), null);
  assert.throws(() => createGscAuth({ env: { GOOGLE_SERVICE_ACCOUNT_JSON: "garbage" } }).configured(), { code: "BAD_CONFIG" });
});
