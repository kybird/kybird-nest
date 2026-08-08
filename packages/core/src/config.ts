import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";

/**
 * 머신 단위 설정. **레포 안에 두지 않는다** — 토큰이 들어있어서
 * 레포에 있으면 언젠가 커밋된다.
 */
export type Config = {
  serverUrl: string;
  token?: string;
  email?: string;
};

export const DEFAULT_SERVER_URL = "http://localhost:3000";

export function configDir(): string {
  return process.env["KYBIRD_HOME"] ?? join(homedir(), ".kybird");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

/**
 * 로컬 스토어는 **머신에 하나**다. 레포마다 두지 않는 이유는 cross-project
 * 검색이 클라이언트에서 돌기 때문이다 — 한 유저의 모든 레포가 한자리에
 * 있어야 검색이 성립한다.
 */
export function storePath(): string {
  return join(configDir(), "store.db");
}

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) return { serverUrl: DEFAULT_SERVER_URL };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
    return { serverUrl: parsed.serverUrl ?? DEFAULT_SERVER_URL, ...parsed };
  } catch (cause) {
    throw new Error(`설정 파일을 읽을 수 없다: ${path}`, { cause });
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(configDir(), { recursive: true });
  const path = configPath();
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  // 토큰이 들어있으니 소유자만 읽게. Windows 에서는 무시되지만 해가 없다.
  try {
    chmodSync(path, 0o600);
  } catch {
    // 권한 설정 실패가 로그인을 막을 이유는 없다.
  }
}

export function requireToken(config: Config): string {
  if (!config.token) {
    throw new Error("로그인이 필요하다: knest login");
  }
  return config.token;
}
