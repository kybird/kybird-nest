-- Column.isDone: 완료 컬럼 표시. 기존 "완료" 컬럼에만 true.
ALTER TABLE "Column" ADD COLUMN "isDone" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Column" SET "isDone" = true WHERE "title" = '완료' AND "deletedAt" IS NULL;

-- Card.completedAt: 마지막으로 완료 컬럼에 들어간 시각. 미완료면 null.
ALTER TABLE "Card" ADD COLUMN "completedAt" DATETIME;

-- Card.regressCount: 완료에서 빠져나간 횟수. 반복 회귀 감지.
ALTER TABLE "Card" ADD COLUMN "regressCount" INTEGER NOT NULL DEFAULT 0;
