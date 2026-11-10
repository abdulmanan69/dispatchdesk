-- DropIndex
DROP INDEX "Email_userId_status_idx";

-- AlterTable
ALTER TABLE "Document" ADD COLUMN "source" TEXT;

-- AlterTable
ALTER TABLE "Email" ADD COLUMN "attachments" TEXT;
ALTER TABLE "Email" ADD COLUMN "bounceReason" TEXT;
ALTER TABLE "Email" ADD COLUMN "bouncedAt" DATETIME;
ALTER TABLE "Email" ADD COLUMN "messageId" TEXT;
ALTER TABLE "Email" ADD COLUMN "repliedAt" DATETIME;

-- CreateTable
CREATE TABLE "TextTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'carrier',
    "starterKey" TEXT,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TextTemplate_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LoadEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "loadId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lat" REAL,
    "lng" REAL,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'dispatcher',
    "data" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoadEvent_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "Load" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LoadEvent_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LoadShare" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "loadId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "views" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoadShare_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "Load" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LoadShare_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'freight',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "loadId" TEXT,
    "carrierId" TEXT,
    "brokerId" TEXT,
    "billToName" TEXT NOT NULL,
    "billToEmail" TEXT,
    "lines" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paidCents" INTEGER NOT NULL DEFAULT 0,
    "issuedAt" DATETIME,
    "dueAt" DATETIME,
    "sentAt" DATETIME,
    "paidAt" DATETIME,
    "notes" TEXT,
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "lastReminderAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Invoice_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Invoice_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "Load" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Invoice_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Invoice_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Broker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "mcNumber" TEXT,
    "dotNumber" TEXT,
    "paymentTerms" TEXT,
    "daysToPay" INTEGER,
    "creditRating" TEXT,
    "creditLimitCents" INTEGER,
    "fmcsaSnapshot" TEXT,
    "fmcsaCheckedAt" DATETIME,
    "flags" TEXT,
    "watch" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Broker_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Broker" ("address", "city", "companyName", "contactName", "createdAt", "creditLimitCents", "creditRating", "daysToPay", "dotNumber", "email", "id", "mcNumber", "notes", "ownerId", "paymentTerms", "phone", "state", "updatedAt", "zip") SELECT "address", "city", "companyName", "contactName", "createdAt", "creditLimitCents", "creditRating", "daysToPay", "dotNumber", "email", "id", "mcNumber", "notes", "ownerId", "paymentTerms", "phone", "state", "updatedAt", "zip" FROM "Broker";
DROP TABLE "Broker";
ALTER TABLE "new_Broker" RENAME TO "Broker";
CREATE INDEX "Broker_ownerId_companyName_idx" ON "Broker"("ownerId", "companyName");
CREATE TABLE "new_Carrier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "assignedToId" TEXT,
    "stageId" INTEGER NOT NULL,
    "companyName" TEXT NOT NULL,
    "dbaName" TEXT,
    "dotNumber" TEXT,
    "mcNumber" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "equipment" TEXT,
    "fleetSize" INTEGER,
    "drivers" INTEGER,
    "authorityStatus" TEXT,
    "authorityDate" DATETIME,
    "operatingStatus" TEXT,
    "classification" TEXT,
    "carrierOperation" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceRef" TEXT,
    "verifiedAt" DATETIME,
    "timezone" TEXT,
    "doNotCall" BOOLEAN NOT NULL DEFAULT false,
    "doNotEmail" BOOLEAN NOT NULL DEFAULT false,
    "truckStatus" TEXT NOT NULL DEFAULT 'unknown',
    "locationCity" TEXT,
    "locationState" TEXT,
    "locationLat" REAL,
    "locationLng" REAL,
    "locationUpdatedAt" DATETIME,
    "availableAt" DATETIME,
    "locationSource" TEXT,
    "isFleet" BOOLEAN NOT NULL DEFAULT false,
    "fmcsaSnapshot" TEXT,
    "fmcsaCheckedAt" DATETIME,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "lastContactedAt" DATETIME,
    "nextFollowUpAt" DATETIME,
    "stageChangedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Carrier_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Carrier_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Carrier_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "PipelineStage" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Carrier" ("address", "assignedToId", "authorityDate", "authorityStatus", "availableAt", "carrierOperation", "city", "classification", "companyName", "createdAt", "dbaName", "doNotCall", "doNotEmail", "dotNumber", "drivers", "email", "equipment", "fleetSize", "id", "lastContactedAt", "locationCity", "locationLat", "locationLng", "locationSource", "locationState", "locationUpdatedAt", "mcNumber", "nextFollowUpAt", "operatingStatus", "ownerId", "phone", "priority", "source", "sourceRef", "stageChangedAt", "stageId", "state", "timezone", "truckStatus", "updatedAt", "verifiedAt", "zip") SELECT "address", "assignedToId", "authorityDate", "authorityStatus", "availableAt", "carrierOperation", "city", "classification", "companyName", "createdAt", "dbaName", "doNotCall", "doNotEmail", "dotNumber", "drivers", "email", "equipment", "fleetSize", "id", "lastContactedAt", "locationCity", "locationLat", "locationLng", "locationSource", "locationState", "locationUpdatedAt", "mcNumber", "nextFollowUpAt", "operatingStatus", "ownerId", "phone", "priority", "source", "sourceRef", "stageChangedAt", "stageId", "state", "timezone", "truckStatus", "updatedAt", "verifiedAt", "zip" FROM "Carrier";
