"use client";

import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import {
  cardRejectionOwner,
  LOOP_LABEL,
  LOOP_SUBJECT,
  REGRESS_STALL_THRESHOLD,
  regressionReport,
  type Card,
  type CardRejectedBy,
  type Column,
} from "@kybird/shared";
import {
  addCardAction,
  addColumnAction,
  deleteCardAction,
  editCardDetailsAction,
  moveCardAction,
  rejectCardAction,
  renameColumnAction,
  restoreCardAction,
} from "@/app/actions";

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

export function BoardClient({
  repoId,
  columns,
  deletedCards,
}: {
  repoId: string;
  columns: BoardColumn[];
  deletedCards: Card[];
}) {
  const [optimistic, addOptimistic] = useOptimistic(columns, applyMove);
  const [, startTransition] = useTransition();
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [showTrash, setShowTrash] = useState(false);

  const openCard = optimistic.flatMap((c) => c.cards).find((c) => c.id === openCardId) ?? null;

  // 회귀 계기판. optimistic 을 쓰는 이유는 방금 드래그로 되돌린 카드가 서버
  // 왕복을 기다리지 않고 바로 반영되게 하기 위해서다 — 보드와 요약이 한
  // 프레임이라도 다른 말을 하면 계기판을 못 믿게 된다.
  const regression = regressionReport(optimistic.flatMap((c) => c.cards));

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

  // 드래그와 싱글클릭(모달 열기)이 겹치면 드래그 끝에 모달이 뜬다.
  // 드래그 시작 시 모달이 열려있으면 닫고, 드래그 중엔 클릭 무시.
  const draggingRef = useRef<string | null>(null);

  return (
    <>
      {deletedCards.length > 0 && (
        <button
          type="button"
          onClick={() => setShowTrash((v) => !v)}
          className="mb-4 text-sm text-neutral-500 underline-offset-4 hover:underline"
        >
          보관함 ({deletedCards.length}) {showTrash ? "숨기기" : "보기"}
        </button>
      )}

      {regression.stalled.length > 0 && (
        <aside
          role="status"
          className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900 dark:bg-amber-950/40"
        >
          <p className="font-medium text-amber-800 dark:text-amber-200">
            {REGRESS_STALL_THRESHOLD}회 이상 회귀한 카드 {regression.stalled.length}개 — 수렴하지
            않고 있다
          </p>
          <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
            카드 정의(범위·완료 조건)나 접근을 다시 봐야 한다는 신호다. 보드 전체 회귀는 카드{" "}
            {regression.regressed.length}개 / {regression.totalRegressions}회.
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {regression.stalled.map((card) => (
              <li key={card.id}>
                <button
                  type="button"
                  onClick={() => setOpenCardId(card.id)}
                  className="text-left text-amber-900 underline-offset-4 hover:underline dark:text-amber-100"
                >
                  ↺{card.regressCount} {card.title}
                </button>
              </li>
            ))}
          </ul>
        </aside>
      )}

      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: `repeat(${optimistic.length}, minmax(0, 1fr))` }}
      >
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
          <ColumnHeader
            repoId={repoId}
            columnId={column.id}
            title={column.title}
            count={cards.length}
          />

          <div className="flex flex-1 flex-col gap-2">
            {cards.map((card) => (
              <CardItem
                key={card.id}
                repoId={repoId}
                card={card}
                dragging={dragging === card.id}
                onDragStart={() => {
                  setDragging(card.id);
                  draggingRef.current = card.id;
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setDropTarget(null);
                  // 드래그 직후의 click 이벤트가 모달을 여는 걸 막는다.
                  setTimeout(() => (draggingRef.current = null), 0);
                }}
                onDropBefore={() => handleDrop(column.id, card.id)}
                onOpen={() => {
                  if (!draggingRef.current) setOpenCardId(card.id);
                }}
              />
            ))}
          </div>

          <AddCard repoId={repoId} columnId={column.id} />
        </section>
      ))}

      {openCard && (
        <CardModal
          repoId={repoId}
          card={openCard}
          onClose={() => setOpenCardId(null)}
        />
      )}

      {showTrash && deletedCards.length > 0 && (
        <TrashPanel repoId={repoId} cards={deletedCards} />
      )}

      <AddColumn repoId={repoId} />
    </div>
    </>
  );
}

