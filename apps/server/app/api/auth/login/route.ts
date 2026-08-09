import { credentialsSchema, newId, type AuthResult } from "@kybird/shared";
import { prisma } from "@/lib/prisma";
import { generateToken, verifyPassword } from "@/lib/auth";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";

export async function POST(request: Request): Promise<Response> {
  // 비밀번호 검증보다 **먼저** 센다. scrypt 는 시도당 33MB 라,
  // 검증한 다음에 세는 건 아무 방어도 되지 않는다.
  const limit = checkRateLimit(request, "login");
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  const parsed = credentialsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "이메일과 비밀번호가 필요하다" }, { status: 400 });
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, passwordHash: true },
  });

  // 계정이 없어도 비밀번호 검증을 건너뛰지 않는다 — 응답 시간 차이로
  // 가입된 이메일인지 알아낼 수 있기 때문이다.
  const dummyHash =
    "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const ok = await verifyPassword(password, user?.passwordHash ?? dummyHash);

  if (!user || !ok) {
    return Response.json({ error: "이메일 또는 비밀번호가 맞지 않다" }, { status: 401 });
  }

  const { token, tokenHash } = generateToken();
  await prisma.token.create({ data: { id: newId(), userId: user.id, tokenHash } });

  const result: AuthResult = { token, user: { id: user.id, email: user.email } };
  return Response.json(result);
}
