// Every core operation. To add an object's operations: create `<object>.ts` next to this file
// exporting `<object>Operations = [...] as const`, then add one import and one spread line below.
// One line per object so parallel changes merge cleanly.

import { syncOperations } from "../sync/ingest.ts";
import { a2uiOperations } from "./a2ui.ts";
import { accessOperations } from "./access.ts";
import { activityOperations } from "./activity.ts";
import { adjudicatorOperations } from "./adjudicator.ts";
import { affiliationOperations } from "./affiliation.ts";
import { agentOperations } from "./agent.ts";
import { agreementOperations } from "./agreement.ts";
import { agreementAcceptanceOperations } from "./agreement-acceptance.ts";
import { agreementCopyOperations } from "./agreement-copy.ts";
import { agreementRetentionOperations } from "./agreement-retention.ts";
import { aiOperations } from "./ai.ts";
import { aiCacheOperations } from "./ai-cache.ts";
import { allowanceOperations } from "./allowance.ts";
import { approvalOperations } from "./approval.ts";
import { assignmentOperations } from "./assignment.ts";
import { assistantOperations } from "./assistant.ts";
import { auditOperations } from "./audit.ts";
import { automationOperations } from "./automation.ts";
import { automationBindingOperations } from "./automation-binding.ts";
import { capacityOperations } from "./capacity.ts";
import { checklistOperations } from "./checklist.ts";
import { codeOperations } from "./code.ts";
import { connectedAppOperations } from "./connected-app.ts";
import { contentOperations } from "./content.ts";
import { countOperations } from "./count.ts";
import { customerOperations } from "./customer.ts";
import { customerSettingsOperations } from "./customer-settings.ts";
import { dashboardOperations } from "./dashboard.ts";
import { deviceSessionOperations } from "./device-session.ts";
import { duplicateOperations } from "./duplicate.ts";
import { enrichmentOperations } from "./enrichment.ts";
import { eraseRequestOperations } from "./erase-request.ts";
import { erasureOperations } from "./erasure.ts";
import { exportOperations } from "./export.ts";
import { extensionOperations } from "./extension.ts";
import { extensionAuthoringOperations } from "./extension-authoring.ts";
import { extensionUiOperations } from "./extension-ui.ts";
import { fieldOptionsOperations } from "./field-options.ts";
import { importOperations } from "./import.ts";
import { importRecordsOperations } from "./import-records.ts";
import { integrationOperations } from "./integration.ts";
import { inviteOperations } from "./invite.ts";
import { judgeOperations } from "./judge.ts";
import { meOperations } from "./me.ts";
import { mediaOperations } from "./media.ts";
import { mediaVideoOperations } from "./media-video.ts";
import { memoryOperations } from "./memory.ts";
import { myOperations } from "./my.ts";
import { myWriteOperations } from "./my-write.ts";
import { notificationOperations } from "./notification.ts";
import { notificationDeliveryOperations } from "./notification-delivery.ts";
import { orderOperations } from "./order.ts";
import { organisationOperations } from "./organisation.ts";
import { personOperations } from "./person.ts";
import { personLinkOperations } from "./person-link.ts";
import { personWithRecordOperations } from "./person-with-record.ts";
import { planOperations } from "./plan.ts";
import { policyOperations } from "./policy.ts";
import { publicReadOperations } from "./public-read.ts";
import { queryOperations } from "./query.ts";
import { recordOperations } from "./record.ts";
import { recordImportOperations } from "./record-import.ts";
import { recordVersionOperations } from "./record-versions.ts";
import { recurringOperations } from "./recurring.ts";
import { retentionOperations } from "./retention.ts";
import { routineOperations } from "./routine.ts";
import { routineMailOperations } from "./routine-mail.ts";
import { screenOperations } from "./screens.ts";
import { searchOperations } from "./search.ts";
import { settingsOperations } from "./settings.ts";
import { setupOperations } from "./setup.ts";
import { staffingOperations } from "./staffing.ts";
import { staffingFeedOperations } from "./staffing-feed.ts";
import { staffingHoursOperations } from "./staffing-hours.ts";
import { staffingPayOperations } from "./staffing-pay.ts";
import { staffingScreenOperations } from "./staffing-screens.ts";
import { staffingTimeOperations } from "./staffing-time.ts";
import { stateResolveOperations } from "./state-resolve.ts";
import { subscriptionOperations } from "./subscription.ts";
import { subscriptionOfferOperations } from "./subscription-offer.ts";
import { suggestionOperations } from "./suggestions.ts";
import { summaryOperations } from "./summary.ts";
import { supportOperations } from "./support.ts";
import { taskOperations } from "./task.ts";
import { timedMoveOperations } from "./timed-moves.ts";
import { trashOperations } from "./trash.ts";
import { updateOperations } from "./update.ts";
import { userOperations } from "./user.ts";
import { userEmailOperations } from "./user-email.ts";
import { viewOperations } from "./view.ts";
import { voiceOperations } from "./voice.ts";
import { waitlistOperations } from "./waitlist.ts";

