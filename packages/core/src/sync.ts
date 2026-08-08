import {
  emptyChangeSet,
  ENTITY_KINDS,
  type Card,
  type ChangeSet,
  type Column,
  type EntityKind,
  type Rejection,
  type Repo,
} from "@kybird/shared";
import { syncOnce } from "./api.js";
import type { Store } from "./store.js";

export type SyncReport = {
  pushed: number;
  pulled: number;
  /** LWW 나 권한에서 밀려 로컬 사본으로 보관된 건. */
  conflicts: Rejection[];
  /** 부모가 아직 서버에 없어서 다음 동기화로 미뤄진 건. */
  deferred: Rejection[];
  cursor: number;
  rounds: number;
};

/** 한 번의 `sync` 안에서 pull 을 몇 번까지 돌릴지. 무한 루프 방지용. */
const MAX_ROUNDS = 100;

/**
 * 로컬과 서버를 한 번 맞춘다.
 *
 * 서버가 `hasMore` 를 주는 동안 계속 돈다. 두 번째 라운드부터는 올릴 게
 * 없으므로 빈 변경분을 보낸다 — 첫 라운드에서 이미 다 올렸다.
 */
export async function sync(
  store: Store,
  options: { serverUrl: string; token: string },
): Promise<SyncReport> {
  const report: SyncReport = {
    pushed: 0,
    pulled: 0,
    conflicts: [],
    deferred: [],
    cursor: store.cursor,
    rounds: 0,
  };

  let outgoing = store.pending();
  let completed = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    report.rounds = round + 1;

    const response = await syncOnce(options.serverUrl, options.token, {
      cursor: store.cursor,
      changes: outgoing,
    });

    const rejectedIds = new Set(response.rejected.map((r) => `${r.kind}:${r.id}`));

    store.transaction(() => {
      // 1. 거절된 것부터 처리한다.
      for (const rejection of response.rejected) {
        const outcome = handleRejection(store, rejection, outgoing);
        if (outcome === "deferred") report.deferred.push(rejection);
        else report.conflicts.push(rejection);
      }

      // 2. 받아들여진 push 의 dirty 를 내린다.
      //    updatedAt 을 같이 대조하므로, 왕복 중에 또 고쳐진 행은 dirty 로 남는다.
      for (const kind of ENTITY_KINDS) {
        for (const row of outgoing[kind]) {
          if (rejectedIds.has(`${kind}:${row.id}`)) continue;
          store.clearDirty(kind, row.id, row.updatedAt);
          report.pushed++;
        }
      }

      // 3. 서버 변경분을 반영한다. ENTITY_KINDS 가 의존성 순서(레포 → 컬럼 → 카드)다.
      for (const kind of ENTITY_KINDS) {
        for (const row of response.changes[kind]) {
          const result = store.applyRemote(kind, row as Repo & Column & Card);
          if (result === "applied") report.pulled++;
        }
      }

      store.cursor = response.cursor;
    });

    report.cursor = response.cursor;

    if (!response.hasMore) {
      completed = true;
      break;
    }

    // 다음 라운드는 순수 pull 이다.
    outgoing = emptyChangeSet();
  }

  if (!completed) {
    throw new Error(
      `동기화가 ${MAX_ROUNDS}회 라운드 안에 끝나지 않았다. 서버 커서가 전진하지 않는 것 같다.`,
    );
  }

  return report;
}

type RejectionOutcome = "conflict" | "deferred";

function handleRejection(
  store: Store,
  rejection: Rejection,
  outgoing: ChangeSet,
): RejectionOutcome {
  const kind = rejection.kind as EntityKind;

  if (rejection.reason === "missing_parent") {
    // dirty 를 유지해서 다음 동기화에 다시 시도한다. 부모가 아직 안 올라갔을 뿐
    // 보통은 곧 도착한다.
    return "deferred";
  }

  // stale / forbidden — 진 값을 사본으로 남기고 dirty 를 내린다.
  // 서버 값은 이번 pull 에 섞여 내려와서 로컬을 덮어쓴다.
  const local = outgoing[kind].find((row) => row.id === rejection.id);
  if (local) {
    store.recordConflict(kind, rejection.id, rejection.reason, local);
    store.clearDirty(kind, rejection.id, local.updatedAt);
  }
  return "conflict";
}

/** 리포트를 사람이 읽을 한 줄로. */
export function formatReport(report: SyncReport): string {
  const parts = [`올림 ${report.pushed}`, `받음 ${report.pulled}`];
  if (report.conflicts.length > 0) parts.push(`충돌 ${report.conflicts.length}`);
  if (report.deferred.length > 0) parts.push(`보류 ${report.deferred.length}`);
  return `${parts.join(", ")} (커서 ${report.cursor})`;
}
