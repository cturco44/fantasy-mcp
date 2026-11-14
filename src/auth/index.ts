import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { AuthConfig, AuthDeps } from "./config.js";
import { googleDeps } from "./google.js";
import { makeJwt } from "./jwt.js";

export { authConfigFromEnv, type AuthConfig, type AuthDeps } from "./config.js";

const ACCESS_TTL = 60 * 60; // 1 h
const REFRESH_TTL = 30 * 24 * 60 * 60; // 30 d
const CODE_TTL = 5 * 60;
const STATE_TTL = 10 * 60;
const CLIENT_TTL = 365 * 24 * 60 * 60;

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function pkceMatches(verifier: string, challenge: string): boolean {
  const a = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== "string") return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  return !["javascript:", "data:", "file:", "vbscript:", "blob:"].includes(u.protocol);
}

function oauthError(c: Context, status: 400 | 401, error: string, description?: string) {
  c.header("Cache-Control", "no-store");
  return c.json({ error, ...(description ? { error_description: description } : {}) }, status);
}

function errorPage(c: Context, status: 400 | 403, title: string, detail: string) {
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>` +
      `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>${esc(title)}</h1><p>${esc(detail)}</p></body>`,
    status,
  );
}

/**
 * Wraps `app` with a minimal OAuth 2.1 authorization server (Google sign-in + email allowlist,
 * stateless signed JWTs) and requires a valid access token on /mcp.
 */
export function withAuth(app: Hono, config: AuthConfig, deps: AuthDeps = googleDeps(config)): Hono {
  const { publicUrl } = config;
  const resource = `${publicUrl}/mcp`;
  const googleRedirect = `${publicUrl}/oauth/google/callback`;
  const jwt = makeJwt(config.jwtSecret, publicUrl);
  const allowed = (email: unknown) => typeof email === "string" && config.allowedEmails.has(email.toLowerCase());
  const resourceMetadataUrl = `${publicUrl}/.well-known/oauth-protected-resource`;

  const root = new Hono();

  // No cookies are used anywhere (Bearer tokens only), so permissive CORS is safe and lets browser
  // clients such as the MCP Inspector complete the flow.
  const corsMw = cors({
    origin: "*",
    allowHeaders: ["authorization", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"],
    exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id"],
  });
  for (const p of ["/.well-known/*", "/register", "/token", "/mcp", "/mcp/*"]) root.use(p, corsMw);

  root.get("/.well-known/oauth-protected-resource", (c) =>
    c.json({ resource, authorization_servers: [publicUrl], bearer_methods_supported: ["header"] }),
  );
  root.get("/.well-known/oauth-protected-resource/mcp", (c) =>
    c.json({ resource, authorization_servers: [publicUrl], bearer_methods_supported: ["header"] }),
  );
  root.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/authorize`,
      token_endpoint: `${publicUrl}/token`,
      registration_endpoint: `${publicUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    }),
  );

  // Dynamic client registration. Stateless: the client_id is a signed JWT of the registration.
  root.post("/register", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(validRedirectUri)) {
      return oauthError(c, 400, "invalid_redirect_uri", "redirect_uris must be a non-empty list of valid URIs");
    }
    const clientName = typeof body?.client_name === "string" ? body.client_name.slice(0, 100) : "";
    const client_id = await jwt.sign("client", { redirect_uris: uris, client_name: clientName }, CLIENT_TTL);
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        client_id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: uris,
        client_name: clientName,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    );
  });

  root.get("/authorize", async (c) => {
    const q = c.req.query();
    let client;
    try {
      client = await jwt.verify("client", q.client_id ?? "");
    } catch {
      return errorPage(c, 400, "Invalid request", "Unknown or invalid client.");
    }
    const registered = (client.redirect_uris as string[]) ?? [];
    if (!q.redirect_uri || !registered.includes(q.redirect_uri)) {
      return errorPage(c, 400, "Invalid request", "redirect_uri is not registered for this client.");
    }
    const back = (error: string, description: string) => {
      const u = new URL(q.redirect_uri!);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      if (q.state) u.searchParams.set("state", q.state);
      return c.redirect(u.toString(), 302);
    };
    if (q.response_type !== "code") return back("unsupported_response_type", "response_type must be code");
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      return back("invalid_request", "PKCE with code_challenge_method=S256 is required");
    }
    const nonce = randomBytes(16).toString("base64url");
    const state = await jwt.sign(
      "state",
      {
        client_id: q.client_id,
        redirect_uri: q.redirect_uri,
        code_challenge: q.code_challenge,
        state: q.state ?? "",
        scope: q.scope ?? "",
        nonce,
      },
      STATE_TTL,
    );
    const g = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    g.searchParams.set("client_id", config.googleClientId);
    g.searchParams.set("redirect_uri", googleRedirect);
    g.searchParams.set("response_type", "code");
    g.searchParams.set("scope", "openid email");
    g.searchParams.set("state", state);
    g.searchParams.set("nonce", nonce);
    g.searchParams.set("prompt", "select_account");
    return c.redirect(g.toString(), 302);
  });

  root.get("/oauth/google/callback", async (c) => {
    const q = c.req.query();
    let st;
    try {
      st = await jwt.verify("state", q.state ?? "");
    } catch {
      return errorPage(c, 400, "Invalid request", "Sign-in session expired or invalid. Start again from your app.");
    }
    const redirectUri = st.redirect_uri as string;
    const back = (params: Record<string, string>) => {
      const u = new URL(redirectUri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (st.state) u.searchParams.set("state", st.state as string);
      return c.redirect(u.toString(), 302);
    };
    if (q.error || !q.code) return back({ error: "access_denied", error_description: "Google sign-in was cancelled" });

    let identity;
    try {
      identity = await deps.exchangeGoogleCode(q.code, googleRedirect);
    } catch (err) {
      console.error("google sign-in failed:", err);
      return back({ error: "server_error", error_description: "Google sign-in failed" });
    }
    if (!identity.emailVerified || (identity.nonce && identity.nonce !== st.nonce) || !identity.nonce) {
      console.warn("rejected sign-in: unverified email or nonce mismatch");
      return errorPage(c, 403, "Not allowed", "Could not verify your Google account.");
    }
    if (!allowed(identity.email)) {
      console.warn(`rejected sign-in: ${identity.email} not on allowlist`);
      return errorPage(c, 403, "Not allowed", `${identity.email} is not allowed to use this server.`);
    }
    const code = await jwt.sign(
      "code",
      {
        sub: identity.email,
        client_id: st.client_id,
        redirect_uri: redirectUri,
        code_challenge: st.code_challenge,
      },
      CODE_TTL,
    );
    console.log(`sign-in OK: ${identity.email}`);
    return back({ code });
  });

  const issueTokens = async (email: string, clientId: string) => {
    const [access_token, refresh_token] = await Promise.all([
      jwt.sign("access", { sub: email }, ACCESS_TTL, resource),
      jwt.sign("refresh", { sub: email, client_id: clientId }, REFRESH_TTL),
    ]);
    return { access_token, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token };
  };

  root.post("/token", async (c) => {
    const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, string | File>;
    const get = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : undefined);
    c.header("Cache-Control", "no-store");
    const grant = get("grant_type");

    if (grant === "authorization_code") {
      const [codeStr, verifier] = [get("code"), get("code_verifier")];
      if (!codeStr || !verifier) return oauthError(c, 400, "invalid_request", "code and code_verifier are required");
      let code;
      try {
        code = await jwt.verify("code", codeStr);
      } catch {
        return oauthError(c, 400, "invalid_grant", "invalid or expired code");
      }
      const clientId = get("client_id");
      if (clientId && clientId !== code.client_id) return oauthError(c, 400, "invalid_grant", "client mismatch");
      if (get("redirect_uri") !== code.redirect_uri) return oauthError(c, 400, "invalid_grant", "redirect_uri mismatch");
      if (!pkceMatches(verifier, code.code_challenge as string)) return oauthError(c, 400, "invalid_grant", "PKCE failed");
      if (!allowed(code.sub)) return oauthError(c, 400, "invalid_grant", "not allowed");
      return c.json(await issueTokens(code.sub as string, code.client_id as string));
    }

    if (grant === "refresh_token") {
      const rt = get("refresh_token");
      if (!rt) return oauthError(c, 400, "invalid_request", "refresh_token is required");
      let payload;
      try {
        payload = await jwt.verify("refresh", rt);
      } catch {
        return oauthError(c, 400, "invalid_grant", "invalid or expired refresh token");
      }
      const clientId = get("client_id");
      if (clientId && clientId !== payload.client_id) return oauthError(c, 400, "invalid_grant", "client mismatch");
      if (!allowed(payload.sub)) return oauthError(c, 400, "invalid_grant", "not allowed");
      return c.json(await issueTokens(payload.sub as string, payload.client_id as string));
    }

    return oauthError(c, 400, "unsupported_grant_type");
  });

  // Everything under /mcp needs a valid access token for an allowlisted user.
  const guard = async (c: Context, next: () => Promise<void>) => {
    if (c.req.method === "OPTIONS") return next();
    const header = c.req.header("authorization") ?? "";
    const token = /^Bearer (.+)$/i.exec(header)?.[1];
    const unauthorized = (error?: string) => {
      c.header(
        "WWW-Authenticate",
        `Bearer resource_metadata="${resourceMetadataUrl}"${error ? `, error="${error}"` : ""}`,
      );
      return c.json({ error: error ?? "unauthorized" }, 401);
    };
    if (!token) return unauthorized();
    try {
      const payload = await jwt.verify("access", token, resource);
      if (!allowed(payload.sub)) return unauthorized("invalid_token");
    } catch {
      return unauthorized("invalid_token");
    }
    return next();
  };
  root.use("/mcp", guard);
  root.use("/mcp/*", guard);

  root.route("/", app);
  return root;
}
