import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AuthConfig, AuthDeps, GoogleIdentity } from "./config.js";

const jwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export function googleDeps(config: AuthConfig): AuthDeps {
  return {
    async exchangeGoogleCode(code: string, redirectUri: string): Promise<GoogleIdentity> {
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: config.googleClientId,
          client_secret: config.googleClientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      if (!res.ok) throw new Error(`google token exchange failed: ${res.status}`);
      const { id_token } = (await res.json()) as { id_token?: string };
      if (!id_token) throw new Error("google response had no id_token");
      const { payload } = await jwtVerify(id_token, jwks, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: config.googleClientId,
      });
      return {
        email: String(payload.email ?? "").toLowerCase(),
        emailVerified: payload.email_verified === true,
        nonce: typeof payload.nonce === "string" ? payload.nonce : undefined,
      };
    },
  };
}
