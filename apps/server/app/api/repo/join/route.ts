import { newId, repoJoinRequestSchema, type RepoJoinResult } from "@kybird/shared";
import { authenticate, hashToken, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";

/**
 * 참여 코드로 레포에 합류한다. clone 만으로는 자동 합류가 안 된다 —
 * `.kybird/repo.json` 의 repoId 는 git 에 커밋돼서 공개 레포라면 사실상
 * 공개값이라, 코드 없이 repoId 만으로 들어올 수 있게 하면 구멍이 된다.
 */
export async function POST(request: Request): Promise<Response> {
  // 코드 대조보다 먼저 센다 — 무차별 대입 방어의 기본이다(register 와 같은 이유).
  const limit = checkRateLimit(request, "repoJoin");
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  const user = await authenticate(request);
  if (!user) return unauthorized();

  const parsed = repoJoinRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "요청 형식이 잘못됐다" }, { status: 400 });
  }
  const { repoId, code } = parsed.data;

  const invite = await prisma.repoInvite.findFirst({
    where: { repoId, codeHash: hashToken(code), revokedAt: null },
    select: { id: true },
  });
  if (!invite) {
    return Response.json({ error: "초대 코드가 맞지 않다" }, { status: 403 });
  }

  const repo = await prisma.repo.findUnique({ where: { id: repoId } });
  if (!repo || repo.deletedAt) {
    return Response.json({ error: "레포를 찾을 수 없다" }, { status: 404 });
  }

  // 이미 멤버여도 조용히 성공 처리한다 — 재합류는 에러가 아니다.
  await prisma.repoMember.upsert({
    where: { repoId_userId: { repoId, userId: user.id } },
    create: { id: newId(), repoId, userId: user.id },
    update: {},
  });

  const result: RepoJoinResult = {
    repo: {
      id: repo.id,
      name: repo.name,
      path: repo.path,
      gitRemote: repo.gitRemote,
      updatedAt: repo.updatedAt.getTime(),
      // 위에서 이미 deletedAt 이 없는 걸 확인했다 — 삭제된 레포는 못 들어온다.
      deletedAt: null,
    },
  };
  return Response.json(result, { status: 200 });
}
