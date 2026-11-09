-- AlterTable
ALTER TABLE "Call" ADD COLUMN "provider" TEXT;

-- CreateTable
CREATE TABLE "CallSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'tel',
    "urlTemplate" TEXT,
    "myNumber" TEXT,
    "callerId" TEXT,
    "twilioAccountSid" TEXT,
    "twilioAuthTokenEnc" TEXT,
    "autoOpenLog" BOOLEAN NOT NULL DEFAULT true,
    "autoAdvance" BOOLEAN NOT NULL DEFAULT true,
    "enforceCallingHours" BOOLEAN NOT NULL DEFAULT true,
    "autoLogUnanswered" BOOLEAN NOT NULL DEFAULT true,
    "defaultScriptId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CallSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CallAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "carrierId" TEXT,
    "callId" TEXT,
    "provider" TEXT NOT NULL,
    "toNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'dialed',
    "providerCallId" TEXT,
    "answeredAt" DATETIME,
    "endedAt" DATETIME,
    "durationSec" INTEGER,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CallAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CallAttempt_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CallAttempt_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CallScript" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'cold_call',
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CallScript_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "CallSettings_userId_key" ON "CallSettings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CallAttempt_providerCallId_key" ON "CallAttempt"("providerCallId");

-- CreateIndex
CREATE INDEX "CallAttempt_userId_createdAt_idx" ON "CallAttempt"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CallAttempt_carrierId_idx" ON "CallAttempt"("carrierId");

-- CreateIndex
CREATE INDEX "CallScript_ownerId_idx" ON "CallScript"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiToken_userId_idx" ON "ApiToken"("userId");
