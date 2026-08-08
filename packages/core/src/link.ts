import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * 작업 디렉토리와 서버의 레포 레코드를 잇는 고리.
 *
 * seed 문서에서는 git remote URL 로 레포를 식별하는 안이 있었는데,
 * "git 프로젝트가 아닐 수도 있다"가 확정되면서 성립하지 않는다.
 * 대신 `.kybird/repo.json` 에 레포 id 를 명시적으로 적는다.
 *
 * 토큰과 달리 비밀이 아니므로 커밋해도 된다 — 오히려 커밋해두면 같은 레포를
 * 다른 머신에서 클론했을 때 바로 이어진다.
 */

export const LINK_DIR = ".kybird";
export const LINK_FILE = "repo.json";

export type RepoLink = { repoId: string };

export function linkPath(dir: string): string {
  return join(resolve(dir), LINK_DIR, LINK_FILE);
}

/** 현재 디렉토리에서 위로 올라가며 `.kybird/repo.json` 을 찾는다. */
export function findLink(startDir: string): { path: string; link: RepoLink } | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = linkPath(dir);
    if (existsSync(candidate)) {
      const link = JSON.parse(readFileSync(candidate, "utf8")) as RepoLink;
      if (typeof link.repoId === "string" && link.repoId.length > 0) {
        return { path: candidate, link };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function writeLink(dir: string, link: RepoLink): string {
  const path = linkPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(link, null, 2) + "\n", "utf8");
  return path;
}

/** git 레포면 origin 주소를 알아낸다. 아니면 null — 그래도 정상이다. */
export function detectGitRemote(dir: string): string | null {
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
