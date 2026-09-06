# vhs script for the demo GIF: `vhs docs/demo.tape` writes public/demo.gif
#
# Prerequisites:
#   * vhs installed (https://github.com/charmbracelet/vhs)
#   * the server built (npm run build)
#   * a CalDAV server at 127.0.0.1:5232 with the integration fixtures:
#       docker compose -f test/integration/compose.yml up -d radicale
#       npx vitest run --config vitest.integration.config.ts
#     The suite leaves a calendar behind with a recurring event in it, which is
#     exactly what makes the expansion visible in three lines of output.
#
# Rules learned the hard way:
#   * inside Hide blocks use vhs's own `Sleep`, never the shell's — shell sleep
#     blocks and the tape ends before any output is recorded
#   * MCP meta-tools need `arguments: {}` explicitly; it cannot be omitted
#   * vhs cannot express a backslash-escaped quote inside a Type string, so any
#     jq filter here uses `@tsv` rather than string interpolation
#   * start from the running server, do not record the setup
#
# Width is 1200 on purpose: VitePress caps an image at max-width 100% and does
# nothing else, so a recording narrower than the 1152px content column renders at
# its natural size and stops short of the right edge, next to a diagram that
# fills it. custom.css pins the width regardless; being oversized is the belt.

Output docs/public/demo.gif

Set FontSize 16
Set Width 1200
Set Height 640
Set Padding 20
Set Theme "Catppuccin Mocha"

Hide
Type "export CALDAV_URL=http://127.0.0.1:5232 CALDAV_USERNAME=integration CALDAV_PASSWORD=integration-not-a-secret CALDAV_TIMEZONE=Europe/Berlin" Enter
Type "clear" Enter
Sleep 500ms
Show

Type "# the calendars this server may use" Enter
Sleep 800ms
Type "npx -y @modelcontextprotocol/inspector --cli node dist/index.js --method tools/call --tool-name list_calendars | jq -r '.structuredContent.calendars[].id'" Enter
Sleep 7s

Type "" Enter
Type "# a weekly meeting, expanded into its occurrences" Enter
Sleep 800ms
Type "npx -y @modelcontextprotocol/inspector --cli node dist/index.js --method tools/call --tool-name list_events --tool-arg from=2026-09-01T00:00:00Z --tool-arg to=2026-10-15T00:00:00Z | jq -r '.structuredContent.events[] | [.start.value, .summary] | @tsv'" Enter
Sleep 9s
