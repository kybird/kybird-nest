import {
  changeSetSize,
  emptyChangeSet,
  incomingWins,
  newId,
  SYNC_PAGE_SIZE,
  type Card,
  type ChangeSet,
  type Column,
  type Embedding,
  type Rejection,
  type Repo,
  type SearchLog,
  type WikiEntry,
} from "@kybird/shared";
import { prisma } from "./prisma";
import type { Prisma } from "./generated/prisma/client";

const SEQ_COUNTER_ID = "seq";

/**
 * 전역 단조증가 seq 를 하나 발급한다.
 *
 * 반드시 호출부의 트랜잭션 안에서 실행해야 한다. SQLite 는 쓰기를 직렬화하므로
 * 동시 요청이 같은 값을 두 번 받는 일은 없다.
 */
async function nextSeq(tx: Prisma.TransactionClient): Promise<number> {
  const counter = await tx.counter.upsert({
    where: { id: SEQ_COUNTER_ID },
    create: { id: SEQ_COUNTER_ID, value: 1 },
    update: { value: { increment: 1 } },
    select: { value: true },
  });
  return counter.value;
}

// 서버는 DateTime 으로 저장하고 프로토콜은 epoch ms 로 주고받는다.
// 경계에서만 변환하고 그 밖에서는 섞지 않는다.
const toMs = (d: Date): number => d.getTime();
const toMsOrNull = (d: Date | null): number | null => (d === null ? null : d.getTime());
const fromMs = (ms: number): Date => new Date(ms);
const fromMsOrNull = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));

// 문자열 배열은 JSON 으로 저장한다. 서버는 내용을 해석하지 않는다.
const packList = (values: string[]): string => JSON.stringify(values);
function unpackList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

type StoredMeta = { id: string; userId: string; updatedAt: Date };
const META_SELECT = { id: true, userId: true, updatedAt: true } as const;
const META_SELECT_WITH_REPO = { id: true, userId: true, updatedAt: true, repoId: true } as const;

/**
 * 들어온 행 하나를 적용할지 판정한다.
 *
 * - 권한이 없으면 `forbidden`
 * - 서버 값이 더 최신이면 `stale`
 * - 그 외에는 적용
 *
 * `authorized` 는 호출부가 미리 판단해서 넘긴다 — 레포 멤버십 기준이
 * 종류마다 다르기 때문이다(레포 멤버 전원 공유 vs 프로젝트 독립 지식은
 * 작성자 본인만). 판정 기준은 **기존 행이 속한 레포**로 한다 — 들어오는
 * payload 가 주장하는 repoId 로 판단하면, 다른 레포 멤버가 남의 행을
 * "내 레포 소속"이라 우기고 뺏어갈 수 있다.
 */
function judge(
  kind: Rejection["kind"],
  incoming: { id: string; updatedAt: number },
  existing: StoredMeta | null,
  authorized: boolean,
): Rejection | null {
  if (existing === null) return null;
  if (!authorized) {
    return { kind, id: incoming.id, reason: "forbidden", serverUpdatedAt: null };
  }
  if (!incomingWins(incoming, { updatedAt: toMs(existing.updatedAt), id: existing.id })) {
    return { kind, id: incoming.id, reason: "stale", serverUpdatedAt: toMs(existing.updatedAt) };
  }
  return null;
}

function missingParent(kind: Rejection["kind"], id: string): Rejection {
  return { kind, id, reason: "missing_parent", serverUpdatedAt: null };
}

/**
 * 클라이언트가 올린 변경분을 적용한다.
 *
 * 적용 순서는 **의존성 순서**다 — 레포 → 컬럼 → 카드, 레포 → wiki 엔트리 →
 * 임베딩. 한 번의 동기화 안에서 새 레포와 그 안의 카드가 같이 올라오는 게
 * 정상이기 때문이다.
 */
