-- CreateTable
CREATE TABLE "RepoMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RepoMember_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RepoMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RepoInvite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    CONSTRAINT "RepoInvite_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RepoMember_userId_idx" ON "RepoMember"("userId");

-- CreateIndex
CREATE INDEX "RepoMember_repoId_idx" ON "RepoMember"("repoId");

-- CreateIndex
CREATE UNIQUE INDEX "RepoMember_repoId_userId_key" ON "RepoMember"("repoId", "userId");

-- CreateIndex
CREATE INDEX "RepoInvite_repoId_idx" ON "RepoInvite"("repoId");

-- Backfill: 기존 Repo 는 전부 단일 소유자였다. 그 소유자를 RepoMember 로
-- 등록해야 다음 pull 부터도(멤버십 기반으로 바뀌었으므로) 자기 레포가
-- 계속 보인다. id 는 cuid 형식일 필요 없이 유니크하기만 하면 되므로
-- repoId 기반 결정적 문자열로 만든다.
INSERT INTO "RepoMember" ("id", "repoId", "userId", "createdAt")
SELECT 'seed_' || "id", "id", "userId", CURRENT_TIMESTAMP
FROM "Repo";