DROP TABLE "Carrier";
ALTER TABLE "new_Carrier" RENAME TO "Carrier";
CREATE INDEX "Carrier_ownerId_stageId_idx" ON "Carrier"("ownerId", "stageId");
CREATE INDEX "Carrier_ownerId_companyName_idx" ON "Carrier"("ownerId", "companyName");
CREATE INDEX "Carrier_ownerId_phone_idx" ON "Carrier"("ownerId", "phone");
CREATE INDEX "Carrier_assignedToId_idx" ON "Carrier"("assignedToId");
CREATE INDEX "Carrier_state_idx" ON "Carrier"("state");
CREATE INDEX "Carrier_ownerId_createdAt_idx" ON "Carrier"("ownerId", "createdAt");
CREATE INDEX "Carrier_ownerId_isFleet_idx" ON "Carrier"("ownerId", "isFleet");
CREATE UNIQUE INDEX "Carrier_ownerId_dotNumber_key" ON "Carrier"("ownerId", "dotNumber");
CREATE UNIQUE INDEX "Carrier_ownerId_mcNumber_key" ON "Carrier"("ownerId", "mcNumber");
CREATE TABLE "new_Customer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "carrierId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "signedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchFeePercent" REAL,
    "minRatePerMile" REAL,
    "maxDeadheadMiles" INTEGER,
    "homeBase" TEXT,
    "maxWeightLbs" INTEGER,
    "trailerLengthFt" INTEGER,
    "hazmat" BOOLEAN NOT NULL DEFAULT false,
    "twic" BOOLEAN NOT NULL DEFAULT false,
    "teamDrivers" BOOLEAN NOT NULL DEFAULT false,
    "avoidStates" TEXT,
    "homeTimeDays" TEXT,
    "costPerMileCents" INTEGER,
    "minHaulMiles" INTEGER,
    "maxHaulMiles" INTEGER,
    "portalTokenHash" TEXT,
    "portalExpiresAt" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Customer_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Customer_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Customer" ("carrierId", "createdAt", "dispatchFeePercent", "homeBase", "id", "maxDeadheadMiles", "minRatePerMile", "notes", "ownerId", "signedAt", "status", "updatedAt") SELECT "carrierId", "createdAt", "dispatchFeePercent", "homeBase", "id", "maxDeadheadMiles", "minRatePerMile", "notes", "ownerId", "signedAt", "status", "updatedAt" FROM "Customer";
