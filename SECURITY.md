# Security policy

Segment is an early cryptographic prototype and has not received an independent
security audit. Do not rely on it for high-risk or life-critical communication.

Please do not publish suspected vulnerabilities in a public issue. Report them
privately through GitHub Security Advisories. A dedicated security email will be
added before public launch.

The server relays and stores ciphertext but can observe metadata such as
connection time, IP address, room membership, routing, typing events and payload
sizes. Private-room history and attachments are persisted as client-encrypted
data. New attachment downloads use unguessable bearer capabilities carried only
inside encrypted message envelopes; physical content hashes are not download
credentials. Public channels use a server-distributed history key: their transport is
encrypted, but their history is not confidential from the service. TLS/HTTPS is
still required in production in addition to end-to-end encryption.

Live sender keys are scoped to one room and one persisted membership epoch.
Membership changes replace current sender and history keys, and the relay rejects
stale-epoch key shares, live ciphertext and history writes. Sender-key messages
are signed and cryptographically bind the room, epoch, sender and counter.

Device identity keys persist locally as non-extractable WebCrypto keys. The
service pins the first identity registered for a device, while clients remember
the first identity observed for each peer. Silent changes are blocked, and a new
device for an already known account raises a visible warning. Pins are encrypted
at rest with a non-extractable browser key. This is TOFU, not key transparency:
a malicious service can still substitute keys on first contact or present a new
device until the user compares the per-device safety number shown in the profile.

This hardening has not been independently reviewed and is not a claim of Signal
or MLS compatibility.
