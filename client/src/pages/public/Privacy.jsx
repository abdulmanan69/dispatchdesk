export default function Privacy() {
  return (
    <article className="prose-dd mx-auto max-w-3xl px-4 py-14 text-[15px]">
      <h1>Privacy Policy</h1>
      <p className="text-muted">Template for operators of this software. Adapt it to your jurisdiction and have it reviewed before production use.</p>
      <h2>What we store</h2>
      <ul>
        <li>Account data: name, email, phone, profile photo, preferences.</li>
        <li>Workspace data you create: carriers, contacts, notes, calls, emails, documents, brokers and loads.</li>
        <li>Security data: hashed passwords (bcrypt), session records, audit logs.</li>
        <li>Integration credentials (mailbox passwords and OAuth tokens), encrypted with AES-256-GCM.</li>
      </ul>
      <h2>How data is isolated</h2>
      <p>Each dispatcher’s pipeline is private. Team owners and managers can see team members’ data only when the team’s permissions allow it. AI requests only include the requesting user’s own data.</p>
      <h2>Third parties</h2>
      <p>Data is sent to third parties only when you enable an integration: your email provider (to send email), your configured AI provider (for AI features), Stripe (for payments), and the search provider (for AI web research).</p>
      <h2>Your rights</h2>
      <p>Export all of your data as JSON or delete your account at any time from Settings → Data.</p>
      <h2>Email recipients</h2>
      <p>Outreach emails include an unsubscribe link. Unsubscribed addresses are added to the sender’s suppression list and are not emailed again by the system.</p>
    </article>
  );
}
