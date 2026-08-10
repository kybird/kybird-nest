import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  collectBackfill,
  findLink,
  formatMaterial,
  headCommit,
  hooksInstalled,
  installHooks,
  isGitRepo,
  seedFromHistory,
  type Store,
} from "@kybird/core";

export const HOOK_HELP = `knest hook — git 연동

  knest hook install     이 레포에 post-commit / pre-push 훅을 심는다
  knest hook status      설치 상태와 대기 중인 커밋 수
  knest hook enqueue     (훅이 호출한다) 현재 HEAD 를 큐에 넣는다

훅은 큐에 넣기만 하고 즉시 끝난다. 훅에서 LLM 을 부르면 커밋이 느려지고,
느려지면 --no-verify 로 꺼버리게 되기 때문이다.
`;

export const BACKFILL_HELP = `knest backfill — 밀린 커밋을 지식으로

  knest backfill [--limit N]        소화할 커밋의 재료를 꺼내 보여준다 (기본 3개)
  knest backfill --all              밀린 것 전부를 한 번에 꺼내 보여준다
                                    (이 솔루션을 기존 레포에 처음 붙일 때 —
                                     찔끔찔끔 반복 호출하지 말고 세션 한 번에 몰아서 처리해라)
  knest backfill seed [--limit N] [--since <ref>]
                                    과거 커밋을 큐에 채워넣는다
  knest backfill done <큐id>...     처리했다고 표시한다

실제로 글을 쓰는 건 에이전트다 (knest wiki add / raw). 여기서는 재료만 준비한다.
`;

/** 푸시할 때 거슬러 훑을 커밋 수. 훅이 오래 걸리면 안 되므로 적당히 끊는다. */
const PUSH_SWEEP_LIMIT = 20;

/** 훅이 실행할 CLI 진입점의 절대 경로. */
function cliEntryPath(): string {
  return fileURLToPath(new URL("./index.js", import.meta.url));
}

export function hookCommand(argv: string[], store: Store): number {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "install":
      return install(store);
    case "status":
      return status(store);
    case "enqueue":
      return enqueue(rest, store);
    default:
      process.stdout.write(HOOK_HELP);
      return sub === undefined || sub === "help" ? 0 : 1;
  }
}

function install(store: Store): number {
  const cwd = process.cwd();
  const linked = findLink(cwd);
  if (!linked) {
    process.stderr.write("이 디렉토리는 레포에 연결돼 있지 않다. knest link\n");
    return 1;
  }
  if (!isGitRepo(cwd)) {
    process.stderr.write(
      "git 레포가 아니다. 훅 없이도 knest wiki add 로 직접 기록할 수 있다.\n",
    );
    return 1;
  }

  const results = installHooks(cwd, { cliPath: cliEntryPath() });
  for (const result of results) {
    if (result.status === "installed") {
      process.stdout.write(`심었다: ${result.path}\n`);
    } else {
      process.stdout.write(
        `건너뜀: ${result.path}\n  이미 다른 훅이 있다. 아래 줄을 직접 넣어라:\n` +
          `  "${process.execPath}" "${cliEntryPath()}" hook enqueue --kind commit >/dev/null 2>&1 || true\n`,
      );
    }
  }
  void store;
  return 0;
}

function status(store: Store): number {
  const cwd = process.cwd();
  const linked = findLink(cwd);
  const installed = isGitRepo(cwd) ? hooksInstalled(cwd) : [];

  process.stdout.write(`git 레포: ${isGitRepo(cwd) ? "예" : "아니오"}\n`);
  process.stdout.write(`훅:       ${installed.length > 0 ? installed.join(", ") : "없음"}\n`);
  if (linked) {
    process.stdout.write(`대기:     ${store.countPendingIngest(linked.link.repoId)}건\n`);
  }
  return 0;
}

/**
 * 훅이 부른다. **절대 실패로 종료하지 않는다** — 지식 기록이 커밋이나
 * 푸시를 막는 건 본말전도다.
 */
function enqueue(argv: string[], store: Store): number {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { kind: { type: "string" }, ref: { type: "string" } },
      allowPositionals: false,
    });

    const cwd = process.cwd();
    const linked = findLink(cwd);
    if (!linked) return 0;

    const kind = values.kind ?? "commit";

    if (kind === "push" && values.ref === undefined) {
      // 푸시는 그물이다. post-commit 이 놓친 것들(훅 설치 전 커밋, 리베이스,
      // 체리픽으로 생긴 커밋)을 여기서 주워담는다. 이미 큐에 있는 건
      // ref 유니크 제약이 알아서 무시한다.
      seedFromHistory(store, {
        repoId: linked.link.repoId,
        repoPath: cwd,
        limit: PUSH_SWEEP_LIMIT,
      });
      return 0;
    }

    const ref = values.ref ?? headCommit(cwd);
    if (!ref) return 0;

    store.enqueueIngest({ repoId: linked.link.repoId, repoPath: cwd, kind, ref });
    nudge(store, linked.link.repoId, ref);
  } catch (error) {
    // 조용히 삼킨다 — 커밋을 막지 않는 게 우선이다.
    // 다만 이 침묵은 진짜 버그도 가린다. 훅이 안 먹는 것 같으면 이걸 켜라.
    if (process.env["KNEST_DEBUG"]) {
      process.stderr.write(`hook enqueue 실패: ${error instanceof Error ? error.message : error}\n`);
    }
  }
  return 0;
}

