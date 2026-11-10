-- AlterTable
ALTER TABLE "LocationPing" ADD COLUMN "flags" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LocationShare" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "carrierId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "driverName" TEXT,
    "driverPhone" TEXT,
    "loadId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "consentAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "durationHours" INTEGER NOT NULL DEFAULT 24,
    "claimMinutes" INTEGER NOT NULL DEFAULT 120,
    "deviceHash" TEXT,
    "deviceLabel" TEXT,
    "deviceKind" TEXT,
    "deviceBoundAt" DATETIME,
    "firstBoundAt" DATETIME,
    "firstSeenIp" TEXT,
    "pinHash" TEXT,
    "pinAttempts" INTEGER NOT NULL DEFAULT 0,
    "pinVerifiedAt" DATETIME,
    "flags" TEXT NOT NULL DEFAULT '[]',
    "lastPingFlags" TEXT,
    "lastAlertAt" DATETIME,
    "lastGpsAlertAt" DATETIME,
    "trustedLat" REAL,
    "trustedLng" REAL,
    "trustedAt" DATETIME,
    "lastLat" REAL,
    "lastLng" REAL,
    "lastAccuracy" REAL,
    "lastSpeed" REAL,
    "lastHeading" REAL,
    "lastAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LocationShare_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LocationShare_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_LocationShare" ("carrierId", "consentAt", "createdAt", "driverName", "driverPhone", "expiresAt", "id", "lastAccuracy", "lastAt", "lastHeading", "lastLat", "lastLng", "lastSpeed", "loadId", "ownerId", "status", "tokenHash", "updatedAt") SELECT "carrierId", "consentAt", "createdAt", "driverName", "driverPhone", "expiresAt", "id", "lastAccuracy", "lastAt", "lastHeading", "lastLat", "lastLng", "lastSpeed", "loadId", "ownerId", "status", "tokenHash", "updatedAt" FROM "LocationShare";
DROP TABLE "LocationShare";
ALTER TABLE "new_LocationShare" RENAME TO "LocationShare";
CREATE UNIQUE INDEX "LocationShare_tokenHash_key" ON "LocationShare"("tokenHash");
CREATE INDEX "LocationShare_carrierId_status_idx" ON "LocationShare"("carrierId", "status");
CREATE INDEX "LocationShare_ownerId_idx" ON "LocationShare"("ownerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

