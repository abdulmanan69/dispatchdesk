-- Paddle billing: a Paddle price per plan, and which provider a subscription, payment or code belongs to.
ALTER TABLE "Coupon" ADD COLUMN "provider" TEXT;
ALTER TABLE "Plan" ADD COLUMN "paddlePriceId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'stripe';
ALTER TABLE "Payment" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'stripe';