DROP TABLE "Customer";
ALTER TABLE "new_Customer" RENAME TO "Customer";
CREATE UNIQUE INDEX "Customer_carrierId_key" ON "Customer"("carrierId");
CREATE UNIQUE INDEX "Customer_portalTokenHash_key" ON "Customer"("portalTokenHash");
CREATE INDEX "Customer_ownerId_status_idx" ON "Customer"("ownerId", "status");
CREATE TABLE "new_EmailAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "smtpHost" TEXT,
    "smtpPort" INTEGER,
    "smtpSecure" BOOLEAN NOT NULL DEFAULT true,
    "smtpUser" TEXT,
    "secretEnc" TEXT,
    "accessTokenEnc" TEXT,
    "tokenExpiresAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "lastError" TEXT,
    "lastVerifiedAt" DATETIME,
    "dailyLimit" INTEGER NOT NULL DEFAULT 50,
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 30,
    "lastSentAt" DATETIME,
    "sentDay" TEXT,
    "sentToday" INTEGER NOT NULL DEFAULT 0,
    "imapEnabled" BOOLEAN NOT NULL DEFAULT false,
    "imapHost" TEXT,
    "imapPort" INTEGER,
    "imapSecure" BOOLEAN NOT NULL DEFAULT true,
    "imapLastUid" INTEGER,
    "imapCheckedAt" DATETIME,
    "imapError" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EmailAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_EmailAccount" ("accessTokenEnc", "cooldownSeconds", "createdAt", "dailyLimit", "fromEmail", "fromName", "id", "isDefault", "label", "lastError", "lastSentAt", "lastVerifiedAt", "provider", "secretEnc", "smtpHost", "smtpPort", "smtpSecure", "smtpUser", "status", "tokenExpiresAt", "updatedAt", "userId") SELECT "accessTokenEnc", "cooldownSeconds", "createdAt", "dailyLimit", "fromEmail", "fromName", "id", "isDefault", "label", "lastError", "lastSentAt", "lastVerifiedAt", "provider", "secretEnc", "smtpHost", "smtpPort", "smtpSecure", "smtpUser", "status", "tokenExpiresAt", "updatedAt", "userId" FROM "EmailAccount";
