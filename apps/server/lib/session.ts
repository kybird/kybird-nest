import { cookies } from "next/headers";
import { prisma } from "./prisma";
import { hashToken, type AuthedUser } from "./auth";
import { config } from "./config";

/**
 * 웹 UI 세션.
 *
 * CLI 와 **같은 토큰**을 쓰고 담는 그릇만 다르다 — CLI 는 헤더, 브라우저는
 * httpOnly 쿠키. 토큰 발급·검증 경로가 하나뿐이라 둘이 어긋날 일이 없다.
 */
export const SESSION_COOKIE = "knest_session";

export async function currentUser(): Promise<AuthedUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const record = await prisma.token.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { user: { select: { id: true, email: true } } },
  });
  return record?.user ?? null;
}

export async function setSession(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // 리버스 프록시가 TLS 를 끊으면 앱은 자기가 HTTPS 뒤에 있는지 모른다.
    // 자동 추론에 맡기면 "프로덕션인데 앱은 평문 HTTP" 조합에서 브라우저가
    // 쿠키를 버려 로그인이 조용히 안 된다. 그래서 명시적으로 받는다.
    secure: config.cookieSecure,
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}
