-- CreateTable
CREATE TABLE "ManualPayment" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ManualPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ManualPayment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ManualPayment_reference_key" ON "ManualPayment"("reference");

-- CreateIndex
CREATE INDEX "ManualPayment_status_submittedAt_idx" ON "ManualPayment"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "ManualPayment_userId_createdAt_idx" ON "ManualPayment"("userId", "createdAt");
