import { credentialsSchema, newId, type AuthResult } from "@kybird/shared";
import { prisma } from "@/lib/prisma";
import { generateToken, hashPassword } from "@/lib/auth";

export async function POST(request: Request): Promise<Response> {
  const parsed = credentialsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "이메일과 8자 이상의 비밀번호가 필요하다" }, { status: 400 });
  }
  const { email, password } = parsed.data;

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
