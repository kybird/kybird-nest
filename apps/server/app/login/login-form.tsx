"use client";

import { useActionState, useState } from "react";
import { authAction, type FormState } from "@/app/actions";

export function LoginForm({ inviteRequired }: { inviteRequired: boolean }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [state, formAction, pending] = useActionState<FormState, FormData>(authAction, null);

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-8 px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">kybird-nest</h1>
        <p className="mt-1 text-sm text-neutral-500">
          코딩 에이전트를 위한 지식·스킬 백엔드
        </p>
      </div>

      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="mode" value={mode} />

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">이메일</span>
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-300"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">비밀번호</span>
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete={mode === "register" ? "new-password" : "current-password"}
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-300"
          />
          {mode === "register" ? (
            <span className="text-xs text-neutral-500">8자 이상</span>
          ) : null}
        </label>

        {mode === "register" && inviteRequired ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">초대 코드</span>
            <input
              name="invite"
              type="text"
              required
              autoComplete="off"
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-300"
            />
            <span className="text-xs text-neutral-500">
              공개된 서버라 초대 코드가 있어야 가입된다
            </span>
          </label>
        ) : null}

        {state?.error ? (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {state.error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {pending ? "…" : mode === "register" ? "가입하고 시작" : "로그인"}
        </button>
      </form>

      <button
        type="button"
        onClick={() => setMode(mode === "login" ? "register" : "login")}
        className="text-sm text-neutral-500 underline-offset-4 hover:underline"
      >
        {mode === "login" ? "계정이 없다 — 새로 만들기" : "이미 계정이 있다 — 로그인"}
      </button>
    </main>
  );
}
