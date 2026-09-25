# Android release signing transition

[简体中文](SIGNING-TRANSITION.md) | **English**

Starting with **0.5.0-2**, public Android builds use a separate release key. The debug key
used for earlier internal testing is no longer used for public releases.

**If you have an internal test build, keep it installed. Do not uninstall it or clear its
data just to install this version.** Android rejects in-place updates with a different signer.
Uninstalling may delete local transcripts, recordings, and configuration. This release
does not automatically migrate that data or replace your installed test build. The old
app remains usable. Contact the maintainer to arrange data preservation before migration.

New users can install the public APK normally. Future versions signed with the same release
key can update it in place. QR codes transfer connections only, not history or recordings.
Windows and iOS are unaffected by this Android signing change.
