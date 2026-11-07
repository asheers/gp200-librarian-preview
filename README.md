# GP200 Librarian (TEST)

A browser-based patch librarian for the Valeton GP-200 (Web MIDI with SysEx, Chrome or Edge).
This repository holds only the published files of version 0.13.0, built from source commit
`71764ac`. Licence: GPL-3.0-only (see LICENSE and ATTRIBUTION.md).

**TEST build: not the live release.**

TEST and LIVE share the `asheers.github.io` origin, so they share browser storage (history, templates,
settings, the backup folder) and the MIDI and folder permissions. Connect only one Librarian to the
GP-200 at a time, and close Chocolate Controller before any write.

**Known limit:** Copy and Move take up to 16 selected patches. A 16-patch Copy has been tested on a real GP-200.
A 16-patch Move (32 writes) has automated coverage on a simulated pedal only; the Moves tested on real hardware were smaller.