export async function applyChanges(userId: string, changes: ChangeSet): Promise<Rejection[]> {
  const rejected: Rejection[] = [];
  if (changeSetSize(changes) === 0) return rejected;

  await prisma.$transaction(async (tx) => {
    // 이 트랜잭션 동안 유효한 멤버십. 새 레포가 이 안에서 만들어지면
    // 곧바로 여기 추가한다 — "레포 → 컬럼 → 카드"가 한 번의 동기화로
    // 같이 올라오는 게 정상이라, 방금 만든 레포의 자식들도 같은 요청
    // 안에서 통과해야 한다.
    const memberships = await tx.repoMember.findMany({ where: { userId }, select: { repoId: true } });
    const memberRepoIds = new Set(memberships.map((m) => m.repoId));

    const owns = {
      // "이 repoId 가 실제로 존재하고, 요청자가 그 레포의 멤버인가."
      // 존재하지 않는 repoId 는 애초에 memberRepoIds 에 없으므로 존재
      // 확인과 멤버십 확인을 겸한다.
      repo: (id: string) => memberRepoIds.has(id),
      // 카드의 부모 컬럼은 존재만 확인한다 — 권한은 레포 멤버십으로 이미
      // 걸렀으니 컬럼 자체의 소유자 개념은 더 이상 의미가 없다.
      column: async (id: string) =>
        (await tx.column.findUnique({ where: { id }, select: { id: true } })) !== null,
      // wiki 엔트리는 repoId 가 있으면 그 레포 멤버, null 이면(프로젝트
      // 독립 지식) 작성자 본인만 — 임베딩의 권한이 여기 그대로 얹힌다.
      entry: async (id: string) => {
        const e = await tx.wikiEntry.findUnique({
          where: { id },
          select: { userId: true, repoId: true },
        });
        if (!e) return false;
        return e.repoId === null ? e.userId === userId : memberRepoIds.has(e.repoId);
      },
      // repoId 가 null 인 건 "프로젝트 독립"이라는 뜻이지 부모 누락이 아니다.
      optionalRepo: (id: string | null) => (id === null ? true : owns.repo(id)),
    };

    for (const repo of changes.repos) {
      const existing = await tx.repo.findUnique({ where: { id: repo.id }, select: META_SELECT });
      const authorized = existing === null || memberRepoIds.has(existing.id);
      const verdict = judge("repos", repo, existing, authorized);
      if (verdict) {
        rejected.push(verdict);
        continue;
      }
      await writeRepo(tx, userId, repo, await nextSeq(tx));
      if (existing === null) {
        // 만든 사람이 곧 첫 멤버다 — 안 하면 다음 pull 에서 자기 레포가
        // 자기한테 안 보인다(pull 도 멤버십 기준으로 거르므로).
        await tx.repoMember.upsert({
          where: { repoId_userId: { repoId: repo.id, userId } },
          create: { id: newId(), repoId: repo.id, userId },
          update: {},
        });
        memberRepoIds.add(repo.id);
      }
    }

    for (const column of changes.columns) {
      const existing = await tx.column.findUnique({
        where: { id: column.id },
        select: META_SELECT_WITH_REPO,
      });
      const authorized = existing === null || memberRepoIds.has(existing.repoId ?? "");
      const verdict = judge("columns", column, existing, authorized);
      if (verdict) {
        rejected.push(verdict);
        continue;
      }
      if (!owns.repo(column.repoId)) {
        rejected.push(missingParent("columns", column.id));
        continue;
      }
      await writeColumn(tx, userId, column, await nextSeq(tx));
    }

    for (const card of changes.cards) {
      const existing = await tx.card.findUnique({
        where: { id: card.id },
        select: META_SELECT_WITH_REPO,
      });
      const authorized = existing === null || memberRepoIds.has(existing.repoId ?? "");
      const verdict = judge("cards", card, existing, authorized);
      if (verdict) {
        rejected.push(verdict);
        continue;
      }
      if (!(owns.repo(card.repoId) && (await owns.column(card.columnId)))) {
        rejected.push(missingParent("cards", card.id));
        continue;
      }
      await writeCard(tx, userId, card, await nextSeq(tx));
    }

    for (const entry of changes.wikiEntries) {
      const existing = await tx.wikiEntry.findUnique({
        where: { id: entry.id },
        select: META_SELECT_WITH_REPO,
      });
      const authorized =
        existing === null ||
        (existing.repoId === null ? existing.userId === userId : memberRepoIds.has(existing.repoId));
      const verdict = judge("wikiEntries", entry, existing, authorized);
      if (verdict) {
        rejected.push(verdict);
        continue;
      }
      if (!owns.optionalRepo(entry.repoId)) {
        rejected.push(missingParent("wikiEntries", entry.id));
        continue;
      }
      await writeWikiEntry(tx, userId, entry, await nextSeq(tx));
    }

    for (const embedding of changes.embeddings) {
      const existing = await tx.embedding.findUnique({
        where: { id: embedding.id },
        select: META_SELECT,
      });
      // embedding 자체엔 repoId 가 없다 — 부모 wiki 엔트리를 한 번 타고
      // 올라가서 판단한다(owns.entry 가 존재 확인과 겸함). 기존 행이 있는데
      // 부모에 접근 못 하면 forbidden, 새 행인데 부모가 없으면 missingParent
      // — judge() 가 existing 유무로 이미 그 둘을 갈라준다.
      const parentOk = await owns.entry(embedding.entryId);
      const verdict = judge("embeddings", embedding, existing, parentOk);
      if (verdict) {
        rejected.push(verdict);
        continue;
      }
      if (!parentOk) {
        rejected.push(missingParent("embeddings", embedding.id));
        continue;
      }
      await writeEmbedding(tx, userId, embedding, await nextSeq(tx));
    }

    for (const log of changes.searchLogs) {
      const existing = await tx.searchLog.findUnique({ where: { id: log.id }, select: META_SELECT });
      // 검색 기록은 공유 대상이 아니다 — 예나 지금이나 작성자 본인만.
      const authorized = existing === null || existing.userId === userId;
      const verdict = judge("searchLogs", log, existing, authorized);
      if (verdict) {
        rejected.push(verdict);
        continue;
      }
      if (!owns.optionalRepo(log.repoId)) {
        rejected.push(missingParent("searchLogs", log.id));
        continue;
      }
      await writeSearchLog(tx, userId, log, await nextSeq(tx));
    }
  });

  return rejected;
}

