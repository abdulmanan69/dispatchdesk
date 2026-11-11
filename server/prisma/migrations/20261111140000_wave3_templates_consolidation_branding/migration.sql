-- AlterTable
ALTER TABLE "User" ADD COLUMN "googleSub" TEXT;
ALTER TABLE "User" ADD COLUMN "invoiceLogo" TEXT;

-- CreateTable
CREATE TABLE "LoadTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fields" TEXT NOT NULL,
    "carrierId" TEXT,
    "brokerId" TEXT,
    "weekdays" TEXT,
    "pickupTime" TEXT,
    "leadDays" INTEGER NOT NULL DEFAULT 7,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "generatedTo" DATETIME,
    "lastRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LoadTemplate_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Consolidation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "carrierId" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "stops" TEXT NOT NULL,
    "routeGeometry" TEXT,
    "routeMiles" REAL,
    "routeMinutes" INTEGER,
    "routeComputedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Consolidation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Load" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "brokerId" TEXT,
    "carrierId" TEXT,
    "referenceNumber" TEXT,
    "originCity" TEXT NOT NULL,
    "originState" TEXT NOT NULL,
    "destCity" TEXT NOT NULL,
    "destState" TEXT NOT NULL,
    "originLat" REAL,
    "originLng" REAL,
    "destLat" REAL,
    "destLng" REAL,
    "pickupDate" DATETIME,
    "deliveryDate" DATETIME,
    "pickupWindowStart" DATETIME,
    "pickupWindowEnd" DATETIME,
    "deliveryWindowStart" DATETIME,
    "deliveryWindowEnd" DATETIME,
    "pickupTz" TEXT,
    "deliveryTz" TEXT,
    "pickupFacility" TEXT,
    "pickupAddress" TEXT,
    "deliveryFacility" TEXT,
    "deliveryAddress" TEXT,
    "freeTimeHours" REAL NOT NULL DEFAULT 2,
    "tonuCents" INTEGER NOT NULL DEFAULT 0,
    "fitWarnings" TEXT,
    "fitAckAt" DATETIME,
    "fitAckById" TEXT,
    "routeGeometry" TEXT,
    "routeMiles" REAL,
    "routeMinutes" INTEGER,
    "routeSource" TEXT,
    "routeComputedAt" DATETIME,
    "lastCheckCallAt" DATETIME,
    "equipment" TEXT,
    "commodity" TEXT,
    "weightLbs" INTEGER,
    "loadedMiles" INTEGER NOT NULL,
    "deadheadMiles" INTEGER NOT NULL DEFAULT 0,
    "rateCents" INTEGER NOT NULL,
    "detentionHours" REAL NOT NULL DEFAULT 0,
    "detentionRateCents" INTEGER NOT NULL DEFAULT 0,
    "fuelPricePerGallon" REAL,
    "mpg" REAL,
    "otherCostsCents" INTEGER NOT NULL DEFAULT 0,
    "dispatchFeePercent" REAL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "consolidationId" TEXT,
    "templateId" TEXT,
    CONSTRAINT "Load_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Load_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Load_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Load_consolidationId_fkey" FOREIGN KEY ("consolidationId") REFERENCES "Consolidation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Load" ("brokerId", "carrierId", "commodity", "createdAt", "deadheadMiles", "deliveryAddress", "deliveryDate", "deliveryFacility", "deliveryTz", "deliveryWindowEnd", "deliveryWindowStart", "destCity", "destLat", "destLng", "destState", "detentionHours", "detentionRateCents", "dispatchFeePercent", "equipment", "fitAckAt", "fitAckById", "fitWarnings", "freeTimeHours", "fuelPricePerGallon", "id", "lastCheckCallAt", "loadedMiles", "mpg", "notes", "originCity", "originLat", "originLng", "originState", "otherCostsCents", "ownerId", "pickupAddress", "pickupDate", "pickupFacility", "pickupTz", "pickupWindowEnd", "pickupWindowStart", "rateCents", "referenceNumber", "routeComputedAt", "routeGeometry", "routeMiles", "routeMinutes", "routeSource", "status", "tonuCents", "updatedAt", "weightLbs") SELECT "brokerId", "carrierId", "commodity", "createdAt", "deadheadMiles", "deliveryAddress", "deliveryDate", "deliveryFacility", "deliveryTz", "deliveryWindowEnd", "deliveryWindowStart", "destCity", "destLat", "destLng", "destState", "detentionHours", "detentionRateCents", "dispatchFeePercent", "equipment", "fitAckAt", "fitAckById", "fitWarnings", "freeTimeHours", "fuelPricePerGallon", "id", "lastCheckCallAt", "loadedMiles", "mpg", "notes", "originCity", "originLat", "originLng", "originState", "otherCostsCents", "ownerId", "pickupAddress", "pickupDate", "pickupFacility", "pickupTz", "pickupWindowEnd", "pickupWindowStart", "rateCents", "referenceNumber", "routeComputedAt", "routeGeometry", "routeMiles", "routeMinutes", "routeSource", "status", "tonuCents", "updatedAt", "weightLbs" FROM "Load";
DROP TABLE "Load";
ALTER TABLE "new_Load" RENAME TO "Load";
CREATE INDEX "Load_ownerId_status_idx" ON "Load"("ownerId", "status");
CREATE INDEX "Load_brokerId_idx" ON "Load"("brokerId");
CREATE INDEX "Load_carrierId_idx" ON "Load"("carrierId");
CREATE INDEX "Load_ownerId_originState_destState_idx" ON "Load"("ownerId", "originState", "destState");
CREATE INDEX "Load_ownerId_pickupDate_idx" ON "Load"("ownerId", "pickupDate");
CREATE INDEX "Load_ownerId_deliveryDate_idx" ON "Load"("ownerId", "deliveryDate");
CREATE INDEX "Load_ownerId_referenceNumber_idx" ON "Load"("ownerId", "referenceNumber");
CREATE INDEX "Load_consolidationId_idx" ON "Load"("consolidationId");
CREATE INDEX "Load_templateId_pickupDate_idx" ON "Load"("templateId", "pickupDate");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "LoadTemplate_ownerId_active_idx" ON "LoadTemplate"("ownerId", "active");

-- CreateIndex
CREATE INDEX "LoadTemplate_active_generatedTo_idx" ON "LoadTemplate"("active", "generatedTo");

-- CreateIndex
CREATE INDEX "Consolidation_ownerId_status_idx" ON "Consolidation"("ownerId", "status");

-- CreateIndex
CREATE INDEX "Consolidation_carrierId_status_idx" ON "Consolidation"("carrierId", "status");

-- CreateIndex
CREATE INDEX "Invoice_ownerId_brokerId_paidAt_idx" ON "Invoice"("ownerId", "brokerId", "paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");

