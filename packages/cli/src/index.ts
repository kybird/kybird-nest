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

const HELP = `knest — kybird-nest 명령줄 도구

계정
  knest register [--server URL]   새 계정을 만들고 로그인한다
  knest login    [--server URL]   로그인한다
  knest logout                    토큰을 지운다 (로컬 스토어도 비운다)
  knest whoami                    현재 로그인 상태

레포
  knest link [--name 이름]        현재 디렉토리를 레포에 연결한다
  knest sync                      서버와 맞춘다
  knest status                    아직 못 올린 변경과 충돌을 보여준다

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
    default:
      process.stderr.write(`알 수 없는 명령: ${command}\n\n${HELP}`);
      return 1;
  }
}

// ---- 계정 ----

async function authenticate(mode: "register" | "login", argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { server: { type: "string" }, email: { type: "string" } },
    allowPositionals: false,
  });

  const config = loadConfig();
  const serverUrl = values.server ?? config.serverUrl;

  const email = values.email ?? (await ask("이메일: "));
  // 비대화형(스크립트·CI)에서는 환경변수로 넘긴다. 평소에는 물어본다.
  const password = process.env["KNEST_PASSWORD"] ?? (await askSecret("비밀번호: "));

  const result = await (mode === "register"
    ? register(serverUrl, email, password)
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
    process.stdout.write(`이미 연결돼 있다: ${existing.link.repoId}\n  ${existing.path}\n`);
    return 0;
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
    const code = await wikiCommand(argv, { store, repoId });
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
          "다른 머신에서 만든 레포라면 knest sync 를 먼저 하면 된다.\n",
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