async function writeRepo(
  tx: Prisma.TransactionClient,
  userId: string,
  repo: Repo,
  seq: number,
): Promise<void> {
  const data = {
    name: repo.name,
    path: repo.path,
    gitRemote: repo.gitRemote,
    updatedAt: fromMs(repo.updatedAt),
    deletedAt: fromMsOrNull(repo.deletedAt),
    seq,
  };
  await tx.repo.upsert({
    where: { id: repo.id },
    create: { id: repo.id, userId, ...data },
    update: data,
  });
}

async function writeColumn(
  tx: Prisma.TransactionClient,
  userId: string,
  column: Column,
  seq: number,
): Promise<void> {
  const data = {
    repoId: column.repoId,
    title: column.title,
    rank: column.rank,
    updatedAt: fromMs(column.updatedAt),
    deletedAt: fromMsOrNull(column.deletedAt),
    seq,
  };
  await tx.column.upsert({
    where: { id: column.id },
    create: { id: column.id, userId, ...data },
    update: data,
  });
}

async function writeCard(
  tx: Prisma.TransactionClient,
  userId: string,
  card: Card,
  seq: number,
): Promise<void> {
  const data = {
    repoId: card.repoId,
    columnId: card.columnId,
    title: card.title,
    body: card.body,
    rank: card.rank,
    updatedAt: fromMs(card.updatedAt),
    deletedAt: fromMsOrNull(card.deletedAt),
    seq,
  };
  await tx.card.upsert({
    where: { id: card.id },
    create: { id: card.id, userId, ...data },
    update: data,
  });
}