// biome-ignore format: one spread per line keeps parallel additions conflict-free.
export const coreOperations = [
  ...personOperations,
  ...personWithRecordOperations,
  ...policyOperations,
  ...organisationOperations,
  ...affiliationOperations,
  ...trashOperations,
  ...userOperations,
  ...inviteOperations,
  ...userEmailOperations,
  ...activityOperations,
  ...taskOperations,
  ...viewOperations,
  ...auditOperations,
  ...searchOperations,
  ...queryOperations,
  ...importOperations,
  ...importRecordsOperations,
  ...exportOperations,
  ...recordOperations,
  ...recordVersionOperations,
  ...contentOperations,
  ...mediaOperations,
  ...mediaVideoOperations,
  ...recordImportOperations,
  ...extensionOperations,
  ...extensionAuthoringOperations,
  ...codeOperations,
  ...approvalOperations,
  ...connectedAppOperations,
  ...retentionOperations,
  ...countOperations,
  ...integrationOperations,
  ...enrichmentOperations,
  ...syncOperations,
  ...suggestionOperations,
  ...settingsOperations,
  ...dashboardOperations,
  ...extensionUiOperations,
  ...updateOperations,
  ...setupOperations,
  ...aiOperations,
  ...adjudicatorOperations,
  ...agentOperations,
  ...summaryOperations,
  ...automationOperations,
  ...automationBindingOperations,
  ...myWriteOperations,
  ...publicReadOperations,
  ...accessOperations,
  ...stateResolveOperations,
  ...timedMoveOperations,
  ...notificationOperations,
  ...notificationDeliveryOperations,
  ...assistantOperations,
  ...voiceOperations,
  ...a2uiOperations,
  ...memoryOperations,
  ...routineOperations,
  ...aiCacheOperations,
  ...planOperations,
  ...supportOperations,
  ...erasureOperations,
  ...eraseRequestOperations,
  ...judgeOperations,
  ...duplicateOperations,
  ...assignmentOperations,
  ...fieldOptionsOperations,
  ...customerSettingsOperations,
  ...routineMailOperations,
  ...deviceSessionOperations,
  ...customerOperations,
  ...meOperations,
  ...personLinkOperations,
  ...orderOperations,
  ...subscriptionOperations,
  ...subscriptionOfferOperations,
  ...myOperations,
  ...capacityOperations,
  ...recurringOperations,
  ...staffingOperations,
  ...staffingFeedOperations,
  ...staffingHoursOperations,
  ...staffingPayOperations,
  ...staffingTimeOperations,
  ...staffingScreenOperations,
  ...screenOperations,
  ...checklistOperations,
  ...allowanceOperations,
  ...waitlistOperations,
  ...agreementOperations,
  ...agreementAcceptanceOperations,
  ...agreementCopyOperations,
  ...agreementRetentionOperations,
] as const;