function ColumnHeader({
  repoId,
  columnId,
  title,
  count,
}: {
  repoId: string;
  columnId: string;
  title: string;
  count: number;
}) {
  const [editing, setEditing] = useState(false);
  const [, startTransition] = useTransition();

  if (editing) {
    return (
      <form
        action={(formData) => {
          setEditing(false);
          const newTitle = String(formData.get("title") ?? "");
          startTransition(() => renameColumnAction(repoId, columnId, newTitle));
        }}
        className="mb-3 px-1"
      >
        <input
          name="title"
          defaultValue={title}
          autoFocus
          onBlur={(e) => e.currentTarget.form?.requestSubmit()}
          className="w-full rounded-md border border-neutral-900 px-2 py-1 text-sm font-medium outline-none dark:border-neutral-300 dark:bg-neutral-900"
        />
        <button type="submit" className="sr-only">
          컬럼 이름 저장
        </button>
      </form>
    );
  }

  return (
    <h2
      onDoubleClick={() => setEditing(true)}
      title="더블클릭해서 이름 변경"
      className="mb-3 flex cursor-pointer items-baseline justify-between px-1 text-sm font-medium"
    >
      {title}
      <span className="tabular-nums text-xs text-neutral-400">{count}</span>
    </h2>
  );
}

function AddColumn({ repoId }: { repoId: string }) {
  const [adding, setAdding] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [, startTransition] = useTransition();

  if (!adding) {
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="mt-4 text-sm text-neutral-400 underline-offset-4 hover:text-neutral-700 hover:underline dark:hover:text-neutral-200"
      >
        + 컬럼 추가
      </button>
    );
  }

  return (
    <form
      ref={formRef}
      action={(formData) => {
        const title = String(formData.get("title") ?? "");
        formRef.current?.reset();
        setAdding(false);
        if (title.trim()) startTransition(() => addColumnAction(repoId, title));
      }}
      className="mt-4"
    >
      <input
        name="title"
        placeholder="컬럼 이름"
        autoFocus
        onBlur={(e) => {
          if (!e.currentTarget.value.trim()) setAdding(false);
          else e.currentTarget.form?.requestSubmit();
        }}
        className="w-full max-w-xs rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900"
      />
      <button type="submit" className="sr-only">
        컬럼 추가
      </button>
    </form>
  );
}

