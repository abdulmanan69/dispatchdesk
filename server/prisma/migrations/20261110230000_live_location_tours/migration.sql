-- AlterTable
ALTER TABLE "Carrier" ADD COLUMN "locationSource" TEXT;

-- CreateTable
CREATE TABLE "LocationShare" (
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

-- CreateTable
CREATE TABLE "LocationPing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shareId" TEXT NOT NULL,
    "lat" REAL NOT NULL,
    "lng" REAL NOT NULL,
    "accuracy" REAL,
    "speed" REAL,
    "heading" REAL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LocationPing_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "LocationShare" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "bio" TEXT,
    "avatarPath" TEXT,
    "roleId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "emailVerifiedAt" DATETIME,
    "theme" TEXT NOT NULL DEFAULT 'system',
    "timezone" TEXT NOT NULL DEFAULT 'America/Chicago',
    "emailSignature" TEXT,
    "notifyEmail" BOOLEAN NOT NULL DEFAULT true,
    "notifyInApp" BOOLEAN NOT NULL DEFAULT true,
    "notifyFollowUps" BOOLEAN NOT NULL DEFAULT true,
    "notifyCommunity" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" DATETIME,
    "tourState" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_User" ("avatarPath", "bio", "createdAt", "email", "emailSignature", "emailVerifiedAt", "id", "lastLoginAt", "name", "notifyCommunity", "notifyEmail", "notifyFollowUps", "notifyInApp", "passwordHash", "phone", "roleId", "status", "theme", "timezone", "updatedAt") SELECT "avatarPath", "bio", "createdAt", "email", "emailSignature", "emailVerifiedAt", "id", "lastLoginAt", "name", "notifyCommunity", "notifyEmail", "notifyFollowUps", "notifyInApp", "passwordHash", "phone", "roleId", "status", "theme", "timezone", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_roleId_idx" ON "User"("roleId");
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "LocationShare_tokenHash_key" ON "LocationShare"("tokenHash");

-- CreateIndex
CREATE INDEX "LocationShare_carrierId_status_idx" ON "LocationShare"("carrierId", "status");

-- CreateIndex
CREATE INDEX "LocationShare_ownerId_idx" ON "LocationShare"("ownerId");

-- CreateIndex
CREATE INDEX "LocationPing_shareId_at_idx" ON "LocationPing"("shareId", "at");

