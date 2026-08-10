import { listCommits, readCommit, readDiff, type CommitInfo } from "./git.js";
import type { IngestItem, Store } from "./store.js";

/**
 * 3층 주입의 바닥층.
 *
 * 핵심은 **비협조를 데이터 손실이 아니라 지연으로 강등**시키는 것이다.
 * 에이전트가 그 순간 지식을 안 남겨도 커밋은 git 에 남아있으므로, 나중에
 * 그 커밋을 읽어 뒤늦게 엔트리를 만들 수 있다.
 *
 * 여기서는 **재료만 준비한다.** 실제로 글을 쓰는 건 이미 돌고 있는 에이전트다
 * (MCP `wiki_pending` → `wiki_log`). 별도 LLM API 키를 요구하지 않는 이유이고,
 * 그래서 큐가 밀려도 잃는 건 없다 — 다음에 아무 세션이나 붙으면 소화된다.
 */

export type BackfillItem = {
  queueId: number;
  repoId: string;
  repoPath: string;
  commit: CommitInfo;
  diff: string;
};

/**
 * 아직 소화되지 않은 커밋들의 재료를 꺼낸다.
 *
 * 큐에 있지만 실제로는 사라진 커밋(리베이스·강제푸시로 날아간 것)은 조용히
 * 처리 완료로 넘긴다. 영원히 못 읽는 항목이 큐 앞에 박혀 있으면 그 뒤가
 * 전부 막힌다.
 */
export function collectBackfill(
  store: Store,
  options: { repoId?: string; limit?: number; maxDiffChars?: number } = {},
): BackfillItem[] {
  const limit = options.limit ?? 5;
  const items: BackfillItem[] = [];

  // 읽기 실패로 건너뛴 게 있을 수 있으니 넉넉히 훑는다.
  const candidates = store.listPendingIngest(options.repoId, Math.max(limit * 4, 20));

  for (const queued of candidates) {
    if (items.length >= limit) break;
    const material = materialize(store, queued, options.maxDiffChars);
    if (!material) continue;
    // 레포가 공유되면서 큐는 로컬 전용이라 팀원끼리 "이미 처리했나"를
    // 모른다 — 대신 결과물(sourceRef)로 확인한다. 다른 멤버가 이미 이
    // 커밋을 wiki 로 뽑아놨으면 조용히 넘긴다.
    if (store.hasSourceRef(material.repoId, material.commit.sha)) {
      store.markIngested(queued.id);
      continue;
    }
    items.push(material);
  }

  return items;
}

function materialize(
  store: Store,
  queued: IngestItem,
  maxDiffChars?: number,
): BackfillItem | null {
  const commit = readCommit(queued.repoPath, queued.ref);
  if (commit === null) {
    // 커밋이 없어졌다. 되살아날 일이 없으므로 큐에서 치운다.
    store.markIngested(queued.id);
    return null;
  }
  return {
    queueId: queued.id,
    repoId: queued.repoId,
    repoPath: queued.repoPath,
    commit,
    diff: readDiff(queued.repoPath, queued.ref, maxDiffChars),
  };
}

/**
 * 큐를 거치지 않고 과거 커밋을 직접 채워넣는다.
 *
 * 훅을 나중에 깐 레포나, 훅 이전의 이력을 소화하고 싶을 때 쓴다.
 * 이미 큐에 있는 커밋은 `enqueueIngest` 가 알아서 무시한다.
 */
export function seedFromHistory(
  store: Store,
  options: { repoId: string; repoPath: string; since?: string; limit?: number },
): number {
  const commits = listCommits(options.repoPath, {
    since: options.since,
    limit: options.limit ?? 50,
  });

  store.transaction(() => {
    for (const ref of commits) {
      store.enqueueIngest({
        repoId: options.repoId,
        repoPath: options.repoPath,
        kind: "commit",
        ref,
      });
    }
  });

  return commits.length;
}

/**
 * 재료 하나를 에이전트가 읽을 텍스트로 만든다.
 *
 * 지시가 아니라 **재료**로 준다 — 무엇을 기록할지는 읽는 쪽이 판단한다.
 * 남길 게 없는 커밋(오타 수정, 포맷팅)도 많고, 그때 억지로 쓰게 만들면
 * wiki 가 쓰레기로 찬다.
 */
export function formatMaterial(item: BackfillItem): string {
  const { commit } = item;
  const lines = [
    `커밋 ${commit.shortSha} — ${commit.subject}`,
    `작성 ${commit.author}, ${commit.date}`,
    "",
  ];
  if (commit.body) {
    lines.push(commit.body, "");
  }
  lines.push(`파일 ${commit.files.length}개`, commit.stat.trim(), "", "---", "", item.diff);
  return lines.join("\n");
}
