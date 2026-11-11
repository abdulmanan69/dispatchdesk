Each `*.js` file here exports `jobs`: an array of maintenance jobs with the same shape as `JOBS` in ../maintenance.js:
`{ name, label, everyMs | dailyAtUtc, run(now) }`. They are loaded automatically at startup, run under a database lock,
and appear in Admin -> Setup -> Background jobs. Keep each run short and batched. Add `lane: 'priority'` for latency-sensitive jobs (reminders, reply detection):
they run on their own scheduler timer, so a long backup or crawl in the default lane never delays them.
