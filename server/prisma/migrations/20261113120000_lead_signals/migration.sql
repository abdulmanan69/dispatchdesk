-- AlterTable
ALTER TABLE "Carrier" ADD COLUMN "leadScore" INTEGER;
ALTER TABLE "Carrier" ADD COLUMN "leadSignals" TEXT;
ALTER TABLE "Carrier" ADD COLUMN "leadTier" TEXT;

-- AlterTable
ALTER TABLE "LeadGenRun" ADD COLUMN "exclusions" TEXT;

-- CreateIndex
CREATE INDEX "Carrier_ownerId_leadScore_idx" ON "Carrier"("ownerId", "leadScore");
