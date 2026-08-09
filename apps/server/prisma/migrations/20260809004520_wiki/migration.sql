-- CreateTable
CREATE TABLE "WikiEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "repoId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "sourceRef" TEXT,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "seq" INTEGER NOT NULL,
    CONSTRAINT "WikiEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WikiEntry_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Embedding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dim" INTEGER NOT NULL,
    "vector" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "seq" INTEGER NOT NULL,
    CONSTRAINT "Embedding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Embedding_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "WikiEntry" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SearchLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "repoId" TEXT,
    "query" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "model" TEXT,
    "resultIds" TEXT NOT NULL DEFAULT '[]',
    "usedIds" TEXT NOT NULL DEFAULT '[]',
    "tookMs" INTEGER NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "seq" INTEGER NOT NULL,
    CONSTRAINT "SearchLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SearchLog_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "WikiEntry_userId_seq_idx" ON "WikiEntry"("userId", "seq");

-- CreateIndex
CREATE INDEX "WikiEntry_repoId_idx" ON "WikiEntry"("repoId");

-- CreateIndex
CREATE INDEX "Embedding_userId_seq_idx" ON "Embedding"("userId", "seq");

-- CreateIndex
CREATE INDEX "Embedding_entryId_idx" ON "Embedding"("entryId");

-- CreateIndex
CREATE INDEX "SearchLog_userId_seq_idx" ON "SearchLog"("userId", "seq");

-- CreateIndex
CREATE INDEX "SearchLog_repoId_idx" ON "SearchLog"("repoId");
