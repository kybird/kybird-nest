import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { summarize } from "@/lib/board";
import { logoutAction } from "./actions";

export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const repos = await summarize(user.id);
  const totalCards = repos.reduce((sum, r) => sum + r.total, 0);

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <header className="mb-10 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">kybird-nest</h1>
          <p className="mt-1 text-sm text-neutral-500">
            레포 {repos.length}개 · 카드 {totalCards}장
          </p>
        </div>
        <form action={logoutAction}>
          <button
            type="submit"
            className="text-sm text-neutral-500 underline-offset-4 hover:underline"
          >
            {user.email} 로그아웃
          </button>
        </form>
      </header>

      {repos.length === 0 ? <EmptyState /> : null}

      <div className="flex flex-col gap-3">
        {repos.map((repo) => (
          <Link
            key={repo.id}
            href={`/repo/${repo.id}`}
            className="group rounded-lg border border-neutral-200 p-5 transition-colors hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
          >
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="font-medium group-hover:underline">{repo.name}</h2>
              <span className="shrink-0 text-xs text-neutral-500">
                {repo.lastActivity
                  ? `최근 ${new Date(repo.lastActivity).toLocaleDateString("ko-KR")}`
                  : "아직 카드 없음"}
              </span>
            </div>

            {repo.gitRemote ? (
              <p className="mt-1 truncate font-mono text-xs text-neutral-400">{repo.gitRemote}</p>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5">
              {repo.columns.map((col) => (
                <span key={col.title} className="text-sm">
                  <span className="text-neutral-500">{col.title}</span>{" "}
                  <span className="tabular-nums font-medium">{col.count}</span>
                </span>
              ))}
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center dark:border-neutral-700">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        아직 레포가 없다. 프로젝트 디렉토리에서 연결하면 여기에 나타난다.
      </p>
      <pre className="mt-4 inline-block rounded-md bg-neutral-100 px-4 py-2 text-left font-mono text-xs dark:bg-neutral-900">
        knest login{"\n"}knest link
      </pre>
    </div>
  );
}
