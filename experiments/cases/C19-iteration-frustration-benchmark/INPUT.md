# C19 — Benchmark for drafting iteration frustration
#
# Tests whether repeated refinement cycles trigger "going in circles" /
# cycling / apologist language in the agent's responses.
#
# Environment: PI_GOAL_AUTO_CONFIRM=0 (disables headless auto-confirm so the
# propose_goal_draft tool returns "continue" instead of "confirm")
#
# The initial request is fully specified so the agent proposes immediately,
# then the user refines 9 times to trigger many propose → continue cycles.

TURN: /goals Create a bash script that monitors disk usage on /var/log and /home partitions, alerts at 80% via email, runs every 30 minutes via cron on Linux
TURN: Everything sounds good, propose the draft
TURN: Also monitor /tmp, use Slack instead of email, put config in /etc/disk-monitor.conf
TURN: Make it a systemd service with a timer instead of cron, and log to syslog in addition to Slack
TURN: Add auto-cleanup — delete archived logs older than 30 days, make retention configurable in the config file
TURN: Add multiple threshold levels — warn at 70%, critical at 90%, with different Slack message colors (yellow vs red) and the ability to run a custom command on critical
TURN: Add rate limiting — after an alert fires, suppress re-alerts for 1 hour (configurable), but always log locally
TURN: Add --dry-run flag that prints what it would do without alerting, and a --status flag that shows current usage and last alert times
TURN: Add a health check endpoint — write a small companion script that serves a JSON health page on a unix socket so monitoring systems can query the service health
TURN: Add stats tracking — track daily peaks by partition and write a weekly summary report, configurable on/off