async function writeWikiEntry(
  tx: Prisma.TransactionClient,
  userId: string,
  entry: WikiEntry,
  seq: number,
): Promise<void> {
  const data = {
    repoId: entry.repoId,
    title: entry.title,
    body: entry.body,
    kind: entry.kind,
    tags: packList(entry.tags),
    sourceRef: entry.sourceRef,
    updatedAt: fromMs(entry.updatedAt),
    deletedAt: fromMsOrNull(entry.deletedAt),
    seq,
  };
  await tx.wikiEntry.upsert({
    where: { id: entry.id },
    create: { id: entry.id, userId, ...data },
    update: data,
  });
}

async function writeEmbedding(
  tx: Prisma.TransactionClient,
  userId: string,
  embedding: Embedding,
  seq: number,
): Promise<void> {
  const data = {
    entryId: embedding.entryId,
    model: embedding.model,
    dim: embedding.dim,
    vector: embedding.vector,
    updatedAt: fromMs(embedding.updatedAt),
    deletedAt: fromMsOrNull(embedding.deletedAt),
    seq,
  };
  await tx.embedding.upsert({
    where: { id: embedding.id },
    create: { id: embedding.id, userId, ...data },
    update: data,
  });
}

async function writeSearchLog(
  tx: Prisma.TransactionClient,
  userId: string,
  log: SearchLog,
  seq: number,
): Promise<void> {
  const data = {
    repoId: log.repoId,
    query: log.query,
    scope: log.scope,
    strategy: log.strategy,
    model: log.model,
    resultIds: packList(log.resultIds),
    usedIds: packList(log.usedIds),
    tookMs: log.tookMs,
    updatedAt: fromMs(log.updatedAt),
    deletedAt: fromMsOrNull(log.deletedAt),
    seq,
  };
  await tx.searchLog.upsert({
    where: { id: log.id },
    create: { id: log.id, userId, ...data },
    update: data,
  });
}

export type PullResult = { cursor: number; changes: ChangeSet; hasMore: boolean };

/**
 * `cursor` 이후의 변경분을 돌려준다.
 *
 * 새 커서는 **실제로 돌려준 행들의 최대 seq** 다. 이 불변식 덕분에 push 와 pull 이
 * 별도 트랜잭션이어도 행을 건너뛰지 않는다 — 돌려주지 않은 행 너머로 커서가
 * 전진하는 일이 없기 때문이다.
 */
