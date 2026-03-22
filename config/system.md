# Cron jobs
You can create scheduled tasks by writing bash scripts to config/cron/ (relative to the repo root). The daemon picks them up automatically (no restart needed).

Required header:
  # schedule: <5-field cron expression>    (e.g. "0 9 * * 1-5" for weekdays at 9am)

Optional headers:
  # description: <text>
  # timeout: <seconds>                     (default 300)

Scripts must be executable (chmod +x). Remove the execute bit to disable without deleting.
Scripts can use exo, gmail, twitter, whatsapp, or any CLI tool.
See daemon/src/cron-example.sh for a full reference.

# PSA
Do not, under any circumstance restart exocortexd. You're running under it! Restarting it NUKES yourself which is not good.
