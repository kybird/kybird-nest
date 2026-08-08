"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { credentialsSchema, newId } from "@kybird/shared";
import { prisma } from "@/lib/prisma";
import { generateToken, hashPassword, verifyPassword } from "@/lib/auth";
import { clearSession, currentUser, setSession } from "@/lib/session";
import * as boardOps from "@/lib/board";

/** 로그인/가입 실패는 예외가 아니라 화면에 보여줄 메시지다. */
export type FormState = { error: string } | null;

export async function authAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const mode = String(formData.get("mode") ?? "login");
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: "이메일 형식과 8자 이상의 비밀번호가 필요하다" };
  }
  const { email, password } = parsed.data;

  if (mode === "register") {
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
  await boardOps.editCardTitle(user.id, cardId, trimmed);
  revalidatePath(`/repo/${repoId}`);
}

export async function deleteCardAction(repoId: string, cardId: string): Promise<void> {
  const user = await requireUser();
  await boardOps.deleteCard(user.id, cardId);
  revalidatePath(`/repo/${repoId}`);
  revalidatePath("/");
}
