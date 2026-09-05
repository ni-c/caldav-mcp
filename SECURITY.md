# Security policy

<!-- Template. Placeholders: {{REPO}}. Replace the trust-model section with what is
     actually true for this server — the point of it is to tell an operator what an
     attacker gains by compromising the credentials it holds. Examples:
       wg-easy-mcp: admin credentials = full VPN access; configs and QR codes contain
                    private keys.
       hetzner-dns-mcp: the token can rewrite every zone in the Hetzner project, which
                    means mail routing and certificate issuance.
     Delete this comment when applying. -->

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ni-c/{{REPO}}/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include real
credentials, tokens, hostnames or private configuration in a report.

You can expect an initial response within a week. Fixed vulnerabilities are published
as a new release with a note in the CHANGELOG.

## Supported versions

Only the latest release and the current `main` branch receive security fixes.

## Trust model

{{WHAT_THE_CREDENTIALS_GRANT}}

Treat every environment variable this server reads as a secret. The MCP client
process, and therefore the model driving it, sees every tool result — do not point
this server at a system whose data you would not put in a model's context.

Destructive operations **ask a person** through MCP elicitation: a dialog raised by
the server and shown by the client, which the model cannot answer on its behalf, and
which nothing proceeds without. Where the client cannot show one they fall back to a
server-generated token bound to the specific target — which proves the call was made
twice with the same arguments and nothing more, and the fallback text says so rather
than implying somebody approved. `ELICITATION=false` moves a capable client onto that
fallback deliberately; it does not remove the guard, and the server prints one line
at startup saying it is off.

Data returned from the upstream API is untrusted input: it is marked as such, and
confirmation prompts never quote it.
