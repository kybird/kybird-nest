import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * git 연동 — 훅 설치와 커밋 재료 추출.
 *
 * git 은 **편의 기능이지 전제가 아니다.** 레포가 git 프로젝트가 아닐 수도
 * 있으므로 여기 있는 건 전부 "되면 좋고" 다. 명시적 호출이 정본이다.
 */

export function isGitRepo(dir: string): boolean {
  return gitOrNull(dir, ["rev-parse", "--git-dir"]) !== null;
}

function gitOrNull(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

/** `.git` 디렉토리. 워크트리나 서브모듈이면 일반 디렉토리가 아닐 수 있다. */
export function gitDir(dir: string): string | null {
  const found = gitOrNull(dir, ["rev-parse", "--absolute-git-dir"]);
  return found === null || found.length === 0 ? null : found;
}

export function headCommit(dir: string): string | null {
  return gitOrNull(dir, ["rev-parse", "HEAD"]);
}

export type CommitInfo = {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  files: string[];
  /** 통계만. 전체 diff 는 별도로 가져온다 — 큰 커밋에서 통째로 들면 감당이 안 된다. */
  stat: string;
};

// 커밋 메시지에 들어갈 일이 없는 제어문자를 구분자로 쓴다.
// 흔한 구분자(|, 탭)를 쓰면 본문에 그게 들어있을 때 파싱이 깨진다.
const FIELD = String.fromCharCode(31);
const RECORD = String.fromCharCode(30);

export function readCommit(dir: string, ref: string): CommitInfo | null {
  const format = ["%H", "%h", "%an", "%aI", "%s", "%b"].join(FIELD) + RECORD;
  const raw = gitOrNull(dir, ["show", "--no-patch", `--format=${format}`, ref]);
  if (raw === null) return null;

  const [head] = raw.split(RECORD);
  const parts = (head ?? "").split(FIELD);
  const files = (gitOrNull(dir, ["show", "--name-only", "--format=", ref]) ?? "")
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  return {
    sha: parts[0] ?? ref,
    shortSha: parts[1] ?? ref.slice(0, 7),
    author: parts[2] ?? "",
    date: parts[3] ?? "",
    subject: parts[4] ?? "",
    body: (parts[5] ?? "").trim(),
    files,
    stat: gitOrNull(dir, ["show", "--stat", "--format=", ref]) ?? "",
  };
}

/**
 * 커밋의 diff. 소화할 재료로 쓴다.
 *
 * 길이를 자르는 이유는 락파일이나 생성물이 섞인 커밋 하나가 컨텍스트를
 * 통째로 잡아먹기 때문이다. 잘렸다는 사실은 표시해서 넘긴다.
 */
export function readDiff(dir: string, ref: string, maxChars = 40_000): string {
  const diff = gitOrNull(dir, ["show", "--format=", "--patch", ref]) ?? "";
  if (diff.length <= maxChars) return diff;
  return diff.slice(0, maxChars) + `\n\n… (${diff.length - maxChars}자 잘림)`;
}

/** `since` 이후의 커밋 해시들. `since` 를 안 주면 최근 것부터 limit 개. */
export function listCommits(dir: string, options: { since?: string; limit?: number } = {}): string[] {
  const args = ["rev-list", "--no-merges"];
  if (options.limit !== undefined) args.push(`--max-count=${options.limit}`);
  args.push(options.since ? `${options.since}..HEAD` : "HEAD");
  const out = gitOrNull(dir, args);
  return out === null || out.length === 0 ? [] : out.split("\n").map((l) => l.trim());
}

// ---- 훅 ----

export const HOOKS = ["post-commit", "pre-push"] as const;
export type HookName = (typeof HOOKS)[number];

/** 우리가 심은 줄인지 알아보기 위한 표식. */
const MARKER = "# kybird-nest";

function hookBody(nodePath: string, cliPath: string, kind: string): string {
  // 큐에 넣기만 하고 즉시 끝낸다. 실패해도 exit 0 이다 —
  // 지식 기록이 커밋이나 푸시를 막는 건 본말전도다.
  return [
    "#!/bin/sh",
    MARKER,
    `"${nodePath}" "${cliPath}" hook enqueue --kind ${kind} >/dev/null 2>&1 || true`,
    "exit 0",
    "",
  ].join("\n");
}

export type HookInstallResult = { hook: HookName; path: string; status: "installed" | "skipped" };

/**
 * 훅을 심는다.
 *
 * 이미 남이 쓴 훅이 있으면 덮어쓰지 않는다 — 남의 훅을 조용히 날리는 건
 * 최악이다. 우리가 심은 것(표식이 있는 것)은 갱신한다.
 */
export function installHooks(
  repoDir: string,
  options: { nodePath?: string; cliPath: string },
): HookInstallResult[] {
  const dir = gitDir(repoDir);
  if (dir === null) throw new Error("git 레포가 아니다");

  const hooksDir = join(dir, "hooks");
  mkdirSync(hooksDir, { recursive: true });

  const nodePath = options.nodePath ?? process.execPath;
  const results: HookInstallResult[] = [];

  for (const hook of HOOKS) {
    const path = join(hooksDir, hook);
    const kind = hook === "post-commit" ? "commit" : "push";

    if (existsSync(path)) {
      const current = readFileSync(path, "utf8");
      if (!current.includes(MARKER)) {
        results.push({ hook, path, status: "skipped" });
        continue;
      }
    }

    writeFileSync(path, hookBody(nodePath, resolve(options.cliPath), kind), "utf8");
    try {
      chmodSync(path, 0o755);
    } catch {
      // Windows 에서는 실행 권한 개념이 달라 실패할 수 있다. git 이 알아서 돌린다.
    }
    results.push({ hook, path, status: "installed" });
  }

  return results;
}

export function hooksInstalled(repoDir: string): HookName[] {
  const dir = gitDir(repoDir);
  if (dir === null) return [];
  return HOOKS.filter((hook) => {
    const path = join(dir, "hooks", hook);
    return existsSync(path) && readFileSync(path, "utf8").includes(MARKER);
  });
}
