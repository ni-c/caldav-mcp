# Security

This page is the prose version of [SECURITY.md](https://github.com/ni-c/caldav-mcp/blob/main/SECURITY.md).

## Trust model

## The confirmation, honestly

<!-- What asks and why. Then, in this order and in these words:
     - where the client supports elicitation, a person sees a dialog the model
       cannot answer on its behalf, and nothing happens until they answer;
     - where it does not, a single-use token bound to the exact target;
     - what that token proves: the call was made twice with the same arguments,
       and NOTHING MORE. Never "a model cannot satisfy that gate on its own".
     - ELICITATION=false takes the fallback deliberately and never removes the
       guard.
     Then link /guide/approval, which carries the detail. -->

## Untrusted content

## Reporting a vulnerability

Use [private vulnerability reporting](https://github.com/ni-c/caldav-mcp/security/advisories/new).
