import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";
import { withAuth } from "../src/auth/index.js";
import type { AuthConfig, AuthDeps } from "../src/auth/config.js";

const PUBLIC = "https://example.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function setup() {
  const config: AuthConfig = {
    publicUrl: PUBLIC,
    googleClientId: "gid",
    googleClientSecret: "gsecret",
    jwtSecret: "x".repeat(40),
    allowedEmails: new Set(["me@example.com"]),
  };
  let nextEmail = "me@example.com";
  let verified = true;
  let lastNonce: string | undefined;
  const deps: AuthDeps = {
    async exchangeGoogleCode() {
      return { email: nextEmail, emailVerified: verified, nonce: lastNonce };
    },
  };
  const inner = new Hono();
  inner.get("/", (c) => c.text("ok"));
  inner.all("/mcp", (c) => c.text("mcp reached"));
  const app = withAuth(inner, config, deps);
  const req = (path: string, init?: RequestInit) => app.request(`${PUBLIC}${path}`, init);
  return {
    config,
    req,
    setUser: (email: string, v = true) => ((nextEmail = email), (verified = v)),
    setNonce: (n: string | undefined) => (lastNonce = n),
  };
}

async function register(s: ReturnType<typeof setup>, redirect = REDIRECT) {
  const res = await s.req("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect], client_name: "test" }),
  });
  return { res, body: (await res.json()) as any };
}

/** Runs register -> authorize -> (fake google) callback -> returns the auth code and verifier. */
async function getCode(s: ReturnType<typeof setup>) {
  const { body: client } = await register(s);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authUrl =
    `/authorize?response_type=code&client_id=${encodeURIComponent(client.client_id)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&state=abc`;
  const a = await s.req(authUrl);
  assert.equal(a.status, 302);
  const google = new URL(a.headers.get("location")!);
  assert.equal(google.host, "accounts.google.com");
  assert.equal(google.searchParams.get("scope"), "openid email");
  s.setNonce(google.searchParams.get("nonce")!);
  const cb = await s.req(
    `/oauth/google/callback?code=gcode&state=${encodeURIComponent(google.searchParams.get("state")!)}`,
  );
  return { cb, client, verifier, challenge };
}

const tokenReq = (s: ReturnType<typeof setup>, params: Record<string, string>) =>
  s.req("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });

async function fullLogin(s: ReturnType<typeof setup>) {
  const { cb, client, verifier } = await getCode(s);
  assert.equal(cb.status, 302);
  const back = new URL(cb.headers.get("location")!);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get("state"), "abc");
  const tok = await tokenReq(s, {
    grant_type: "authorization_code",
    code: back.searchParams.get("code")!,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
  });
  assert.equal(tok.status, 200);
  return { tokens: (await tok.json()) as any, client };
}

test("GET / is public", async () => {
  const s = setup();
  assert.equal((await s.req("/")).status, 200);
});

test("unauthenticated /mcp -> 401 with WWW-Authenticate pointing at resource metadata", async () => {
  const s = setup();
  const res = await s.req("/mcp", { method: "POST", body: "{}" });
  assert.equal(res.status, 401);
  assert.equal(
    res.headers.get("www-authenticate"),
    `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`,
  );
});

test("well-known metadata is valid and uses the public URL", async () => {
  const s = setup();
  for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const j = (await (await s.req(p)).json()) as any;
    assert.equal(j.resource, `${PUBLIC}/mcp`);
    assert.deepEqual(j.authorization_servers, [PUBLIC]);
  }
  const as = (await (await s.req("/.well-known/oauth-authorization-server")).json()) as any;
  assert.equal(as.issuer, PUBLIC);
  assert.equal(as.token_endpoint, `${PUBLIC}/token`);
  assert.equal(as.registration_endpoint, `${PUBLIC}/register`);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
});

test("register rejects bad redirect URIs", async () => {
  const s = setup();
  for (const bad of ["javascript:alert(1)", "http://evil.com/cb", "not a url"]) {
    const { res } = await register(s, bad);
    assert.equal(res.status, 400, bad);
  }
  assert.equal((await register(s, "http://localhost:6274/oauth/callback")).res.status, 201);
});

test("authorize rejects an unregistered redirect_uri without redirecting", async () => {
  const s = setup();
  const { body: client } = await register(s);
  const res = await s.req(
    `/authorize?response_type=code&client_id=${encodeURIComponent(client.client_id)}` +
      `&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&code_challenge=x&code_challenge_method=S256`,
  );
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("location"), null);
});