DROP TABLE "EmailAccount";
ALTER TABLE "new_EmailAccount" RENAME TO "EmailAccount";
CREATE INDEX "EmailAccount_userId_idx" ON "EmailAccount"("userId");
CREATE TABLE "new_EmailTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'carrier',
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "starterKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EmailTemplate_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_EmailTemplate" ("body", "category", "createdAt", "id", "name", "ownerId", "subject", "updatedAt") SELECT "body", "category", "createdAt", "id", "name", "ownerId", "subject", "updatedAt" FROM "EmailTemplate";
DROP TABLE "EmailTemplate";
ALTER TABLE "new_EmailTemplate" RENAME TO "EmailTemplate";
CREATE INDEX "EmailTemplate_ownerId_idx" ON "EmailTemplate"("ownerId");
CREATE INDEX "EmailTemplate_ownerId_starterKey_idx" ON "EmailTemplate"("ownerId", "starterKey");
CREATE TABLE "new_Load" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "brokerId" TEXT,
    "carrierId" TEXT,
    "referenceNumber" TEXT,
    "originCity" TEXT NOT NULL,
    "originState" TEXT NOT NULL,
    "destCity" TEXT NOT NULL,
    "destState" TEXT NOT NULL,
    "originLat" REAL,
    "originLng" REAL,
    "destLat" REAL,
    "destLng" REAL,
    "pickupDate" DATETIME,
    "deliveryDate" DATETIME,
    "pickupWindowStart" DATETIME,
    "pickupWindowEnd" DATETIME,
    "deliveryWindowStart" DATETIME,
    "deliveryWindowEnd" DATETIME,
    "pickupTz" TEXT,
    "deliveryTz" TEXT,
    "pickupFacility" TEXT,
    "pickupAddress" TEXT,
    "deliveryFacility" TEXT,
    "deliveryAddress" TEXT,
    "freeTimeHours" REAL NOT NULL DEFAULT 2,
    "tonuCents" INTEGER NOT NULL DEFAULT 0,
    "fitWarnings" TEXT,
    "fitAckAt" DATETIME,
    "fitAckById" TEXT,
    "routeGeometry" TEXT,
    "routeMiles" REAL,
    "routeMinutes" INTEGER,
    "routeSource" TEXT,
    "routeComputedAt" DATETIME,
    "lastCheckCallAt" DATETIME,
    "equipment" TEXT,
    "commodity" TEXT,
    "weightLbs" INTEGER,
    "loadedMiles" INTEGER NOT NULL,
    "deadheadMiles" INTEGER NOT NULL DEFAULT 0,
    "rateCents" INTEGER NOT NULL,
    "detentionHours" REAL NOT NULL DEFAULT 0,
    "detentionRateCents" INTEGER NOT NULL DEFAULT 0,
    "fuelPricePerGallon" REAL,
    "mpg" REAL,
    "otherCostsCents" INTEGER NOT NULL DEFAULT 0,
    "dispatchFeePercent" REAL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Load_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Load_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Load_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Load" ("brokerId", "carrierId", "commodity", "createdAt", "deadheadMiles", "deliveryDate", "destCity", "destLat", "destLng", "destState", "detentionHours", "detentionRateCents", "dispatchFeePercent", "equipment", "fuelPricePerGallon", "id", "loadedMiles", "mpg", "notes", "originCity", "originLat", "originLng", "originState", "otherCostsCents", "ownerId", "pickupDate", "rateCents", "referenceNumber", "status", "updatedAt", "weightLbs") SELECT "brokerId", "carrierId", "commodity", "createdAt", "deadheadMiles", "deliveryDate", "destCity", "destLat", "destLng", "destState", "detentionHours", "detentionRateCents", "dispatchFeePercent", "equipment", "fuelPricePerGallon", "id", "loadedMiles", "mpg", "notes", "originCity", "originLat", "originLng", "originState", "otherCostsCents", "ownerId", "pickupDate", "rateCents", "referenceNumber", "status", "updatedAt", "weightLbs" FROM "Load";
DROP TABLE "Load";
ALTER TABLE "new_Load" RENAME TO "Load";
CREATE INDEX "Load_ownerId_status_idx" ON "Load"("ownerId", "status");
CREATE INDEX "Load_brokerId_idx" ON "Load"("brokerId");
CREATE INDEX "Load_carrierId_idx" ON "Load"("carrierId");
CREATE INDEX "Load_ownerId_originState_destState_idx" ON "Load"("ownerId", "originState", "destState");
CREATE INDEX "Load_ownerId_pickupDate_idx" ON "Load"("ownerId", "pickupDate");
CREATE INDEX "Load_ownerId_deliveryDate_idx" ON "Load"("ownerId", "deliveryDate");
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
    "calendarTokenHash" TEXT,
    "notifyPush" BOOLEAN NOT NULL DEFAULT true,
    "notifyDigest" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_User" ("avatarPath", "bio", "createdAt", "email", "emailSignature", "emailVerifiedAt", "id", "lastLoginAt", "name", "notifyCommunity", "notifyEmail", "notifyFollowUps", "notifyInApp", "passwordHash", "phone", "roleId", "status", "theme", "timezone", "tourState", "updatedAt") SELECT "avatarPath", "bio", "createdAt", "email", "emailSignature", "emailVerifiedAt", "id", "lastLoginAt", "name", "notifyCommunity", "notifyEmail", "notifyFollowUps", "notifyInApp", "passwordHash", "phone", "roleId", "status", "theme", "timezone", "tourState", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_calendarTokenHash_key" ON "User"("calendarTokenHash");
CREATE INDEX "User_roleId_idx" ON "User"("roleId");
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "TextTemplate_ownerId_category_idx" ON "TextTemplate"("ownerId", "category");

-- CreateIndex
CREATE INDEX "TextTemplate_ownerId_starterKey_idx" ON "TextTemplate"("ownerId", "starterKey");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE INDEX "LoadEvent_loadId_at_idx" ON "LoadEvent"("loadId", "at");

