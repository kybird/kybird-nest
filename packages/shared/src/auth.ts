import { z } from "zod";

/**
 * 인증은 최대한 단순하게 간다 — 로그인하면 토큰이 나오고, 클라이언트는
 * 그걸 `~/.kybird/config.json` 에 보관한다. **레포 안에 두지 않는다**
 * (커밋 사고 방지).
 */

export const credentialsSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(8).max(200),
});
export type Credentials = z.infer<typeof credentialsSchema>;

export const authResultSchema = z.object({
  token: z.string(),
  user: z.object({
    id: z.string(),
    email: z.string(),
  }),
});
export type AuthResult = z.infer<typeof authResultSchema>;

/** 토큰은 `Authorization: Bearer <token>` 으로 보낸다. */
export const AUTH_HEADER = "authorization";
export const AUTH_SCHEME = "Bearer";

export function bearer(token: string): string {
  return `${AUTH_SCHEME} ${token}`;
}

export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== AUTH_SCHEME.toLowerCase()) return null;
  const token = rest.join(" ").trim();
  return token.length > 0 ? token : null;
}

export const apiErrorSchema = z.object({
  error: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
