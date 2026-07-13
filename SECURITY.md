# Security policy

Segment is an early cryptographic prototype and has not received an independent
security audit. Do not rely on it for high-risk or life-critical communication.

Please do not publish suspected vulnerabilities in a public issue. Report them
privately through GitHub Security Advisories. A dedicated security email will be
added before public launch.

The server relays ciphertext but can observe metadata such as connection time,
IP address, room routing, and typing events. Message history is not stored by
the current server. TLS/HTTPS is still required in production in addition to
end-to-end encryption.
