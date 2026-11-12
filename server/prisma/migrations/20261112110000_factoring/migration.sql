-- CreateTable
CREATE TABLE "FactoringCompany" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "submitEmail" TEXT,
    "remitTo" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FactoringCompany_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Customer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "carrierId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "signedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchFeePercent" REAL,
    "minRatePerMile" REAL,
    "maxDeadheadMiles" INTEGER,
    "homeBase" TEXT,
    "maxWeightLbs" INTEGER,
    "trailerLengthFt" INTEGER,
    "hazmat" BOOLEAN NOT NULL DEFAULT false,
    "twic" BOOLEAN NOT NULL DEFAULT false,
    "teamDrivers" BOOLEAN NOT NULL DEFAULT false,
    "avoidStates" TEXT,
    "homeTimeDays" TEXT,
    "costPerMileCents" INTEGER,
    "minHaulMiles" INTEGER,
    "maxHaulMiles" INTEGER,
    "portalTokenHash" TEXT,
    "portalExpiresAt" DATETIME,
    "notes" TEXT,
    "factoringCompanyId" TEXT,
    "factoringClientNo" TEXT,
    "factoringAdvancePct" REAL,
    "factoringFeePct" REAL,
    "factoringRecourse" BOOLEAN,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Customer_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Customer_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Customer_factoringCompanyId_fkey" FOREIGN KEY ("factoringCompanyId") REFERENCES "FactoringCompany" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Customer" ("avoidStates", "carrierId", "costPerMileCents", "createdAt", "dispatchFeePercent", "hazmat", "homeBase", "homeTimeDays", "id", "maxDeadheadMiles", "maxHaulMiles", "maxWeightLbs", "minHaulMiles", "minRatePerMile", "notes", "ownerId", "portalExpiresAt", "portalTokenHash", "signedAt", "status", "teamDrivers", "trailerLengthFt", "twic", "updatedAt") SELECT "avoidStates", "carrierId", "costPerMileCents", "createdAt", "dispatchFeePercent", "hazmat", "homeBase", "homeTimeDays", "id", "maxDeadheadMiles", "maxHaulMiles", "maxWeightLbs", "minHaulMiles", "minRatePerMile", "notes", "ownerId", "portalExpiresAt", "portalTokenHash", "signedAt", "status", "teamDrivers", "trailerLengthFt", "twic", "updatedAt" FROM "Customer";
DROP TABLE "Customer";
ALTER TABLE "new_Customer" RENAME TO "Customer";
CREATE UNIQUE INDEX "Customer_carrierId_key" ON "Customer"("carrierId");
CREATE UNIQUE INDEX "Customer_portalTokenHash_key" ON "Customer"("portalTokenHash");
CREATE INDEX "Customer_ownerId_status_idx" ON "Customer"("ownerId", "status");
CREATE INDEX "Customer_factoringCompanyId_idx" ON "Customer"("factoringCompanyId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "FactoringCompany_ownerId_idx" ON "FactoringCompany"("ownerId");

