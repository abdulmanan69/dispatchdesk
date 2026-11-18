-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ManualPayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "teamId" TEXT,
    "planId" INTEGER NOT NULL,
    "seats" INTEGER NOT NULL DEFAULT 1,
    "months" INTEGER NOT NULL DEFAULT 1,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'awaiting',
    "method" TEXT,
    "transactionRef" TEXT,
    "note" TEXT,
    "submittedAt" DATETIME,
    "reviewedAt" DATETIME,
    "reviewedById" TEXT,
    "rejectReason" TEXT,
    "paymentId" TEXT,
    "cryptoAmount" TEXT,
    "chainTxId" TEXT,
    "autoConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ManualPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ManualPayment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ManualPayment" ("amountCents", "createdAt", "currency", "id", "method", "months", "note", "paymentId", "planId", "reference", "rejectReason", "reviewedAt", "reviewedById", "seats", "status", "submittedAt", "teamId", "transactionRef", "updatedAt", "userId") SELECT "amountCents", "createdAt", "currency", "id", "method", "months", "note", "paymentId", "planId", "reference", "rejectReason", "reviewedAt", "reviewedById", "seats", "status", "submittedAt", "teamId", "transactionRef", "updatedAt", "userId" FROM "ManualPayment";
DROP TABLE "ManualPayment";
ALTER TABLE "new_ManualPayment" RENAME TO "ManualPayment";
CREATE UNIQUE INDEX "ManualPayment_reference_key" ON "ManualPayment"("reference");
CREATE UNIQUE INDEX "ManualPayment_chainTxId_key" ON "ManualPayment"("chainTxId");
CREATE INDEX "ManualPayment_status_submittedAt_idx" ON "ManualPayment"("status", "submittedAt");
CREATE INDEX "ManualPayment_userId_createdAt_idx" ON "ManualPayment"("userId", "createdAt");
CREATE INDEX "ManualPayment_status_cryptoAmount_idx" ON "ManualPayment"("status", "cryptoAmount");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

