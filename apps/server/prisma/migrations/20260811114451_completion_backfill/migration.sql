-- 백필: completion_tracking 마이그레이션이 기존 완료 카드의 completedAt 을
-- 채우지 않아서 회귀 감지가 첫 사이클에 동작하지 않는 버그를 고친다.
--
-- 회귀 감지(kanban.ts)는 completedAt != null 을 "완료 상태" 프록시로 쓴다.
-- 하지만 이전 마이그레이션(20260810131849)이 컬럼만 추가하고 기존 완료
-- 컬럼의 카드들에게는 completedAt 값을 안 줬다 — 전부 NULL 이라서,
-- 완료 → 진행중 첫 이동이 회귀로 잡히지 않았다(두 번째 사이클부터 정상).
--
-- updatedAt 은 완료 진입 시각의 근사치다. 정확한 완료 시점보다 늦을 수는
-- 있지만, NULL 때문에 회귀가 안 잡히는 것보다는 낫다. regressCount 은
-- 백필 대상이 아니다 — 0 그대로 둬야 "과거에 회귀한 적 없음"이 맞다.
UPDATE "Card"
SET "completedAt" = "updatedAt"
WHERE "columnId" IN (SELECT "id" FROM "Column" WHERE "isDone" = true)
  AND "completedAt" IS NULL
  AND "deletedAt" IS NULL;
