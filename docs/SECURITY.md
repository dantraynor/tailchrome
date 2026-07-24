# Security Policy

## Supported Versions

Only the latest release is supported with security updates.

## Reporting a Vulnerability

Please report security vulnerabilities by emailing admin@tesseras.org.

Do **not** open a public issue for security vulnerabilities.

We will acknowledge your report within 48 hours and aim to release a fix for critical issues within 7 days.

## Local Proxy Trust Boundary

The helper exposes its SOCKS5/HTTP proxy only on a randomly assigned `127.0.0.1` port. Browser proxy APIs do not support attaching authentication credentials to PAC/listener-selected SOCKS connections, so the listener itself is unauthenticated.

On a normal single-user workstation, the loopback binding prevents remote access and the random port limits accidental discovery. On a shared machine, another process running as any local user may be able to discover the listening port and use the browser profile's tailnet access. Tailchrome should therefore be installed only on machines where local users and processes are trusted; use separate OS accounts or a dedicated machine for mutually untrusted users.
