-- CreateTable
CREATE TABLE "CarrierAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dotNumber" TEXT NOT NULL,
    "legalName" TEXT,
    "verifiedEmail" TEXT,
    "verifiedAt" DATETIME,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CarrierLoginCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dotNumber" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "ip" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CarrierSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CarrierSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CarrierAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CarrierVaultDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "expiresAt" DATETIME,
    "replacedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CarrierVaultDocument_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CarrierAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CarrierShare" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "carrierId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "docTypes" TEXT NOT NULL DEFAULT '',
    "autoUpdate" BOOLEAN NOT NULL DEFAULT true,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CarrierShare_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CarrierAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CarrierShare_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CarrierShare_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CarrierShareDoc" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shareId" TEXT NOT NULL,
    "vaultDocumentId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CarrierShareDoc_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "CarrierShare" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CarrierShareDoc_vaultDocumentId_fkey" FOREIGN KEY ("vaultDocumentId") REFERENCES "CarrierVaultDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CarrierShareDoc_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "CarrierAccount_dotNumber_key" ON "CarrierAccount"("dotNumber");

-- CreateIndex
CREATE INDEX "CarrierLoginCode_dotNumber_createdAt_idx" ON "CarrierLoginCode"("dotNumber", "createdAt");

-- CreateIndex
CREATE INDEX "CarrierLoginCode_expiresAt_idx" ON "CarrierLoginCode"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierSession_tokenHash_key" ON "CarrierSession"("tokenHash");

-- CreateIndex
CREATE INDEX "CarrierSession_accountId_idx" ON "CarrierSession"("accountId");

-- CreateIndex
CREATE INDEX "CarrierSession_expiresAt_idx" ON "CarrierSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierVaultDocument_storedName_key" ON "CarrierVaultDocument"("storedName");

-- CreateIndex
CREATE INDEX "CarrierVaultDocument_accountId_type_idx" ON "CarrierVaultDocument"("accountId", "type");

-- CreateIndex
CREATE INDEX "CarrierShare_ownerId_idx" ON "CarrierShare"("ownerId");

-- CreateIndex
CREATE INDEX "CarrierShare_carrierId_idx" ON "CarrierShare"("carrierId");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierShare_accountId_carrierId_key" ON "CarrierShare"("accountId", "carrierId");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierShareDoc_documentId_key" ON "CarrierShareDoc"("documentId");

-- CreateIndex
CREATE INDEX "CarrierShareDoc_vaultDocumentId_idx" ON "CarrierShareDoc"("vaultDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierShareDoc_shareId_vaultDocumentId_key" ON "CarrierShareDoc"("shareId", "vaultDocumentId");

