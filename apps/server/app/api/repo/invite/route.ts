import { randomBytes } from "node:crypto";
import { newId, repoInviteRequestSchema, type RepoInviteResult } from "@kybird/shared";
import { authenticate, hashToken, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * 레포 참여 코드를 발급한다. 역할 구분이 없으므로 그 레포의 멤버라면
 * 누구나 발급할 수 있다. 평문은 이 응답에서만 보인다 — DB엔 해시만 남는다.
 */
export async function POST(request: Request): Promise<Response> {
  const user = await authenticate(request);
  if (!user) return unauthorized();

  const parsed = repoInviteRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "요청 형식이 잘못됐다" }, { status: 400 });
  }
  const { repoId } = parsed.data;

  const membership = await prisma.repoMember.findUnique({
    where: { repoId_userId: { repoId, userId: user.id } },
    select: { id: true },
  });
  if (!membership) {
    return Response.json({ error: "이 레포의 멤버가 아니다" }, { status: 403 });
  }

  const code = randomBytes(16).toString("base64url");
  await prisma.repoInvite.create({
    data: { id: newId(), repoId, codeHash: hashToken(code), createdBy: user.id },
  });

  const result: RepoInviteResult = { code };
  return Response.json(result, { status: 201 });
}
