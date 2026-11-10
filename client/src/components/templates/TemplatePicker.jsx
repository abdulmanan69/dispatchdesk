/**
 * Template picker (shared contract; the templates builder implements the full UI).
 *
 * <TemplatePicker channel="sms" | "email" category? carrierId? loadId? brokerId? extra?={…merge values}
 *   onPick={({ subject, body, template }) => …} size? />
 *
 * It lists the user's templates for the channel, renders the chosen one with merge fields filled through
 * POST /api/templates/render { channel, templateId, carrierId?, loadId?, brokerId?, extra? } -> { subject?, body },
 * and calls onPick with the rendered text. It never sends anything itself.
 */
export default function TemplatePicker() {
  return null;
}
