"use client";

import { useOptimistic, useRef, useState, useTransition } from "react";
import type { Card, Column } from "@kybird/shared";
import { addCardAction, deleteCardAction, editCardAction, moveCardAction } from "@/app/actions";

type BoardColumn = { column: Column; cards: Card[] };

type MoveAction = { cardId: string; toColumnId: string; position: number };

/**
 * 서버 왕복을 기다리지 않고 먼저 옮겨 보여준다. 드래그해놓고 카드가
 * 제자리로 돌아갔다가 다시 움직이면 칸반처럼 느껴지지 않는다.
 */
function applyMove(columns: BoardColumn[], move: MoveAction): BoardColumn[] {
  let dragged: Card | undefined;
  const without = columns.map((entry) => {
    const index = entry.cards.findIndex((c) => c.id === move.cardId);
    if (index === -1) return entry;
    dragged = entry.cards[index];
    return { ...entry, cards: entry.cards.filter((c) => c.id !== move.cardId) };
  });
  if (!dragged) return columns;

  const card = dragged;
  return without.map((entry) => {
    if (entry.column.id !== move.toColumnId) return entry;
    const cards = [...entry.cards];
    cards.splice(Math.min(Math.max(move.position, 0), cards.length), 0, {
      ...card,
      columnId: move.toColumnId,
    });
    return { ...entry, cards };
  });
}

export function BoardClient({ repoId, columns }: { repoId: string; columns: BoardColumn[] }) {
  const [optimistic, addOptimistic] = useOptimistic(columns, applyMove);
  const [, startTransition] = useTransition();
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  function move(cardId: string, toColumnId: string, position: number) {
    startTransition(async () => {
      addOptimistic({ cardId, toColumnId, position });
      await moveCardAction(repoId, cardId, toColumnId, position);
    });
  }

  /** 대상 컬럼에서 끌고 있는 카드를 뺀 목록 기준으로 삽입 위치를 센다. */
  function positionBefore(columnId: string, beforeCardId: string | null): number {
    const target = optimistic.find((c) => c.column.id === columnId);
    if (!target) return 0;
    const rest = target.cards.filter((c) => c.id !== dragging);
    if (beforeCardId === null) return rest.length;
    const index = rest.findIndex((c) => c.id === beforeCardId);
    return index === -1 ? rest.length : index;
  }

  function handleDrop(columnId: string, beforeCardId: string | null) {
    const cardId = dragging;
    setDragging(null);
    setDropTarget(null);
    if (!cardId) return;
    move(cardId, columnId, positionBefore(columnId, beforeCardId));
  }

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {optimistic.map(({ column, cards }) => (
        <section
          key={column.id}
          onDragOver={(e) => {
            e.preventDefault();
            setDropTarget(column.id);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setDropTarget((current) => (current === column.id ? null : current));
          }}
          onDrop={(e) => {
            e.preventDefault();
            handleDrop(column.id, null);
          }}
          className={`flex min-h-64 flex-col rounded-lg border p-3 transition-colors ${
            dropTarget === column.id
              ? "border-neutral-900 bg-neutral-50 dark:border-neutral-300 dark:bg-neutral-900"
              : "border-neutral-200 dark:border-neutral-800"
          }`}
        >
          <h2 className="mb-3 flex items-baseline justify-between px-1 text-sm font-medium">
            {column.title}
            <span className="tabular-nums text-xs text-neutral-400">{cards.length}</span>
          </h2>

          <div className="flex flex-1 flex-col gap-2">
            {cards.map((card) => (
              <CardItem
                key={card.id}
                repoId={repoId}
                card={card}
                dragging={dragging === card.id}
                onDragStart={() => setDragging(card.id)}
                onDragEnd={() => {
                  setDragging(null);
                  setDropTarget(null);
                }}
                onDropBefore={() => handleDrop(column.id, card.id)}
              />
            ))}
          </div>

          <AddCard repoId={repoId} columnId={column.id} />
        </section>
      ))}
    </div>
  );
}

function CardItem({
  repoId,
  card,
  dragging,
  onDragStart,
  onDragEnd,
  onDropBefore,
}: {
  repoId: string;
  card: Card;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropBefore: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [, startTransition] = useTransition();

  if (editing) {
    return (
      <form
        action={(formData) => {
          setEditing(false);
          const title = String(formData.get("title") ?? "");
          startTransition(() => editCardAction(repoId, card.id, title));
        }}
      >
        <input
          name="title"
          defaultValue={card.title}
          autoFocus
          onBlur={(e) => e.currentTarget.form?.requestSubmit()}
          className="w-full rounded-md border border-neutral-900 px-3 py-2 text-sm outline-none dark:border-neutral-300 dark:bg-neutral-900"
        />
        <button type="submit" className="sr-only">
          제목 저장
        </button>
      </form>
    );
  }

  return (
    <article
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        // Firefox 는 데이터가 없으면 드래그를 시작하지 않는다.
        e.dataTransfer.setData("text/plain", card.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDropBefore();
      }}
      onDoubleClick={() => setEditing(true)}
      className={`group flex cursor-grab items-start justify-between gap-2 rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm active:cursor-grabbing dark:border-neutral-800 dark:bg-neutral-950 ${
        dragging ? "opacity-40" : ""
      }`}
    >
      <span className="min-w-0 break-words">{card.title}</span>
      <DeleteButton repoId={repoId} cardId={card.id} />
    </article>
  );
}

function DeleteButton({ repoId, cardId }: { repoId: string; cardId: string }) {
  const [, startTransition] = useTransition();
  return (
    <button
      type="button"
      aria-label="카드 삭제"
      onClick={() => startTransition(() => deleteCardAction(repoId, cardId))}
      className="shrink-0 text-neutral-300 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-600 focus:opacity-100 dark:text-neutral-600"
    >
      ×
    </button>
  );
}

function AddCard({ repoId, columnId }: { repoId: string; columnId: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [, startTransition] = useTransition();

  return (
    <form
      ref={formRef}
      action={(formData) => {
        const title = String(formData.get("title") ?? "");
        formRef.current?.reset();
        startTransition(() => addCardAction(repoId, columnId, title));
      }}
      className="mt-2"
    >
      <input
        name="title"
        placeholder="+ 카드 추가"
        className="w-full rounded-md border border-transparent px-3 py-2 text-sm outline-none placeholder:text-neutral-400 hover:border-neutral-200 focus:border-neutral-900 dark:hover:border-neutral-800 dark:focus:border-neutral-300 dark:focus:bg-neutral-900"
      />
      {/* 엔터 제출을 브라우저의 암묵적 제출 규칙에 맡기지 않는다. */}
      <button type="submit" className="sr-only">
        카드 추가
      </button>
    </form>
  );
}
