import { z } from "zod";
import { credentialsSchema, newId, type AuthResult } from "@kybird/shared";
import { prisma } from "@/lib/prisma";
import { generateToken, hashPassword } from "@/lib/auth";
import { config } from "@/lib/config";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";
import { inviteMatches } from "@/lib/invite";

const registerSchema = credentialsSchema.extend({
  invite: z.string().max(200).optional(),
});

export async function POST(request: Request): Promise<Response> {
  // 비밀번호 해싱보다 **먼저** 센다. scrypt 는 시도당 33MB 라,
  // 해싱한 다음에 세는 건 아무 방어도 되지 않는다.
  const limit = checkRateLimit(request, "register");
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  if (!config.registrationOpen) {
    return Response.json({ error: "가입이 닫혀 있다" }, { status: 403 });
  }

  const parsed = registerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "이메일과 8자 이상의 비밀번호가 필요하다" }, { status: 400 });
  }
  const { email, password, invite } = parsed.data;

  if (!inviteMatches(invite)) {
    return Response.json({ error: "초대 코드가 맞지 않다" }, { status: 403 });
  }

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    return Response.json({ error: "이미 가입된 이메일이다" }, { status: 409 });
  }

  const { token, tokenHash } = generateToken();
  const user = await prisma.user.create({
    data: {
      id: newId(),
      email,
      passwordHash: await hashPassword(password),
      tokens: { create: { id: newId(), tokenHash } },
    },
    select: { id: true, email: true },
  });

  const result: AuthResult = { token, user };
  return Response.json(result, { status: 201 });
}
