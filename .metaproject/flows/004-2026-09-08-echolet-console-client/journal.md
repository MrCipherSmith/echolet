# Flow Journal

- 2026-09-08T23:00:34.327Z - flow created
- 2026-09-08T23:01:19.049Z - frozen: 10 criteria; checksum recorded
- 2026-09-08T23:01:23.387Z - started
- 2026-09-08T23:01:27.884Z - task-added: T5: RED tests for the two CLI prerequisites: send takes its body on stdin, doctor enumerates correspondents
- 2026-09-08T23:01:30.095Z - task-added: T6: Implement the two CLI prerequisites, keeping the command surface at eight commands
- 2026-09-08T23:01:45.348Z - task-depends-set: T6: dependsOn T5 (was T1) — The implementation must follow the RED tests in T5, not the boilerplate context task T1 that flow init created.
- 2026-09-08T23:01:47.199Z - task-attempt: T5: started (attempt 1) — Dispatching an independent tests-creator. RED is required before any implementation is written; the implementer will be a different agent and will not accept its own work.
- 2026-09-08T23:16:09.395Z - ac-updated: AC3 as I froze it required removing --text. That would break nine call sites in the operator's own live prototype scripts (echolet-try.sh and the depr peer wrapper), which is outside this wave's authority and contradicts the design it implements. AC3 now requires the stdin path and a clean console argv, keeps --text, and records its retirement as an open decision for the user. No confirmations existed to void.
