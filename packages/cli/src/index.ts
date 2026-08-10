#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  ApiError,
  OfflineError,
  Store,
  board,
  createCard,
  createRepo,
  deleteCard,
  detectGitRemote,
  editCard,
  findLink,
  formatReport,
  inviteRepo,
  joinRepo,
  loadConfig,
  login,
  moveCard,
  register,
  requireToken,
  saveConfig,
  storePath,
  sync,
  writeLink,
  type Config,
} from "@kybird/core";
import { changeSetSize } from "@kybird/shared";
import { ask, askSecret } from "./prompt.js";
import { wikiCommand, WIKI_HELP } from "./wiki-commands.js";
import { backfillCommand, hookCommand, BACKFILL_HELP, HOOK_HELP } from "./hook-commands.js";
import { runMcp } from "./mcp.js";

const HELP = `knest — kybird-nest 명령줄 도구

계정
  knest register [--server URL] [--invite 코드]
                                  새 계정을 만들고 로그인한다
  knest login    [--server URL]   로그인한다
  knest logout                    토큰을 지운다 (로컬 스토어도 비운다)
  knest whoami                    현재 로그인 상태

레포
  knest link [--name 이름]        현재 디렉토리를 레포에 연결한다
  knest sync                      서버와 맞춘다
  knest status                    아직 못 올린 변경과 충돌을 보여준다
  knest repo invite               참여 코드를 발급한다 (합류시킬 사람에게 전달)
  knest repo join <코드> [--repo repoId]  참여 코드로 레포에 합류한다
                                  (.kybird/repo.json 이 있으면 repoId 는 자동)

에이전트
  knest mcp                       MCP 서버로 붙는다 (에이전트가 실행)
  knest hook install              git 훅을 심는다 (커밋을 큐에 넣는다)
  knest backfill                  밀린 커밋의 재료를 꺼낸다

wiki
  knest wiki add <제목>           지식을 넣는다 (본문은 표준입력)
  knest wiki search <질의>        하이브리드 검색
  knest wiki embed                벡터를 만든다
  knest wiki index                색인을 뽑는다
  knest wiki help                 자세히

칸반
  knest board                     현재 레포의 보드
  knest add <제목> [--column 컬럼]
  knest mv <카드> <컬럼> [위치]
  knest edit <카드> <새 제목>
  knest rm <카드>
  knest conflicts [--clear]       동기화에서 밀려난 로컬 값들

카드와 컬럼은 id 앞부분만 써도 되고, 컬럼은 이름으로도 지정할 수 있다.

환경변수
  KYBIRD_HOME       설정과 로컬 스토어 위치 (기본 ~/.kybird)
  KNEST_PASSWORD    비대화형 로그인용 비밀번호
  KNEST_INVITE_CODE 가입 초대 코드 (--invite 대신)
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  switch (command) {
    case "register":
    case "login":
      return authenticate(command, rest);
    case "logout":
      return logout();
    case "whoami":
      return whoami();
    case "link":
      return link(rest);
    case "repo":
      return repoTopLevel(rest);
    case "sync":
      return runSync();
    case "status":
      return status();
    case "board":
      return showBoard();
    case "add":
      return addCard(rest);
    case "mv":
      return moveCommand(rest);
    case "edit":
      return editCommand(rest);
    case "rm":
      return removeCommand(rest);
    case "conflicts":
      return conflicts(rest);
    case "wiki":
      return wikiTopLevel(rest);
    case "mcp":
      return mcpTopLevel();
    case "hook":
      return hookTopLevel(rest);
    case "backfill":
      return backfillTopLevel(rest);
    default:
      process.stderr.write(`알 수 없는 명령: ${command}\n\n${HELP}`);
      return 1;
  }
}

// ---- 계정 ----

async function authenticate(mode: "register" | "login", argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      server: { type: "string" },
      email: { type: "string" },
      invite: { type: "string" },
    },
    allowPositionals: false,
  });

  const config = loadConfig();
  const serverUrl = values.server ?? config.serverUrl;

  const email = values.email ?? (await ask("이메일: "));
  // 비대화형(스크립트·CI)에서는 환경변수로 넘긴다. 평소에는 물어본다.
  const password = process.env["KNEST_PASSWORD"] ?? (await askSecret("비밀번호: "));

  // 공개 서버는 초대 코드가 있어야 가입된다. 로그인에는 필요 없다.
  const invite = values.invite ?? process.env["KNEST_INVITE_CODE"];
  const result = await (mode === "register"
    ? register(serverUrl, email, password, invite)
    : login(serverUrl, email, password));

  const next: Config = { serverUrl, token: result.token, email: result.user.email };

  // 계정이 바뀌면 남의 데이터가 섞이지 않게 스토어를 비운다.
  if (config.email && config.email !== result.user.email) {
    const store = openStore();
    store.reset();
    store.close();
    process.stdout.write("다른 계정이라 로컬 스토어를 비웠다.\n");
  }

  saveConfig(next);
  process.stdout.write(`${result.user.email} 로 로그인됐다.\n`);
  return 0;
}

function logout(): number {
  const config = loadConfig();
  saveConfig({ serverUrl: config.serverUrl });
  const store = openStore();
  store.reset();
  store.close();
  process.stdout.write("로그아웃했다. 로컬 스토어도 비웠다.\n");
  return 0;
}

function whoami(): number {
  const config = loadConfig();
  if (!config.token) {
    process.stdout.write("로그인 상태가 아니다. knest login\n");
    return 1;
  }
  process.stdout.write(`${config.email ?? "(이메일 미상)"} @ ${config.serverUrl}\n`);
  return 0;
}

// ---- 레포 ----

async function link(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { name: { type: "string" } },
    allowPositionals: false,
  });

  const cwd = process.cwd();
  const existing = findLink(cwd);
  if (existing) {
    const store = openStore();
    try {
      if (store.getRepo(existing.link.repoId)) {
        process.stdout.write(`이미 연결돼 있다: ${existing.link.repoId}\n  ${existing.path}\n`);
        return 0;
      }
      // .kybird/repo.json 은 있는데 로컬 스토어엔 그 레포가 없다 — 다른
      // 머신에서 만든 내 레포이거나, 다른 사람이 만들어서 아직 합류 전인
      // 레포다. 클라이언트만으로는 어느 쪽인지 구분할 수 없으니 둘 다 안내한다.
      process.stdout.write(
        `"${existing.link.repoId}" 레포에 연결은 돼 있지만 로컬엔 아직 없다.\n` +
          "이 레포에 처음 합류하는 거라면: knest repo join <초대 코드>\n" +
          "다른 머신에서 만든 내 레포라면: knest sync\n",
      );
      return 1;
    } finally {
      store.close();
    }
  }

  const store = openStore();
  try {
    const name = values.name ?? basename(cwd);
    const repo = createRepo(store, { name, path: cwd, gitRemote: detectGitRemote(cwd) });
    const path = writeLink(cwd, { repoId: repo.id });
    process.stdout.write(`"${name}" 레포를 만들고 연결했다.\n  ${path}\n`);

    // 바로 올려둔다. 실패해도 로컬에는 남으므로 다음 sync 에 따라간다.
    await trySync(store);
    return 0;
  } finally {
    store.close();
  }
}

const REPO_HELP = `knest repo — 레포 참여 관리

  knest repo invite               현재 레포의 참여 코드를 발급한다
  knest repo join <코드> [--repo repoId]  참여 코드로 레포에 합류한다
                                  (.kybird/repo.json 이 있으면 repoId 는 자동)