export async function pullChanges(userId: string, cursor: number): Promise<PullResult> {
  // 종류별로 페이지 크기만큼 넉넉히 읽고, seq 순으로 잘라낸다.
  const take = SYNC_PAGE_SIZE + 1;
  const orderBy = { seq: "asc" } as const;

  // 레포/컬럼/카드/wiki/임베딩은 이제 "내가 만든 것"이 아니라 "내가 멤버인
  // 레포에 속한 것" 기준으로 내려간다. 검색 기록만 예외 — 순수 개인 기록.
  const memberships = await prisma.repoMember.findMany({ where: { userId }, select: { repoId: true } });
  const memberRepoIds = memberships.map((m) => m.repoId);

  const repoWhere = { id: { in: memberRepoIds }, seq: { gt: cursor } };
  const repoScopedWhere = { repoId: { in: memberRepoIds }, seq: { gt: cursor } };
  // wiki 는 repoId 가 null(프로젝트 독립 지식)이면 본인 것만, 있으면 그
  // 레포 멤버 전원.
  const wikiWhere = {
    seq: { gt: cursor },
    OR: [{ repoId: null, userId }, { repoId: { in: memberRepoIds } }],
  };
  // 임베딩엔 repoId 가 없으니 부모 wiki 엔트리를 relation filter 로 탄다.
  const embeddingWhere = {
    seq: { gt: cursor },
    entry: { OR: [{ repoId: null, userId }, { repoId: { in: memberRepoIds } }] },
  };
  const searchLogWhere = { userId, seq: { gt: cursor } };

  const [repos, columns, cards, wikiEntries, embeddings, searchLogs] = await Promise.all([
    prisma.repo.findMany({ where: repoWhere, orderBy, take }),
    prisma.column.findMany({ where: repoScopedWhere, orderBy, take }),
    prisma.card.findMany({ where: repoScopedWhere, orderBy, take }),
    prisma.wikiEntry.findMany({ where: wikiWhere, orderBy, take }),
    prisma.embedding.findMany({ where: embeddingWhere, orderBy, take }),
    prisma.searchLog.findMany({ where: searchLogWhere, orderBy, take }),
  ]);

  // 여러 종류를 하나의 seq 수열로 합쳐서 앞에서부터 SYNC_PAGE_SIZE 개만 취한다.
  // 이렇게 해야 "커서 = 돌려준 것들의 최대 seq" 가 종류에 상관없이 성립한다.
  const all = [
    ...repos.map((row) => ({ seq: row.seq, kind: "repos" as const, row })),
    ...columns.map((row) => ({ seq: row.seq, kind: "columns" as const, row })),
    ...cards.map((row) => ({ seq: row.seq, kind: "cards" as const, row })),
    ...wikiEntries.map((row) => ({ seq: row.seq, kind: "wikiEntries" as const, row })),
    ...embeddings.map((row) => ({ seq: row.seq, kind: "embeddings" as const, row })),
    ...searchLogs.map((row) => ({ seq: row.seq, kind: "searchLogs" as const, row })),
  ].sort((a, b) => a.seq - b.seq);

  const page = all.slice(0, SYNC_PAGE_SIZE);
  const hasMore = all.length > page.length;

  const changes = emptyChangeSet();
  for (const item of page) {
    switch (item.kind) {
      case "repos":
        changes.repos.push({
          id: item.row.id,
          name: item.row.name,
          path: item.row.path,
          gitRemote: item.row.gitRemote,
          updatedAt: toMs(item.row.updatedAt),
          deletedAt: toMsOrNull(item.row.deletedAt),
        });
        break;
      case "columns":
        changes.columns.push({
          id: item.row.id,
          repoId: item.row.repoId,
          title: item.row.title,
          rank: item.row.rank,
          updatedAt: toMs(item.row.updatedAt),
          deletedAt: toMsOrNull(item.row.deletedAt),
        });
        break;
      case "cards":
        changes.cards.push({
          id: item.row.id,
          repoId: item.row.repoId,
          columnId: item.row.columnId,
          title: item.row.title,
          body: item.row.body,
          rank: item.row.rank,
          updatedAt: toMs(item.row.updatedAt),
          deletedAt: toMsOrNull(item.row.deletedAt),
        });
        break;
      case "wikiEntries":
        changes.wikiEntries.push({
          id: item.row.id,
          repoId: item.row.repoId,
          title: item.row.title,
          body: item.row.body,
          kind: item.row.kind as WikiEntry["kind"],
          tags: unpackList(item.row.tags),
          sourceRef: item.row.sourceRef,
          updatedAt: toMs(item.row.updatedAt),
          deletedAt: toMsOrNull(item.row.deletedAt),
        });
        break;
      case "embeddings":
        changes.embeddings.push({
          id: item.row.id,
          entryId: item.row.entryId,
          model: item.row.model,
          dim: item.row.dim,
          vector: item.row.vector,
          updatedAt: toMs(item.row.updatedAt),
          deletedAt: toMsOrNull(item.row.deletedAt),
        });
        break;
      case "searchLogs":
        changes.searchLogs.push({
          id: item.row.id,
          repoId: item.row.repoId,
          query: item.row.query,
          scope: item.row.scope as SearchLog["scope"],
          strategy: item.row.strategy,
          model: item.row.model,
          resultIds: unpackList(item.row.resultIds),
          usedIds: unpackList(item.row.usedIds),
          tookMs: item.row.tookMs,
          updatedAt: toMs(item.row.updatedAt),
          deletedAt: toMsOrNull(item.row.deletedAt),
        });
        break;
    }
  }

  const lastSeq = page.length > 0 ? page[page.length - 1]!.seq : cursor;
  return { cursor: lastSeq, changes, hasMore };
}
