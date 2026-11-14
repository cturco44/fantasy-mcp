import { SignJWT, jwtVerify, type JWTPayload } from "jose";

/** Every token kind carries a `typ` claim that is checked on verify, so one kind can't pass as another. */
export type TokenKind = "client" | "state" | "code" | "access" | "refresh";

export function makeJwt(secret: string, issuer: string) {
  const key = new TextEncoder().encode(secret);
  return {
    sign(kind: TokenKind, claims: Record<string, unknown>, ttlSeconds: number, audience?: string): Promise<string> {
      const jwt = new SignJWT({ ...claims, typ: kind })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(issuer)
        .setIssuedAt()
        .setExpirationTime(`${ttlSeconds}s`);
      if (audience) jwt.setAudience(audience);
      return jwt.sign(key);
    },
    async verify(kind: TokenKind, token: string, audience?: string): Promise<JWTPayload> {
      const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"], issuer, audience });
      if (payload.typ !== kind) throw new Error(`wrong token kind: expected ${kind}`);
      return payload;
    },
  };
}
