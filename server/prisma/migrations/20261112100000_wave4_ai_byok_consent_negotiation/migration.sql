-- AlterTable
ALTER TABLE "Email" ADD COLUMN "negotiationId" TEXT;

-- AlterTable
ALTER TABLE "SequenceStep" ADD COLUMN "aiBrief" TEXT;
ALTER TABLE "SequenceStep" ADD COLUMN "aiMode" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "aiBaseUrl" TEXT;
ALTER TABLE "User" ADD COLUMN "aiKeyEnc" TEXT;
ALTER TABLE "User" ADD COLUMN "aiKeyHint" TEXT;
ALTER TABLE "User" ADD COLUMN "aiModel" TEXT;
ALTER TABLE "User" ADD COLUMN "aiProvider" TEXT;

-- CreateTable
CREATE TABLE "AiUsageEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "byok" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT,
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiUsageEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ContactConsent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "carrierId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "channels" TEXT NOT NULL,
    "consentText" TEXT NOT NULL,
    "consentHash" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "onboardingLinkId" TEXT,
    "grantedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedByName" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "proofDocumentId" TEXT,
    "note" TEXT,
    "revokedAt" DATETIME,
    "revokeReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ContactConsent_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ContactConsent_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Negotiation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "carrierId" TEXT,
    "loadId" TEXT,
    "emailAccountId" TEXT,
    "toEmail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "mode" TEXT NOT NULL DEFAULT 'approve',
    "lane" TEXT NOT NULL,
    "offerCents" INTEGER,
    "targetCents" INTEGER NOT NULL,
    "floorCents" INTEGER NOT NULL,
    "lastCounterCents" INTEGER,
    "agreedCents" INTEGER,
    "rounds" INTEGER NOT NULL DEFAULT 0,
    "maxRounds" INTEGER NOT NULL DEFAULT 3,
    "history" TEXT NOT NULL DEFAULT '[]',
    "nextAction" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Negotiation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Negotiation_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Negotiation_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AiUsageEvent_userId_byok_createdAt_idx" ON "AiUsageEvent"("userId", "byok", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsageEvent_createdAt_idx" ON "AiUsageEvent"("createdAt");

-- CreateIndex
CREATE INDEX "ContactConsent_ownerId_carrierId_idx" ON "ContactConsent"("ownerId", "carrierId");

-- CreateIndex
CREATE INDEX "ContactConsent_carrierId_revokedAt_idx" ON "ContactConsent"("carrierId", "revokedAt");

-- CreateIndex
CREATE INDEX "ContactConsent_phone_idx" ON "ContactConsent"("phone");

-- CreateIndex
CREATE INDEX "Negotiation_ownerId_status_idx" ON "Negotiation"("ownerId", "status");

-- CreateIndex
CREATE INDEX "Negotiation_brokerId_idx" ON "Negotiation"("brokerId");

-- CreateIndex
CREATE INDEX "Negotiation_loadId_idx" ON "Negotiation"("loadId");

-- CreateIndex
CREATE INDEX "Email_negotiationId_idx" ON "Email"("negotiationId");

-- CreateIndex
CREATE INDEX "Email_userId_aiGenerated_status_idx" ON "Email"("userId", "aiGenerated", "status");

