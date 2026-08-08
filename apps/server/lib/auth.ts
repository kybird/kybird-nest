import { randomBytes, scrypt as scryptCb, createHash, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { parseBearer } from "@kybird/shared";
import { prisma } from "./prisma";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// 128 * N * r 바이트를 쓴다 — N=32768, r=8 이면 약 33MB 라 Node 기본
// maxmem(32MB)을 살짝 넘는다. 그래서 명시적으로 올려준다.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LENGTH = 32;

/** `scrypt$N$r$p$salt$hash` — 파라미터를 같이 저장해야 나중에 올려도 기존 해시를 검증할 수 있다. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, SCRYPT);
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const actual = await scrypt(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: Math.max(SCRYPT.maxmem, 256 * N * r),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * API 토큰. 원문은 발급 순간 한 번만 돌려주고, DB에는 해시만 남긴다.
 *
 * 토큰은 이미 고엔트로피(256비트 랜덤)라 비밀번호와 달리 느린 KDF가 필요 없다.
 * SHA-256 이면 충분하고, 매 요청마다 검증하므로 빨라야 한다.
 */
export function generateToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type AuthedUser = { id: string; email: string };

/** `Authorization: Bearer <token>` 을 검증한다. 실패하면 null. */
export async function authenticate(request: Request): Promise<AuthedUser | null> {
  const token = parseBearer(request.headers.get("authorization"));
  if (!token) return null;

  const record = await prisma.token.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, user: { select: { id: true, email: true } } },
  });
  if (!record) return null;

  // 마지막 사용 시각은 참고용이라 실패해도 요청을 막지 않는다.
  void prisma.token
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return record.user;
}

export function unauthorized(): Response {
  return Response.json({ error: "인증이 필요하다" }, { status: 401 });
}
