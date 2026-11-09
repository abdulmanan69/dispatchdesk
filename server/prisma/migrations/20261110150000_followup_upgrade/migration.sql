-- AlterTable
ALTER TABLE "LeadGenerator" ADD COLUMN "sequenceId" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FollowUp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "carrierId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dueAt" DATETIME NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'call',
    "title" TEXT,
    "note" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "recurrence" TEXT NOT NULL DEFAULT 'none',
    "remindMinutesBefore" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "outcome" TEXT,
    "snoozeCount" INTEGER NOT NULL DEFAULT 0,
    "completedAt" DATETIME,
    "notifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FollowUp_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FollowUp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_FollowUp" ("carrierId", "completedAt", "createdAt", "dueAt", "id", "note", "notifiedAt", "status", "type", "updatedAt", "userId") SELECT "carrierId", "completedAt", "createdAt", "dueAt", "id", "note", "notifiedAt", "status", "type", "updatedAt", "userId" FROM "FollowUp";
DROP TABLE "FollowUp";
ALTER TABLE "new_FollowUp" RENAME TO "FollowUp";
CREATE INDEX "FollowUp_userId_status_dueAt_idx" ON "FollowUp"("userId", "status", "dueAt");
CREATE INDEX "FollowUp_carrierId_idx" ON "FollowUp"("carrierId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

