export interface AuthConfig {
  /** Public base URL of this server, no trailing slash (e.g. https://x.run.app). */
  publicUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  jwtSecret: string;
  /** Lowercased emails allowed to use the server. */
  allowedEmails: Set<string>;
}

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  nonce?: string;
}

/** Injectable so tests can fake Google. */
export interface AuthDeps {
  exchangeGoogleCode(code: string, redirectUri: string): Promise<GoogleIdentity>;
}

const REQUIRED = ["PUBLIC_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "JWT_SECRET", "ALLOWED_EMAILS"] as const;

/** Reads auth config from env; throws listing every missing variable. */
export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const missing = REQUIRED.filter((k) => !env[k]?.trim());
  if (missing.length) throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  const jwtSecret = env.JWT_SECRET!.trim();
  if (jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");
  const allowedEmails = new Set(
    env.ALLOWED_EMAILS!.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
  );
  if (allowedEmails.size === 0) throw new Error("ALLOWED_EMAILS has no entries");
  return {
    publicUrl: env.PUBLIC_URL!.trim().replace(/\/+$/, ""),
    googleClientId: env.GOOGLE_CLIENT_ID!.trim(),
    googleClientSecret: env.GOOGLE_CLIENT_SECRET!.trim(),
    jwtSecret,
    allowedEmails,
  };
}
