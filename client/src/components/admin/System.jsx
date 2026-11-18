import { BackupPanel, JobsPanel } from './Setup.jsx';

/** Admin → Jobs & backups: database backups to make or download, and background job status with "Run now". */
export default function AdminSystem() {
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-medium">Database backups</h3>
          <p className="text-sm text-fg-2">A backup runs every day and the newest 7 are kept. Make one before a risky change, or download one to keep a copy off the server.</p>
        </div>
        <BackupPanel />
      </section>
      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-medium">Background jobs</h3>
          <p className="text-sm text-fg-2">Cleanup, reminders, payment checks and backups run on their own. Point at Failed to see the error; Run now starts a job at once.</p>
        </div>
        <JobsPanel />
      </section>
    </div>
  );
}
