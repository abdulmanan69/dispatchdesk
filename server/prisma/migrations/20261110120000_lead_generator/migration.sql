-- CreateTable
CREATE TABLE "LeadGenerator" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "criteria" TEXT NOT NULL,
    "batchSize" INTEGER NOT NULL DEFAULT 25,
    "stageKey" TEXT NOT NULL DEFAULT 'lead',
    "listId" TEXT,
    "minScore" INTEGER NOT NULL DEFAULT 0,
    "autoRun" BOOLEAN NOT NULL DEFAULT false,
    "frequency" TEXT NOT NULL DEFAULT 'daily',
    "nextRunAt" DATETIME,
    "lastRunAt" DATETIME,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LeadGenerator_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LeadGenRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "generatorId" TEXT,
    "ownerId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'ok',
    "scanned" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "belowScore" INTEGER NOT NULL DEFAULT 0,
    "carrierIds" TEXT NOT NULL DEFAULT '[]',
    "message" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeadGenRun_generatorId_fkey" FOREIGN KEY ("generatorId") REFERENCES "LeadGenerator" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "LeadGenRun_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Plan" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "basePriceCents" INTEGER NOT NULL DEFAULT 0,
    "interval" TEXT NOT NULL DEFAULT 'month',
    "perSeat" BOOLEAN NOT NULL DEFAULT false,
    "minSeats" INTEGER NOT NULL DEFAULT 1,
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "stripePriceId" TEXT,
    "stripeBasePriceId" TEXT,
    "maxCarriers" INTEGER NOT NULL DEFAULT 500,
    "dailyEmailLimit" INTEGER NOT NULL DEFAULT 20,
    "monthlyAiMessages" INTEGER NOT NULL DEFAULT 30,
    "maxSequences" INTEGER NOT NULL DEFAULT 1,
    "maxAutomations" INTEGER NOT NULL DEFAULT 0,
    "maxDiscoveryPerDay" INTEGER NOT NULL DEFAULT 100,
    "monthlyLeadGenLimit" INTEGER NOT NULL DEFAULT 50,
    "maxLeadGenerators" INTEGER NOT NULL DEFAULT 1,
    "leadGenAutoRun" BOOLEAN NOT NULL DEFAULT false,
    "advancedReports" BOOLEAN NOT NULL DEFAULT false,
    "trainingIncluded" BOOLEAN NOT NULL DEFAULT false,
    "teamFeatures" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Plan" ("active", "advancedReports", "basePriceCents", "createdAt", "dailyEmailLimit", "description", "id", "interval", "key", "maxAutomations", "maxCarriers", "maxDiscoveryPerDay", "maxSequences", "minSeats", "monthlyAiMessages", "name", "perSeat", "priceCents", "sortOrder", "stripeBasePriceId", "stripePriceId", "teamFeatures", "trainingIncluded", "trialDays", "updatedAt") SELECT "active", "advancedReports", "basePriceCents", "createdAt", "dailyEmailLimit", "description", "id", "interval", "key", "maxAutomations", "maxCarriers", "maxDiscoveryPerDay", "maxSequences", "minSeats", "monthlyAiMessages", "name", "perSeat", "priceCents", "sortOrder", "stripeBasePriceId", "stripePriceId", "teamFeatures", "trainingIncluded", "trialDays", "updatedAt" FROM "Plan";
DROP TABLE "Plan";
ALTER TABLE "new_Plan" RENAME TO "Plan";
CREATE UNIQUE INDEX "Plan_key_key" ON "Plan"("key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "LeadGenerator_ownerId_idx" ON "LeadGenerator"("ownerId");

-- CreateIndex
CREATE INDEX "LeadGenerator_autoRun_nextRunAt_idx" ON "LeadGenerator"("autoRun", "nextRunAt");

-- CreateIndex
CREATE INDEX "LeadGenRun_ownerId_createdAt_idx" ON "LeadGenRun"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadGenRun_generatorId_createdAt_idx" ON "LeadGenRun"("generatorId", "createdAt");


-- Lead generator entitlements for the default paid plans (admins can change these in Admin → Plans).
UPDATE "Plan" SET "monthlyLeadGenLimit" = 2000, "maxLeadGenerators" = 10, "leadGenAutoRun" = true WHERE "key" IN ('pro', 'annual');
UPDATE "Plan" SET "monthlyLeadGenLimit" = 5000, "maxLeadGenerators" = 25, "leadGenAutoRun" = true WHERE "key" = 'teams';