clone 만으로는 자동 합류가 안 된다 — .kybird/repo.json 의 repoId 는 git 에
커밋되므로, 공개 레포라면 그 값 자체는 이미 공개돼 있다. 참여 코드는
합류시킬 사람에게 채팅 등으로 직접 전달해라.
`;

async function repoTopLevel(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "help") {
    process.stdout.write(REPO_HELP);
    return 0;
  }
  switch (sub) {
    case "invite":
      return repoInvite();
    case "join":
      return repoJoin(rest);
    default:
      process.stderr.write(`알 수 없는 하위 명령: ${sub}\n\n${REPO_HELP}`);
      return 1;
  }
}

/** 현재 연결된 레포의 참여 코드를 발급한다. 역할 구분이 없어 멤버라면 누구나 할 수 있다. */
async function repoInvite(): Promise<number> {
  return withRepo(async (_store, repoId) => {
    const config = loadConfig();
    try {
      const result = await inviteRepo(config.serverUrl, requireToken(config), repoId);
      process.stdout.write(
        `참여 코드: ${result.code}\n` +
          "이 코드는 지금 한 번만 보여준다 — 합류시킬 사람에게 직접 전달해라.\n" +
          `합류 (git clone 받은 뒤): knest repo join ${result.code}\n` +
          `합류 (아직 clone 전이면): knest repo join ${result.code} --repo ${repoId}\n`,
      );
      return 0;
    } catch (error) {
      process.stderr.write(`초대 코드 발급 실패: ${(error as Error).message}\n`);
      return 1;
    }
  });
}

/**
 * 참여 코드로 레포에 합류한다. `withRepo` 를 안 쓰는 이유는 정의상 이
 * 레포가 아직 로컬 스토어에 없는 상태이기 때문이다 — 그게 join 이 하는 일이다.
 */
async function repoJoin(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { repo: { type: "string" } },
    allowPositionals: true,
  });
  const code = positionals[0];
  if (!code) {
    process.stderr.write("사용법: knest repo join <초대 코드> [--repo <repoId>]\n");
    return 1;
  }

  // git clone 으로 받았으면 .kybird/repo.json 에 repoId 가 이미 있다 —
  // 굳이 또 타이핑 안 해도 된다. 그 파일이 없는 경우(레포를 아직 로컬에
  // 안 받은 채로 코드만 먼저 받은 경우)에만 --repo 로 명시한다.
  const linked = findLink(process.cwd());
  const repoId = values.repo ?? linked?.link.repoId;
  if (!repoId) {
    process.stderr.write(
      "repoId 를 모른다 — 이 디렉토리에 .kybird/repo.json 이 없다.\n" +
        "git clone 으로 받은 레포면 그 파일이 있을 텐데 없다면, 초대한 사람에게 repoId 를 받아서\n" +
        "knest repo join <코드> --repo <repoId> 로 실행해라.\n",
    );
    return 1;
  }

  const config = loadConfig();
  const store = openStore();
  try {
    const result = await joinRepo(config.serverUrl, requireToken(config), repoId, code);
    store.applyRemote("repos", result.repo);

    // .kybird/repo.json 이 이미 있으면(git clone 으로 받은 것) 그대로 둔다.
    // 없으면(레포를 만들지 않고 join 부터 한 경우) 새로 만든다.
    if (!linked) {
      writeLink(process.cwd(), { repoId: result.repo.id });
    }

    process.stdout.write(`"${result.repo.name}" 레포에 합류했다. knest sync 로 나머지를 받아라.\n`);
    await trySync(store);
    return 0;
  } catch (error) {
    process.stderr.write(`합류 실패: ${(error as Error).message}\n`);
    return 1;
  } finally {
    store.close();
  }
}

async function runSync(): Promise<number> {
  const store = openStore();
  try {
    const config = loadConfig();
    const report = await sync(store, { serverUrl: config.serverUrl, token: requireToken(config) });
    process.stdout.write(formatReport(report) + "\n");
    if (report.conflicts.length > 0) {
      process.stdout.write(`충돌 ${report.conflicts.length}건은 knest conflicts 로 볼 수 있다.\n`);
    }
    if (report.deferred.length > 0) {
      process.stdout.write(`${report.deferred.length}건은 부모가 아직 없어 다음 동기화로 미뤘다.\n`);
    }
    return 0;
  } finally {
    store.close();
  }
}

function status(): number {
  const store = openStore();
  try {
    const total = changeSetSize(store.pending());
    const conflicts = store.listConflicts();
    const linked = findLink(process.cwd());

    process.stdout.write(`스토어: ${storePath()}\n`);
    process.stdout.write(`커서:   ${store.cursor}\n`);
    process.stdout.write(`연결:   ${linked ? linked.link.repoId : "(연결 안 됨 — knest link)"}\n`);
    process.stdout.write(`대기:   ${total}건\n`);
    process.stdout.write(`충돌:   ${conflicts.length}건\n`);
    return 0;
  } finally {
    store.close();
  }
}

// ---- 칸반 ----

function showBoard(): Promise<number> {
  return withRepo((store, repoId) => {
    const view = board(store, repoId);
    process.stdout.write(`\n  ${view.repo.name}\n`);
    for (const { column, cards } of view.columns) {
      process.stdout.write(`\n  ${column.title}  (${cards.length})\n`);
      if (cards.length === 0) {
        process.stdout.write("    —\n");
        continue;
      }
      for (const card of cards) {
        process.stdout.write(`    ${short(card.id)}  ${card.title}\n`);
      }
    }
    process.stdout.write("\n");
    return 0;
  });
}

async function addCard(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { column: { type: "string" } },
    allowPositionals: true,
  });
  const title = positionals.join(" ").trim();
  if (!title) {
    process.stderr.write("제목이 필요하다: knest add <제목>\n");
    return 1;
  }

  return withRepo(async (store, repoId) => {
    const columns = store.listColumns(repoId);
    const column = values.column ? findColumn(columns, values.column) : columns[0];
    if (!column) {
      process.stderr.write(`컬럼을 찾을 수 없다: ${values.column}\n`);
      return 1;
    }
    const card = createCard(store, { repoId, columnId: column.id, title });
    process.stdout.write(`${short(card.id)}  ${card.title}  →  ${column.title}\n`);
    await trySync(store);
    return 0;
  });
}

async function moveCommand(argv: string[]): Promise<number> {
  const [cardRef, columnRef, positionRef] = argv;
  if (!cardRef || !columnRef) {
    process.stderr.write("사용법: knest mv <카드> <컬럼> [위치]\n");
    return 1;
  }

  return withRepo(async (store, repoId) => {
    const card = findCard(store, repoId, cardRef);
    if (!card) return 1;
    const column = findColumn(store.listColumns(repoId), columnRef);
    if (!column) {
      process.stderr.write(`컬럼을 찾을 수 없다: ${columnRef}\n`);
      return 1;
    }
    const position = positionRef === undefined ? undefined : Number(positionRef);
    if (position !== undefined && !Number.isInteger(position)) {
      process.stderr.write(`위치는 정수여야 한다: ${positionRef}\n`);
      return 1;
    }
    moveCard(store, card.id, column.id, position);
    process.stdout.write(`${short(card.id)}  ${card.title}  →  ${column.title}\n`);
    await trySync(store);
    return 0;
  });
}

async function editCommand(argv: string[]): Promise<number> {
  const [cardRef, ...titleParts] = argv;
  const title = titleParts.join(" ").trim();
  if (!cardRef || !title) {
    process.stderr.write("사용법: knest edit <카드> <새 제목>\n");
    return 1;
  }
  return withRepo(async (store, repoId) => {
    const card = findCard(store, repoId, cardRef);
    if (!card) return 1;
    const updated = editCard(store, card.id, { title });
    process.stdout.write(`${short(updated.id)}  ${updated.title}\n`);
    await trySync(store);
    return 0;
  });
}

async function removeCommand(argv: string[]): Promise<number> {
  const [cardRef] = argv;
  if (!cardRef) {
    process.stderr.write("사용법: knest rm <카드>\n");
    return 1;
  }
  return withRepo(async (store, repoId) => {
    const card = findCard(store, repoId, cardRef);
    if (!card) return 1;
    deleteCard(store, card.id);
    process.stdout.write(`지웠다: ${card.title}\n`);
    await trySync(store);
    return 0;
  });
}

function conflicts(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { clear: { type: "boolean" } },
    allowPositionals: false,
  });
  const store = openStore();
  try {
    if (values.clear) {
      store.clearConflicts();
      process.stdout.write("충돌 기록을 비웠다.\n");
      return 0;
    }
    const records = store.listConflicts();
    if (records.length === 0) {
      process.stdout.write("충돌 없음.\n");
      return 0;
    }
    for (const record of records) {
      const payload = JSON.parse(record.payload) as { title?: string; name?: string };
      const label = payload.title ?? payload.name ?? record.entityId;
      const when = new Date(record.createdAt).toLocaleString();
      process.stdout.write(`${when}  [${record.reason}] ${record.kind} ${short(record.entityId)}\n`);
      process.stdout.write(`  밀려난 로컬 값: ${label}\n`);
    }
    process.stdout.write("\n비우려면: knest conflicts --clear\n");
    return 0;
  } finally {
    store.close();
  }
}

// ---- wiki ----

/**
 * wiki 명령은 전부 레포 맥락이 필요하고, 끝나면 조용히 동기화한다.
 * 읽기 전용 명령까지 동기화하는 게 낭비 같지만, 검색은 로그를 남기므로
 * 실은 쓰기다 — 그 로그가 평가 정답셋의 씨앗이라 흘리면 안 된다.
 */
async function wikiTopLevel(argv: string[]): Promise<number> {
  if (argv[0] === undefined || argv[0] === "help") {
    process.stdout.write(WIKI_HELP);
    return 0;
  }
  return withRepo(async (store, repoId) => {
    const config = loadConfig();
    const code = await wikiCommand(argv, {
      store,
      repoId,
      repoPath: process.cwd(),
      author: config.email ?? "anonymous",
    });
    await trySync(store);
    return code;
  });
}

// ---- 에이전트 표면 ----

/**
 * MCP 서버. 에이전트가 이걸 자식 프로세스로 띄우고 stdio 로 말한다.
 * 그래서 여기서는 **stdout 에 아무것도 쓰면 안 된다** — 프로토콜이 쓴다.
 */
async function mcpTopLevel(): Promise<number> {
  const linked = findLink(process.cwd());
  if (!linked) {
    process.stderr.write("이 디렉토리는 레포에 연결돼 있지 않다. knest link\n");
    return 1;
  }
  const store = openStore();
  if (!store.getRepo(linked.link.repoId)) {
    process.stderr.write("연결된 레포가 로컬에 없다. knest sync 를 먼저 해라.\n");
    store.close();
    return 1;
  }
  await runMcp({ store, repoId: linked.link.repoId, repoPath: process.cwd() });
  return 0;
}

/**
 * 훅 명령은 레포 연결을 요구하지 않는다 —  는 훅이 부르는데,
 * 연결이 안 돼 있으면 조용히 아무것도 안 하고 끝나야 하기 때문이다.
 */
function hookTopLevel(argv: string[]): number {
  if (argv[0] === undefined || argv[0] === "help") {
    process.stdout.write(HOOK_HELP);
    return 0;
  }
  const store = openStore();
  try {
    return hookCommand(argv, store);
  } finally {
    store.close();
  }
}

async function backfillTopLevel(argv: string[]): Promise<number> {
  if (argv[0] === "help") {
    process.stdout.write(BACKFILL_HELP);
    return 0;
  }
  return withRepo(async (store, repoId) => {
    const code = backfillCommand(argv, store, repoId);
    await trySync(store);
    return code;
  });
}

// ---- 거들기 ----

function openStore(): Store {
  return new Store(storePath());
}

/** 현재 디렉토리에 연결된 레포를 열어 콜백에 넘긴다. */
async function withRepo(
  fn: (store: Store, repoId: string) => number | Promise<number>,
): Promise<number> {
  const linked = findLink(process.cwd());
  if (!linked) {
    process.stderr.write("이 디렉토리는 레포에 연결돼 있지 않다. knest link\n");
    return 1;
  }
  const store = openStore();
  try {
    if (!store.getRepo(linked.link.repoId)) {
      process.stderr.write(
        `연결된 레포가 로컬에 없다: ${linked.link.repoId}\n` +
          "다른 머신에서 만든 내 레포라면 knest sync 를 먼저 하면 된다.\n" +
          "아직 합류 전인 레포라면 knest repo join <초대 코드>\n",
      );
      return 1;
    }
    return await fn(store, linked.link.repoId);
  } finally {
    store.close();
  }
}

/**
 * 조용히 동기화한다. 서버가 없으면 그냥 넘어간다 — 오프라인 우선이라
 * 로컬 작업이 서버 사정으로 실패하면 안 된다.
 */
async function trySync(store: Store): Promise<void> {
  const config = loadConfig();
  if (!config.token) return;
  try {
    await sync(store, { serverUrl: config.serverUrl, token: config.token });
  } catch (error) {
    if (error instanceof OfflineError) {
      process.stdout.write("(서버에 못 닿아서 로컬에만 저장했다. 나중에 knest sync)\n");
      return;
    }
    throw error;
  }
}

function findCard(store: Store, repoId: string, ref: string) {
  const matches = store.listCardsByRepo(repoId).filter((c) => c.id.startsWith(ref));
  if (matches.length === 0) {
    process.stderr.write(`카드를 찾을 수 없다: ${ref}\n`);
    return null;
  }
  if (matches.length > 1) {
    process.stderr.write(`"${ref}" 로 시작하는 카드가 ${matches.length}개다. 더 길게 써라.\n`);
    return null;
  }
  return matches[0]!;
}

function findColumn<T extends { id: string; title: string }>(columns: T[], ref: string): T | null {
  return (
    columns.find((c) => c.title === ref) ??
    columns.find((c) => c.id.startsWith(ref)) ??
    columns.find((c) => c.title.toLowerCase().startsWith(ref.toLowerCase())) ??
    null
  );
}

function short(id: string): string {
  return id.slice(0, 7);
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "repo";
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof OfflineError) {
      process.stderr.write(`${error.message}\n서버가 떠 있는지 확인해라.\n`);
    } else if (error instanceof ApiError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  });
