-- AlterTable
ALTER TABLE "Load" ADD COLUMN "destLat" REAL;
ALTER TABLE "Load" ADD COLUMN "destLng" REAL;
ALTER TABLE "Load" ADD COLUMN "originLat" REAL;
ALTER TABLE "Load" ADD COLUMN "originLng" REAL;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Carrier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "assignedToId" TEXT,
    "stageId" INTEGER NOT NULL,
    "companyName" TEXT NOT NULL,
    "dbaName" TEXT,
    "dotNumber" TEXT,
    "mcNumber" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "equipment" TEXT,
    "fleetSize" INTEGER,
    "drivers" INTEGER,
    "authorityStatus" TEXT,
    "authorityDate" DATETIME,
    "operatingStatus" TEXT,
    "classification" TEXT,
    "carrierOperation" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceRef" TEXT,
    "verifiedAt" DATETIME,
    "timezone" TEXT,
    "doNotCall" BOOLEAN NOT NULL DEFAULT false,
    "doNotEmail" BOOLEAN NOT NULL DEFAULT false,
    "truckStatus" TEXT NOT NULL DEFAULT 'unknown',
    "locationCity" TEXT,
    "locationState" TEXT,
    "locationLat" REAL,
    "locationLng" REAL,
    "locationUpdatedAt" DATETIME,
    "availableAt" DATETIME,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "lastContactedAt" DATETIME,
    "nextFollowUpAt" DATETIME,
    "stageChangedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Carrier_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Carrier_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Carrier_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "PipelineStage" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Carrier" ("address", "assignedToId", "authorityDate", "authorityStatus", "carrierOperation", "city", "classification", "companyName", "createdAt", "dbaName", "doNotCall", "doNotEmail", "dotNumber", "drivers", "email", "equipment", "fleetSize", "id", "lastContactedAt", "mcNumber", "nextFollowUpAt", "operatingStatus", "ownerId", "phone", "priority", "source", "sourceRef", "stageChangedAt", "stageId", "state", "timezone", "updatedAt", "verifiedAt", "zip") SELECT "address", "assignedToId", "authorityDate", "authorityStatus", "carrierOperation", "city", "classification", "companyName", "createdAt", "dbaName", "doNotCall", "doNotEmail", "dotNumber", "drivers", "email", "equipment", "fleetSize", "id", "lastContactedAt", "mcNumber", "nextFollowUpAt", "operatingStatus", "ownerId", "phone", "priority", "source", "sourceRef", "stageChangedAt", "stageId", "state", "timezone", "updatedAt", "verifiedAt", "zip" FROM "Carrier";
DROP TABLE "Carrier";
ALTER TABLE "new_Carrier" RENAME TO "Carrier";
CREATE INDEX "Carrier_ownerId_stageId_idx" ON "Carrier"("ownerId", "stageId");
CREATE INDEX "Carrier_ownerId_companyName_idx" ON "Carrier"("ownerId", "companyName");
CREATE INDEX "Carrier_ownerId_phone_idx" ON "Carrier"("ownerId", "phone");
CREATE INDEX "Carrier_assignedToId_idx" ON "Carrier"("assignedToId");
CREATE INDEX "Carrier_state_idx" ON "Carrier"("state");
CREATE UNIQUE INDEX "Carrier_ownerId_dotNumber_key" ON "Carrier"("ownerId", "dotNumber");
CREATE UNIQUE INDEX "Carrier_ownerId_mcNumber_key" ON "Carrier"("ownerId", "mcNumber");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