test("authorize requires PKCE S256 (redirects with error)", async () => {
  const s = setup();
  const { body: client } = await register(s);
  const res = await s.req(
    `/authorize?response_type=code&client_id=${encodeURIComponent(client.client_id)}&redirect_uri=${encodeURIComponent(REDIRECT)}`,
  );
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get("location")!).searchParams.get("error"), "invalid_request");
});

test("full flow: allowlisted user gets tokens and reaches /mcp", async () => {
  const s = setup();
  const { tokens } = await fullLogin(s);
  assert.equal(tokens.token_type, "Bearer");
  const res = await s.req("/mcp", { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "mcp reached");
});

test("non-allowlisted Google account is refused at the callback", async () => {
  const s = setup();
  s.setUser("stranger@example.com");
  const { cb } = await getCode(s);
  assert.equal(cb.status, 403);
  assert.equal(cb.headers.get("location"), null);
});

test("unverified Google email is refused", async () => {
  const s = setup();
  s.setUser("me@example.com", false);
  const { cb } = await getCode(s);
  assert.equal(cb.status, 403);
});

test("nonce mismatch is refused", async () => {
  const s = setup();
  const { body: client } = await register(s);
  const a = await s.req(
    `/authorize?response_type=code&client_id=${encodeURIComponent(client.client_id)}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=abc&code_challenge_method=S256`,
  );
  const google = new URL(a.headers.get("location")!);
  s.setNonce("wrong-nonce");
  const cb = await s.req(`/oauth/google/callback?code=g&state=${encodeURIComponent(google.searchParams.get("state")!)}`);
  assert.equal(cb.status, 403);
});

test("wrong PKCE verifier -> invalid_grant", async () => {
  const s = setup();
  const { cb, client } = await getCode(s);
  const code = new URL(cb.headers.get("location")!).searchParams.get("code")!;
  const res = await tokenReq(s, {
    grant_type: "authorization_code",
    code,
    code_verifier: "wrong-verifier",
    redirect_uri: REDIRECT,
    client_id: client.client_id,
  });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as any).error, "invalid_grant");
});

test("wrong redirect_uri at token endpoint -> invalid_grant", async () => {
  const s = setup();
  const { cb, verifier } = await getCode(s);
  const code = new URL(cb.headers.get("location")!).searchParams.get("code")!;
  const res = await tokenReq(s, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: "https://claude.ai/other",
  });
  assert.equal(res.status, 400);
});

test("token kinds are not interchangeable", async () => {
  const s = setup();
  const { tokens, client } = await fullLogin(s);
  // refresh token as access token on /mcp
  const r1 = await s.req("/mcp", { headers: { authorization: `Bearer ${tokens.refresh_token}` } });
  assert.equal(r1.status, 401);
  // client_id JWT as access token
  const r2 = await s.req("/mcp", { headers: { authorization: `Bearer ${client.client_id}` } });
  assert.equal(r2.status, 401);
  // access token as refresh token
  const r3 = await tokenReq(s, { grant_type: "refresh_token", refresh_token: tokens.access_token });
  assert.equal(r3.status, 400);
  // garbage
  assert.equal((await s.req("/mcp", { headers: { authorization: "Bearer nope" } })).status, 401);
});

test("refresh works while allowlisted", async () => {
  const s = setup();
  const { tokens } = await fullLogin(s);
  const res = await tokenReq(s, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  assert.equal(res.status, 200);
  const next = (await res.json()) as any;
  assert.equal((await s.req("/mcp", { headers: { authorization: `Bearer ${next.access_token}` } })).status, 200);
});

test("removing an email from the allowlist blocks existing access AND refresh tokens", async () => {
  const s = setup();
  const { tokens } = await fullLogin(s);
  s.config.allowedEmails.delete("me@example.com");
  const r = await s.req("/mcp", { headers: { authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(r.status, 401);
  const rf = await tokenReq(s, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  assert.equal(rf.status, 400);
});

test("a token signed with a different secret is rejected", async () => {
  const a = setup();
  const other = withAuth(new Hono().all("/mcp", (c) => c.text("x")), { ...a.config, jwtSecret: "y".repeat(40) }, {
    exchangeGoogleCode: async () => ({ email: "me@example.com", emailVerified: true }),
  });
  const { tokens } = await fullLogin(a);
  const res = await other.request(`${PUBLIC}/mcp`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(res.status, 401);
});

test("CORS preflight on /mcp is not blocked by auth", async () => {
  const s = setup();
  const res = await s.req("/mcp", {
    method: "OPTIONS",
    headers: { origin: "https://inspector.example", "access-control-request-method": "POST" },
  });
  assert.ok(res.status < 300);
});
