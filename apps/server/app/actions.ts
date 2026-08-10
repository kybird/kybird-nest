"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { credentialsSchema, newId } from "@kybird/shared";
import { prisma } from "@/lib/prisma";
import { generateToken, hashPassword, verifyPassword } from "@/lib/auth";
import { clearSession, currentUser, setSession } from "@/lib/session";
import { config } from "@/lib/config";
import { inviteMatches } from "@/lib/invite";
import { checkRateLimit } from "@/lib/rate-limit";
import * as boardOps from "@/lib/board";

/** 로그인/가입 실패는 예외가 아니라 화면에 보여줄 메시지다. */
export type FormState = { error: string } | null;

export async function authAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const mode = String(formData.get("mode") ?? "login");

  // 서버 액션도 인증 경로다. API 라우트만 막으면 여기로 그대로 우회된다.
  // 헤더는 액션 요청의 것을 그대로 쓴다.
  const request = new Request("http://internal/", { headers: await headers() });
  const limit = checkRateLimit(request, mode === "register" ? "register" : "login");
  if (!limit.ok) {
    return { error: `시도가 너무 잦다. ${limit.retryAfterSeconds}초 후에 다시 해라.` };
  }

  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: "이메일 형식과 8자 이상의 비밀번호가 필요하다" };
  }
  const { email, password } = parsed.data;

  if (mode === "register") {
    if (!config.registrationOpen) return { error: "가입이 닫혀 있다" };
    if (!inviteMatches(String(formData.get("invite") ?? ""))) {
      return { error: "초대 코드가 맞지 않다" };
    }

    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) return { error: "이미 가입된 이메일이다" };

    const { token, tokenHash } = generateToken();
    await prisma.user.create({
      data: {
        id: newId(),
        email,
        passwordHash: await hashPassword(password),
        tokens: { create: { id: newId(), tokenHash } },
      },
    });
    await setSession(token);
  } else {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true },
    });
    // 계정이 없어도 검증을 건너뛰지 않는다 — 응답 시간으로 가입 여부가 새면 안 된다.
    const dummy =
      "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const ok = await verifyPassword(password, user?.passwordHash ?? dummy);
    if (!user || !ok) return { error: "이메일 또는 비밀번호가 맞지 않다" };

    const { token, tokenHash } = generateToken();
    await prisma.token.create({ data: { id: newId(), userId: user.id, tokenHash } });
    await setSession(token);
  }

  redirect("/");
}

export async function logoutAction(): Promise<void> {
  await clearSession();
  redirect("/login");
}

async function requireUser() {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

export async function addCardAction(
  repoId: string,
  columnId: string,
  title: string,
): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) return;
  const user = await requireUser();
  await boardOps.addCard(user.id, repoId, columnId, trimmed);
  revalidatePath(`/repo/${repoId}`);
  revalidatePath("/");
}

export async function moveCardAction(
  repoId: string,
  cardId: string,
  toColumnId: string,
  position: number,
): Promise<void> {
  const user = await requireUser();
  await boardOps.moveCard(user.id, cardId, toColumnId, position);
  revalidatePath(`/repo/${repoId}`);
  revalidatePath("/");
}

export async function editCardAction(
  repoId: string,
  cardId: string,
  title: string,
): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) return;
  const user = await requireUser();
  await boardOps.editCard(user.id, cardId, { title: trimmed });
  revalidatePath(`/repo/${repoId}`);
}

/** 카드 상세 모달에서 제목+본문을 같이 저장한다. */
export async function editCardDetailsAction(
  repoId: string,
  cardId: string,
  title: string,
  body: string,
): Promise<void> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) return;
  const user = await requireUser();
  await boardOps.editCard(user.id, cardId, { title: trimmedTitle, body });
  revalidatePath(`/repo/${repoId}`);
}

export async function deleteCardAction(repoId: string, cardId: string): Promise<void> {
  const user = await requireUser();
  await boardOps.deleteCard(user.id, cardId);
  revalidatePath(`/repo/${repoId}`);
  revalidatePath("/");
}

/** 삭제된 카드(툼스톤)를 되살린다. 보관함에서 복구 버튼이 부른다. */
export async function restoreCardAction(repoId: string, cardId: string): Promise<void> {
  const user = await requireUser();
  await boardOps.restoreCard(user.id, cardId);
  revalidatePath(`/repo/${repoId}`);
  revalidatePath("/");
}

/** 새 컬럼을 맨 뒤에 추가한다. */
export async function addColumnAction(repoId: string, title: string): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) return;
  const user = await requireUser();
  await boardOps.addColumn(user.id, repoId, trimmed);
  revalidatePath(`/repo/${repoId}`);
}

/** 컬럼 제목을 바꾼다. 헤더를 더블클릭해서 편집한다. */
export async function renameColumnAction(
  repoId: string,
  columnId: string,
  title: string,
): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) return;
  const user = await requireUser();
  await boardOps.renameColumn(user.id, columnId, trimmed);
  revalidatePath(`/repo/${repoId}`);
}