-- CreateIndex
CREATE INDEX "LoadEvent_ownerId_at_idx" ON "LoadEvent"("ownerId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "LoadShare_tokenHash_key" ON "LoadShare"("tokenHash");

-- CreateIndex
CREATE INDEX "LoadShare_loadId_idx" ON "LoadShare"("loadId");

-- CreateIndex
CREATE INDEX "LoadShare_ownerId_idx" ON "LoadShare"("ownerId");

-- CreateIndex
CREATE INDEX "Invoice_ownerId_status_dueAt_idx" ON "Invoice"("ownerId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Invoice_loadId_idx" ON "Invoice"("loadId");

-- CreateIndex
CREATE INDEX "Invoice_carrierId_idx" ON "Invoice"("carrierId");

-- CreateIndex
CREATE INDEX "Invoice_brokerId_idx" ON "Invoice"("brokerId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_ownerId_number_key" ON "Invoice"("ownerId", "number");

-- CreateIndex
CREATE INDEX "CallAttempt_callId_idx" ON "CallAttempt"("callId");

-- CreateIndex
CREATE INDEX "CarrierNote_authorId_idx" ON "CarrierNote"("authorId");

-- CreateIndex
CREATE INDEX "CommunityComment_authorId_idx" ON "CommunityComment"("authorId");

-- CreateIndex
CREATE INDEX "CommunityComment_parentId_idx" ON "CommunityComment"("parentId");

-- CreateIndex
CREATE INDEX "CommunityPost_status_pinned_createdAt_idx" ON "CommunityPost"("status", "pinned", "createdAt");

-- CreateIndex
CREATE INDEX "ContentReport_listingId_idx" ON "ContentReport"("listingId");

-- CreateIndex
CREATE INDEX "ContentReport_postId_idx" ON "ContentReport"("postId");

-- CreateIndex
CREATE INDEX "ContentReport_commentId_idx" ON "ContentReport"("commentId");

-- CreateIndex
CREATE INDEX "ContentReport_reporterId_idx" ON "ContentReport"("reporterId");

-- CreateIndex
CREATE INDEX "Document_uploadedById_idx" ON "Document"("uploadedById");

-- CreateIndex
CREATE INDEX "Document_expiresAt_idx" ON "Document"("expiresAt");

-- CreateIndex
CREATE INDEX "Email_userId_status_sentAt_idx" ON "Email"("userId", "status", "sentAt");

-- CreateIndex
CREATE INDEX "Email_enrollmentId_createdAt_idx" ON "Email"("enrollmentId", "createdAt");

-- CreateIndex
CREATE INDEX "Email_emailAccountId_status_sentAt_idx" ON "Email"("emailAccountId", "status", "sentAt");

-- CreateIndex
CREATE INDEX "Email_templateId_idx" ON "Email"("templateId");

-- CreateIndex
CREATE INDEX "Email_brokerId_idx" ON "Email"("brokerId");

-- CreateIndex
CREATE INDEX "Email_userId_updatedAt_idx" ON "Email"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "Email_messageId_idx" ON "Email"("messageId");

-- CreateIndex
CREATE INDEX "FollowUp_status_notifiedAt_dueAt_idx" ON "FollowUp"("status", "notifiedAt", "dueAt");

-- CreateIndex
CREATE INDEX "LocationPing_at_idx" ON "LocationPing"("at");

-- CreateIndex
CREATE INDEX "MarketplaceMessage_senderId_createdAt_idx" ON "MarketplaceMessage"("senderId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SequenceEnrollment_carrierId_status_idx" ON "SequenceEnrollment"("carrierId", "status");

-- CreateIndex
CREATE INDEX "SequenceEnrollment_status_nextStepAt_idx" ON "SequenceEnrollment"("status", "nextStepAt");

-- CreateIndex
CREATE INDEX "TrainerMessage_authorId_idx" ON "TrainerMessage"("authorId");

