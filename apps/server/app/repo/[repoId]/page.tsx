import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { listDeletedCards, loadBoard } from "@/lib/board";
import { BoardClient } from "./board-client";

export default async function RepoPage({ params }: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await params;

  const user = await currentUser();
  if (!user) redirect("/login");

  const board = await loadBoard(user.id, repoId);
  if (!board) notFound();

  const deletedCards = await listDeletedCards(user.id, repoId);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <Link
          href="/"
          className="text-sm text-neutral-500 underline-offset-4 hover:underline"
        >
          ← 전체 레포
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{board.repo.name}</h1>
        {board.repo.gitRemote ? (
          <p className="mt-1 font-mono text-xs text-neutral-400">{board.repo.gitRemote}</p>
        ) : null}
      </header>

      <BoardClient
        repoId={board.repo.id}
        columns={board.columns}
        deletedCards={deletedCards}
      />
    </main>
  );
}
