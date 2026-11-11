-- AlterTable
ALTER TABLE "User" ADD COLUMN "agreementTemplate" TEXT;
ALTER TABLE "User" ADD COLUMN "companyName" TEXT;
ALTER TABLE "User" ADD COLUMN "pushPrefs" TEXT;

-- CreateTable
CREATE TABLE "LoadRoute" (
    "loadId" TEXT NOT NULL PRIMARY KEY,
    "geometry" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LoadRoute_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "Load" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OnboardingLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "carrierId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "agreementTitle" TEXT NOT NULL,
    "agreementBody" TEXT NOT NULL,
    "agreementHash" TEXT NOT NULL,
    "feePercent" REAL,
    "requestedDocs" TEXT,
    "viewedAt" DATETIME,
    "consentAt" DATETIME,
    "signerName" TEXT,
    "signerTitle" TEXT,
    "signerEmail" TEXT,
    "signatureData" TEXT,
    "signedAt" DATETIME,
    "signerIp" TEXT,
    "signerUserAgent" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OnboardingLink_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OnboardingLink_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AIKnowledgeDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "scope" TEXT NOT NULL DEFAULT 'private',
    "approved" BOOLEAN NOT NULL DEFAULT true,
    "title" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "error" TEXT,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AIKnowledgeDocument_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AIKnowledgeDocument" ("approved", "chunkCount", "createdAt", "error", "id", "mimeType", "originalName", "ownerId", "scope", "status", "storedName", "title", "updatedAt") SELECT "approved", "chunkCount", "createdAt", "error", "id", "mimeType", "originalName", "ownerId", "scope", "status", "storedName", "title", "updatedAt" FROM "AIKnowledgeDocument";
DROP TABLE "AIKnowledgeDocument";
ALTER TABLE "new_AIKnowledgeDocument" RENAME TO "AIKnowledgeDocument";
CREATE UNIQUE INDEX "AIKnowledgeDocument_storedName_key" ON "AIKnowledgeDocument"("storedName");
CREATE INDEX "AIKnowledgeDocument_ownerId_idx" ON "AIKnowledgeDocument"("ownerId");
CREATE INDEX "AIKnowledgeDocument_scope_approved_idx" ON "AIKnowledgeDocument"("scope", "approved");
CREATE TABLE "new_MarketplaceListing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sellerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priceCents" INTEGER,
    "priceType" TEXT NOT NULL DEFAULT 'fixed',
    "location" TEXT,
    "contactEmail" TEXT,
    "websiteUrl" TEXT,
    "imagePath" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MarketplaceListing_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_MarketplaceListing" ("category", "contactEmail", "createdAt", "description", "id", "imagePath", "location", "priceCents", "priceType", "sellerId", "status", "title", "updatedAt", "websiteUrl") SELECT "category", "contactEmail", "createdAt", "description", "id", "imagePath", "location", "priceCents", "priceType", "sellerId", "status", "title", "updatedAt", "websiteUrl" FROM "MarketplaceListing";
DROP TABLE "MarketplaceListing";
ALTER TABLE "new_MarketplaceListing" RENAME TO "MarketplaceListing";
CREATE INDEX "MarketplaceListing_status_category_createdAt_idx" ON "MarketplaceListing"("status", "category", "createdAt");
CREATE INDEX "MarketplaceListing_sellerId_idx" ON "MarketplaceListing"("sellerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingLink_tokenHash_key" ON "OnboardingLink"("tokenHash");

-- CreateIndex
CREATE INDEX "OnboardingLink_ownerId_status_idx" ON "OnboardingLink"("ownerId", "status");

-- CreateIndex
CREATE INDEX "OnboardingLink_carrierId_idx" ON "OnboardingLink"("carrierId");

-- CreateIndex
CREATE INDEX "Broker_ownerId_mcNumber_idx" ON "Broker"("ownerId", "mcNumber");

-- CreateIndex
CREATE INDEX "Broker_watch_id_idx" ON "Broker"("watch", "id");

-- CreateIndex
CREATE INDEX "Carrier_ownerId_email_idx" ON "Carrier"("ownerId", "email");

-- CreateIndex
CREATE INDEX "CarrierContact_email_idx" ON "CarrierContact"("email");

-- CreateIndex
CREATE INDEX "Email_userId_repliedAt_idx" ON "Email"("userId", "repliedAt");

-- CreateIndex
CREATE INDEX "EmailAccount_imapEnabled_status_idx" ON "EmailAccount"("imapEnabled", "status");

-- CreateIndex
CREATE INDEX "Load_ownerId_referenceNumber_idx" ON "Load"("ownerId", "referenceNumber");

-- CreateIndex
CREATE INDEX "User_timezone_idx" ON "User"("timezone");

-- Move stored road routes out of the Load rows (keeps load lists and joins small). Timestamps are copied from the
-- Load row so they keep Prisma's storage format.
INSERT INTO "LoadRoute" ("loadId", "geometry", "createdAt", "updatedAt")
SELECT "id", "routeGeometry", COALESCE("routeComputedAt", "updatedAt"), "updatedAt" FROM "Load" WHERE "routeGeometry" IS NOT NULL;
UPDATE "Load" SET "routeGeometry" = NULL WHERE "routeGeometry" IS NOT NULL;
