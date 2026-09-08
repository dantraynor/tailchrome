# Split DNS (restricted nameservers)

Tailchrome uses the restricted nameserver configuration supplied by Tailscale or Headscale to resolve internal domains. Both the browser extension and native helper must include split DNS support. No per-domain settings are needed in the extension.

For example, if your control server configures `internal.example.com` to use `192.168.1.53`, requests for `internal.example.com` and `app.internal.example.com` go through the helper. The helper queries Tailscale's embedded DNS resolver, then connects to the returned IP through tsnet. Other domains keep their existing routing and resolution behavior.

## Setup

1. Configure a restricted nameserver for your domain in your Tailscale DNS settings or Headscale server configuration.
2. Ensure the nameserver and the service IPs are reachable from Tailchrome's node. For LAN IPs, approve the subnet route and allow access under your tailnet policy.
3. Keep **MagicDNS** enabled in Tailchrome's quick settings. This toggle controls acceptance of the control plane's DNS configuration (`corpDNS`), including restricted nameservers.
4. Open the internal service by its full hostname, such as `https://app.internal.example.com`.

An exit node is not required. Restricted domains take precedence over Tailchrome's exit-node **Bypass** and **Only** domain rules. When an exit node is selected, Tailscale's embedded resolver applies the control plane's DNS policy for that exit node, including whether a restricted nameserver is allowed to remain in use.

## Scope and troubleshooting

- Support applies to browser traffic routed through the helper. Tailchrome does not change system DNS or resolve names for other applications.
- Nameserver addresses and domain restrictions are managed on the control server. This feature does not add a global nameserver override or a DNS configuration editor to the extension.
- The helper pins tsnet `v1.103.0-pre.0.20260819151608-90ed0bcf4bc2`, which includes Tailscale's [UDP forwarding fix](https://github.com/tailscale/tailscale/pull/20786) and the security fixes from v1.102.3. Both UDP and TCP DNS queries follow tsnet's routes, preventing a resolver on an overlapping local LAN from answering queries intended for a subnet resolver. Allow **UDP and TCP port 53** on the nameserver and under your tailnet policy; UDP-only nameservers work for responses that do not require TCP after truncation.
- A failed restricted-domain lookup returns an error; the helper does not retry that hostname using system/public DNS.
- Domain changes and removals update browser routing automatically. Turning off the MagicDNS setting disables restricted-domain routing.

Tailscale describes restricted nameservers and subnet reachability in its [DNS documentation](https://tailscale.com/docs/reference/dns-in-tailscale).

## Manual verification with Headscale or Tailscale

1. With no exit node selected, confirm the internal service is reachable by its LAN IP.
2. Open the same service by full hostname and check your DNS server's query log. The request should resolve through the configured nameserver and reach the service. Test HTTPS as well as HTTP if both are available.
3. Test an IPv6-only record or a CNAME alias if your internal DNS provides one.
4. Request a nonexistent name under the restricted domain. It should fail without a fallback query to system/public DNS.
5. Change or remove the restricted domain on the control server and confirm browser routing updates after the new configuration arrives.
6. Disable and re-enable the MagicDNS setting, then switch profiles if available. Domains from the previous profile should not remain active.
