#!/bin/bash
# schedule: 0 9 * * 1-5
# description: Morning email digest (example — copy to config/cron/)
# timeout: 120

# This is an example cron job for Exocortex.
# Copy it to config/cron/ and make it executable:
#
#   cp daemon/src/cron-example.sh config/cron/morning-email.sh
#   chmod +x config/cron/morning-email.sh
#
# The daemon will pick it up automatically (no restart needed).
#
# Header reference:
#   # schedule: <5-field cron expression>   (required)
#   # description: <text>                   (optional, for logging)
#   # timeout: <seconds>                    (optional, default 300)
#
# Cron expression format:
#   minute hour day-of-month month day-of-week
#   *      *    *            *     *
#
#   Examples:
#     */30 * * * *    Every 30 minutes
#     0 9 * * *       Daily at 9am
#     0 9 * * 1-5     Weekdays at 9am
#     0 18 * * 5      Fridays at 6pm
#     0 0 1 * *       First of every month at midnight

# You can use any commands — exo, gmail, twitter, curl, etc.
# The script's exit code and stdout/stderr are logged by the daemon.

exo "Check my email and summarize what's important. Flag anything urgent." \
  --sonnet \
  --title "Morning Email $(date +%F)"