function CardItem({
  repoId,
  card,
  dragging,
  onDragStart,
  onDragEnd,
  onDropBefore,
  onOpen,
}: {
  repoId: string;
  card: Card;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropBefore: () => void;
  onOpen: () => void;
}) {
  const bodyPreview = card.body.trim();
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
      onClick={onOpen}
      className={`group flex cursor-grab flex-col gap-0.5 rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm active:cursor-grabbing dark:border-neutral-800 dark:bg-neutral-950 ${
        dragging ? "opacity-40" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words">{card.title}</span>
        <div className="flex shrink-0 items-center gap-1">
          {card.regressCount > 0 && (
            <span
              title={
                card.regressCount >= REGRESS_STALL_THRESHOLD
                  ? `완료에서 ${card.regressCount}번 되돌아갔다 — 수렴하지 않고 있다`
                  : `완료에서 ${card.regressCount}번 되돌아갔다 (회귀)`
              }
              className={`rounded px-1 text-xs font-medium ${
                card.regressCount >= REGRESS_STALL_THRESHOLD
                  ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                  : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
              }`}
            >
              ↺{card.regressCount}
            </span>
          )}
          <DeleteButton repoId={repoId} cardId={card.id} />
        </div>
      </div>
      {card.rejectedBy !== null && card.rejectedReason !== null && (
        // 기각 사유를 카드 앞면에 보여준다 — 모달을 열어야만 보이면 "왜
        // 되돌아왔는지"를 아무도 안 읽고, 그러면 기각이 이동과 같아진다.
        <span className="line-clamp-2 text-xs text-red-600 dark:text-red-400">
          ⤺ {LOOP_LABEL[card.rejectedBy]} 기각: {card.rejectedReason}
        </span>
      )}
      {bodyPreview && (
        <span className="line-clamp-2 text-xs text-neutral-500 dark:text-neutral-400">
          {bodyPreview}
        </span>
      )}
    </article>
  );
}

function DeleteButton({ repoId, cardId }: { repoId: string; cardId: string }) {
  const [, startTransition] = useTransition();
  return (
    <button
      type="button"
      aria-label="카드 삭제"
      onClick={() => {
        if (!window.confirm("정말 지울까? 보관함에서 되살릴 수 있다.")) return;
        startTransition(() => deleteCardAction(repoId, cardId));
      }}
      className="shrink-0 text-neutral-300 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-600 focus:opacity-100 dark:text-neutral-600"
    >
      ×
    </button>
  );
}

/**
 * 보관함 — 삭제된 카드(툼스톤) 목록. 복구 버튼으로 되살린다.
 * 데이터는 삭제 시점부터 그대로 남아있었다(deletedAt 타임스탬프만 찍힌 채).
 */
function TrashPanel({ repoId, cards }: { repoId: string; cards: Card[] }) {
  const [, startTransition] = useTransition();
  return (
    <section className="mt-4 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <h2 className="mb-3 px-1 text-sm font-medium">보관함 ({cards.length})</h2>
      <div className="flex flex-col gap-2">
        {cards.map((card) => (
          <div
            key={card.id}
            className="flex items-center justify-between gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900"
          >
            <span className="min-w-0 break-words text-neutral-500 line-through dark:text-neutral-400">
              {card.title}
            </span>
            <button
              type="button"
              onClick={() => startTransition(() => restoreCardAction(repoId, card.id))}
              className="shrink-0 text-neutral-500 underline-offset-4 hover:text-neutral-900 hover:underline dark:hover:text-neutral-100"
            >
              복구
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * 카드 상세 모달. 제목과 본문을 같이 편집한다. 보드에서 카드를 클릭하면 열린다.
 * 본문이 데이터엔 있었지만 UI 에서 보이거나 고칠 수 없어서, 사용자가 제목을
 * 여러 카드로 쪼개는 수밖에 없던 문제를 푼다.
 */
function CardModal({
  repoId,
  card,
  onClose,
}: {
  repoId: string;
  card: Card;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const [rejecting, setRejecting] = useState(false);
  const [rejectBy, setRejectBy] = useState<CardRejectedBy>("qa");
  const [rejectReason, setRejectReason] = useState("");
  const [, startTransition] = useTransition();

  // 카드가 바뀌면(드래그 등으로) 입력값을 동기화한다.
  const cardId = card.id;
  useEffect(() => {
    setTitle(card.title);
    setBody(card.body);
  }, [cardId, card.title, card.body]);

  function save() {
    onClose();
    const t = title.trim();
    if (!t) return;
    startTransition(() => editCardDetailsAction(repoId, cardId, t, body));
  }

  function reject() {
    const reason = rejectReason.trim();
    if (!reason) return;
    onClose();
    startTransition(() => rejectCardAction(repoId, cardId, rejectBy, reason));
  }

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-lg flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950"
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
          className="w-full border-b border-neutral-200 pb-2 text-lg font-medium outline-none focus:border-neutral-900 dark:border-neutral-800 dark:focus:border-neutral-300"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="본문 — 배경, 범위, 왜 필요한지, 링크 등"
          rows={12}
          className="w-full resize-none text-sm outline-none dark:bg-neutral-950"
        />
        {card.rejectedBy !== null && card.rejectedReason !== null && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm dark:border-red-900 dark:bg-red-950/40">
            <p className="text-xs font-medium text-red-700 dark:text-red-300">
              {LOOP_LABEL[card.rejectedBy]} 기각 →{" "}
              {LOOP_SUBJECT[cardRejectionOwner(card.rejectedBy)]} 받는다
              {card.rejectedAt !== null && ` · ${new Date(card.rejectedAt).toLocaleString()}`}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-red-900 dark:text-red-100">
              {card.rejectedReason}
            </p>
          </div>
        )}

        {rejecting ? (
          <div className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
            <div className="flex gap-2 text-sm">
              {(["qa", "dev"] as const).map((option) => (
                <label key={option} className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="rejectBy"
                    checked={rejectBy === option}
                    onChange={() => setRejectBy(option)}
                  />
                  {LOOP_LABEL[option]} 기각 → {LOOP_LABEL[cardRejectionOwner(option)]}
                </label>
              ))}
            </div>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              autoFocus
              placeholder="왜 튕기는지 — 받는 쪽은 이것만 보고 고친다"
              rows={3}
              className="w-full resize-none rounded border border-neutral-200 p-2 text-sm outline-none dark:border-neutral-800 dark:bg-neutral-950"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRejecting(false)}
                className="rounded-md px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                취소
              </button>
              <button
                type="button"
                onClick={reject}
                disabled={rejectReason.trim().length === 0}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white disabled:opacity-40"
              >
                기각
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setRejecting(true)}
            className="self-start text-sm text-red-600 underline-offset-4 hover:underline dark:text-red-400"
          >
            기각해서 되돌리기
          </button>
        )}

        {(card.completedAt !== null || card.regressCount > 0) && (
          <p className="text-xs text-neutral-400">
            {card.completedAt !== null && (
              <>완료: {new Date(card.completedAt).toLocaleString()}</>
            )}
            {card.regressCount > 0 && (
              <span className="text-amber-600 dark:text-amber-400">
                {card.completedAt !== null ? " · " : ""}
                회귀 {card.regressCount}회
              </span>
            )}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900"
          >
            취소
          </button>
          <button
            type="button"
            onClick={save}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
          >
            저장
          </button>
        </div>
      </div>
    </div>
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
