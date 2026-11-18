-- AlterTable
ALTER TABLE "Carrier" ADD COLUMN "handoffAt" DATETIME;
ALTER TABLE "Carrier" ADD COLUMN "handoffStatus" TEXT;
ALTER TABLE "Carrier" ADD COLUMN "soldById" TEXT;

-- AlterTable
ALTER TABLE "TeamMember" ADD COLUMN "areas" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Team" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "leaderboardEnabled" BOOLEAN NOT NULL DEFAULT true,
    "managersSeeAll" BOOLEAN NOT NULL DEFAULT true,
    "membersSeeAll" BOOLEAN NOT NULL DEFAULT false,
    "handoffMode" TEXT NOT NULL DEFAULT 'manager',
    "roundRobinLastId" TEXT,
    "keepWorkOnLeave" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Team_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Team" ("createdAt", "id", "leaderboardEnabled", "managersSeeAll", "name", "ownerId", "updatedAt") SELECT "createdAt", "id", "leaderboardEnabled", "managersSeeAll", "name", "ownerId", "updatedAt" FROM "Team";
DROP TABLE "Team";
ALTER TABLE "new_Team" RENAME TO "Team";
CREATE INDEX "Team_ownerId_idx" ON "Team"("ownerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Carrier_handoffStatus_idx" ON "Carrier"("handoffStatus");

