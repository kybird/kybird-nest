-- AlterTable
ALTER TABLE "Card" ADD COLUMN "rejectedAt" DATETIME;
ALTER TABLE "Card" ADD COLUMN "rejectedBy" TEXT;
ALTER TABLE "Card" ADD COLUMN "rejectedReason" TEXT;