/**
 * 커밋 직후에 뜨는 한 줄. **이 시스템에서 유일하게 보장된 접점이다.**
 *
 * MCP 툴 리마인더든 AGENTS.md 지침이든, 에이전트가 "부르기로 선택"해야
 * 뜬다 — 안 부르면 영영 안 뜬다. 반면 커밋은 반드시 한다. 그리고 훅이
 * 출력한 건 git 이 자기 stderr 로 흘려보내서 `git commit` 을 실행한 쪽의
 * 화면(에이전트라면 그 컨텍스트)에 들어간다. 선택의 여지가 없는 자리다.
 *
 * 하네스 훅(Claude Code settings.json 등)이 더 강력하지만 도구마다 제각각
 * 이라 이식성이 없다 — MCP 가 툴은 표준화했어도 세션 생명주기 훅은
 * 표준이 없다. git 은 모든 에이전트가 공통으로 쓰는 유일한 표준이라,
 * 도구 중립적으로 보장을 얻을 수 있는 자리가 여기뿐이다.
 *
 * 그리고 지금이 기록하기 가장 좋은 순간이기도 하다 — 방금 한 작업의
 * 맥락이 아직 살아있다. backfill 은 나중에 diff 만 보고 복원하는 거라
 * 늘 이보다 못하다.
 *
 * **LLM 은 부르지 않는다.** 로컬 카운트 한 번이라 커밋이 느려지지 않는다.
 * 훅에서 LLM 을 부르면 커밋이 느려지고, 느려지면 --no-verify 로 꺼버린다
 * (brief.md 2장). 큐에 넣는 것마저 안 되는 것보다는 안내만 하는 게 낫다.
 */
function nudge(store: Store, repoId: string, ref: string): void {
  if (process.env["KNEST_QUIET"]) return;

  const pending = store.countPendingIngest(repoId);
  const short = ref.slice(0, 7);

  process.stdout.write(
    `\n[knest] 이번 작업에서 알게 된 게 있으면 지금 남겨라 — 나중에 diff 만 보고 복원하는 것보다 낫다.\n` +
      `        knest wiki add "제목" --source ${short}      (정리된 지식)\n` +
      `        knest wiki raw "메모"                        (다듬지 않은 원본)\n` +
      (pending > 1 ? `        소화 안 된 커밋 ${pending}건 — knest backfill\n` : "") +
      `        (이 안내를 끄려면 KNEST_QUIET=1)\n\n`,
  );
}

// ---- backfill ----

export function backfillCommand(argv: string[], store: Store, repoId: string): number {
  const [sub, ...rest] = argv;
  if (sub === "seed") return seed(rest, store, repoId);
  if (sub === "done") return done(rest, store);
  if (sub === "help") {
    process.stdout.write(BACKFILL_HELP);
    return 0;
  }
  return showMaterial(argv, store, repoId);
}

function showMaterial(argv: string[], store: Store, repoId: string): number {
  const { values } = parseArgs({
    args: argv,
    options: { limit: { type: "string" }, all: { type: "boolean" } },
    allowPositionals: false,
  });

  // 기본값(3개씩)은 "평소 작업 중에 조금씩" 시나리오를 위한 것이다.
  // --all 은 다른 시나리오다 — 이 솔루션을 기존 레포에 처음 붙일 때
  // 쌓여있는 이력을 한 세션에 몰아서 처리하는 것. 그럴 땐 3개씩 CLI를
  // 반복 호출하는 게 아니라 한 번에 전부 텍스트로 받아서, 에이전트가
  // 그 세션 안에서 필요한 만큼 wiki add/raw 를 부르는 게 맞다.
  const limit = values.all
    ? store.countPendingIngest(repoId)
    : values.limit
      ? Number(values.limit)
      : 3;

  const items = collectBackfill(store, {
    repoId,
    limit,
  });

  if (items.length === 0) {
    process.stdout.write("소화할 커밋이 없다.\n");
    process.stdout.write("과거 이력을 채우려면: knest backfill seed\n");
    return 0;
  }

  const remaining = store.countPendingIngest(repoId);
  process.stdout.write(`대기 ${remaining}건 중 ${items.length}건\n\n`);
  for (const item of items) {
    process.stdout.write(`=== 큐 ${item.queueId} ===\n${formatMaterial(item)}\n\n`);
  }
  process.stdout.write(
    "읽고 기록한 뒤: knest backfill done " + items.map((i) => i.queueId).join(" ") + "\n",
  );
  return 0;
}

function seed(argv: string[], store: Store, repoId: string): number {
  const { values } = parseArgs({
    args: argv,
    options: { limit: { type: "string" }, since: { type: "string" } },
    allowPositionals: false,
  });

  const cwd = process.cwd();
  if (!isGitRepo(cwd)) {
    process.stderr.write("git 레포가 아니다.\n");
    return 1;
  }

  const n = seedFromHistory(store, {
    repoId,
    repoPath: cwd,
    since: values.since,
    limit: values.limit ? Number(values.limit) : 50,
  });
  process.stdout.write(`커밋 ${n}건을 큐에 넣었다. 대기 ${store.countPendingIngest(repoId)}건\n`);
  return 0;
}

function done(argv: string[], store: Store): number {
  const ids = argv.map((a) => Number(a)).filter((n) => Number.isInteger(n));
  if (ids.length === 0) {
    process.stderr.write("큐 id 를 지정해라: knest backfill done 1 2 3\n");
    return 1;
  }
  for (const id of ids) store.markIngested(id);
  process.stdout.write(`${ids.length}건 완료 표시.\n`);
  return 0;
}
