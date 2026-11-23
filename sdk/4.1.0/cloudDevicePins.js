// cloudDevicePins.js — WHICH cloud-device enclave images this build hands a Space to (docs/cloud-device-enclave-plan.md § 4). A
// request goes only to an attestation naming one of these PCR0s (and role "clouddevice"), sealed to its key. EMPTY = the EC2
// prototype (plain, through the Space Lambda) — until the first enclave image is reproduced, logged and pinned here; an image
// rollover names two (new first), then narrows.
// cd5 (2026-11-17, 96afffbe): the cloud device's image as REPRODUCED — 460b4daf: built twice on a fresh host and by the build enclave
// (ba3), the same context (08d727c8). Narrowed 2026-11-18 to it alone (197266f5, what the first host built, runs nowhere; KMS opens
// for 460b4daf alone).
// cd7 (2026-11-18, aaa48807, 2b142dad — reproduced by the build enclave, a throwaway host and this host once its builder was fresh;
// the host first built cb790fd4 from a stale BuildKit builder, c0a6f94bf): a hosted-app account served as the hosted app; a split Space keeps only its user share, the app half asked
// per wake with the member's proof (cloud-device/apps.mjs). Rollover: cd7 first, cd5 until the switch has run; narrow at the next release.
// cd8 (2026-11-18, 9e8a2d45, bc8f09da): cd7 + the hosted app's vault in its egress (cd7 could not sign a hosted account in). Rollover:
// cd8 first, cd7 (running since 08:59Z) until the switch; cd5 runs nowhere (KMS dropped it).
// cd9 (2026-11-18, 655ddf95, f80f246b — reproduced twice on the host and by the build enclave, Rekor 3976675384): the image on Debian 13
// (trixie) — the Sentinel family's first; and the 11-18 sweep's scope rules (no lanes, no links, people counted for solo; a tick
// re-checks and lets go). Running since 2026-11-18 ~20:00Z; narrowed the same day to it alone (cd8 runs nowhere; KMS {cd9}).
// cd10 (2026-11-21, c3a286c3, 1c348ebf — reproduced twice on the host and by the build enclave, Rekor 4033371976): an attested
// Space can be kept always on (the device enrols in it as platform 'clouddevice', its key bound to this enclave's attestation);
// the 11-21 sweep's lane mark and kept-Space rules. Running since 2026-11-21 15:4xZ (end-to-end PASS); narrowed the same day to it alone (cd9 runs nowhere; KMS {cd10}).
// cd11 (2026-11-23, 275454ac, b2505169 — reproduced twice on the host and by the build enclave, Rekor 4050389884): it seals turns only to
// turn-enclave builds the owner accepted (the phone hands the account's list; a refused build makes the Space wait — docs/cloud-device.md
// § 4.9) and the 11-22 sweep's scope fixes. Switched with no Official release first — the apps followed its release record
// (followImage.js); end to end PASS, and the pause proven live. Narrowed the same day to it alone (cd10 runs nowhere; KMS {cd11}).
export const CLOUD_DEVICE_PCR0 = Object.freeze(['b250516990e99e3138236e994aa12cf33b0bf41307da0ac3f970d3a4929b8ef877c11e0f197a7dc70eeffedff9916f03'])
