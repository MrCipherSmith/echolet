# PRD: Modular Echolet Web/Desktop Client with WinAmp-style Skin Architecture (12 Skins)

## 1. Overview
Echolet Web is a companion web and desktop client for secure peer messaging running on top of the Signal Protocol cryptographic engine (Double Ratchet E2EE). This specification defines a modular WinAmp-inspired chassis architecture (fixed semantic slots) and integrates 12 fully articulated stylistic themes (skins) — ranging from 1950s vacuum tube radiolas and 1980s personal workstations to Scandinavian industrial minimalism (Teenage Engineering OP-1) and cinematic sci-fi (The Matrix, Blade Runner 2049, Interstellar) with zero-reload dynamic switching.

## 2. Context
- **Product:** Echolet (Secure Decentralized Radio Messenger)
- **Module:** `apps/web` (@echolet/web)
- **User Role:** Radio amateurs, secure communications operators, privacy enthusiasts, retro-computing fans
- **Tech Stack:** React 19, TypeScript 5.8, Node.js 22.13 (ESM Companion Server), esbuild, Server-Sent Events (SSE), Canvas / SVG

## 3. Problem Statement
Text-based TUI interfaces and generic web messaging clients either suffer from severe ergonomics limitations (keyboard layout locking, absence of mouse interactions) or lack emotional resonance and industrial design identity. Monolithic one-off redesigns risk duplicating protocol logic, fracturing the cryptographic core, and introducing regression bugs.

## 4. Goals
- **G-1:** Implement a strict WinAmp-style Semantic Chassis where geometry and functional component slots are standardized across all visual representations.
- **G-2:** Deliver 12 fully functional skins:
  1. *Split-Horizon (Tactical HUD)*
  2. *Vintage Radiola 1950s (Telefunken/Rigonda)*
  3. *Soviet Military Transceiver R-250*
  4. *CRT Oscilloscope Lab*
  5. *Victorian Steampunk Telegraph*
  6. *Audiophile Hi-Fi Tube Amplifier (McIntosh/Luxman)*
  7. *Nordic Minimalist (Teenage Engineering OP-1)*
  8. *Workstation System-84 (1980s IBM/Macintosh era)*
  9. *Nothing Glyph / Dot-Matrix Minimal*
  10. *Cyberpunk 2077 Arasaka HUD*
  11. *The Matrix 1999 (Nebuchadnezzar Operator)*
  12. *Aerospace Glassmorphic Mesh (Sci-Fi 2010s)*
- **G-3:** Guarantee 0ms hot skin switching preserving input buffers, open chat sessions, and live cryptographic telemetry.

## 5. Non-Goals
- Direct trademark infringement or copying of proprietary logos (Apple, IBM, McIntosh, Warner Bros). All inspirations must be legally safe synthetic homages.
- In-browser reimplementation of native Signal Rust libraries (handled securely by the local Node companion process).
- Free-form floating window drag-and-drop in release 1.0 (maintaining a robust 3-column chassis).

## 6. Functional Requirements
- **FR-1 (Semantic Chassis):** Fixed viewport divided into 5 standard slots: `TopDeck`, `VisDeck`, `ContactTuner`, `MessageStream & Transmit`, `HardwareInspector`.
- **FR-2 (Skin Selector):** A top-level selector allows switching between any of the 12 skins instantly with persistence in `localStorage`.
- **FR-3 (Dynamic Vis Deck):**
  - Skins 1, 10: Live FFT Waterfall spectrum analyzer.
  - Skins 2, 6: Analog needle VU/S-meter with ballistics animation & 6E5S magic eye tuning indicator.
  - Skin 3: Optical projection circular frequency scale & Cyrillic dials.
  - Skin 4: Circular green phosphor CRT oscilloscope with Lissajous RF curves.
  - Skin 5: Electric spark gap tube and punched paper ticker tape.
  - Skin 7: Monochrome OLED vector waveform display (OP-1 style).
  - Skin 8: Amber monochrome CRT with scanlines, blinking block cursor, and `[DRIVE A: BUSY]` LED.
  - Skin 9: Pulsing LED dot-matrix Glyph strip.
  - Skin 11: Real-time falling green Matrix digital rain on HTML5 Canvas.
  - Skin 12: Interactive 3D mesh network topology route map.
- **FR-4 (Message Card Polymorphism):** Adapts visual message presentation (parchment, punched ticker tape, secret military teletype, matte Nordic pill bubbles, amber CRT lines).
- **FR-5 (Telemetry Fidelity):** Right-hand inspector maintains live PreKey count, latency ping, and Double Ratchet state across all skins.

## 7. Non-Functional Requirements
- **NFR-1 (Latency):** Skin switching must complete in < 16ms (60 FPS) without document reloads.
- **NFR-2 (Security Enclave):** Signal private keys and SQLite credentials remain strictly isolated within local Node.js memory.
- **NFR-3 (Animation Teardown):** Canvas animation loops (`requestAnimationFrame`) properly unsubscribe on theme change to prevent memory leaks.

## 8. Constraints
- Compatible with Node.js >= 22.13.
- Modern browser support (Chrome, Safari, Firefox).
- Theming cleanly scoped via `[data-theme="..."]` CSS attributes.

## 9. Edge Cases
- **EC-1 (Relay Downtime):** Analog needle drops to 0, digital displays indicate `OFFLINE / NO CARRIER`.
- **EC-2 (Oversized Message Payload):** Ticker tape and parchment bubbles wrap lines gracefully without horizontal scrolling.
- **EC-3 (Rapid Switching):** Rapid user toggling through all 12 themes causes zero memory leaks or orphaned canvas contexts.

## 10. Acceptance Criteria (Gherkin)
```gherkin
Scenario: Switch to Nordic OP-1 Skin
  Given the user navigates to http://localhost:3001
  When the user selects "Nordic Minimalist (OP-1)" in the skin selector
  Then the interface immediately assumes the light-gray Scandinavian textured appearance
  And the VisDeck slot renders the monochrome vector waveform
  And message history and contact selections are fully preserved

Scenario: Switch to The Matrix Skin
  Given an active session between Alice and Bob
  When the user selects "The Matrix (1999)"
  Then the VisDeck background initializes the green digital rain canvas animation
  And messages are styled as intercepted pirate terminal streams
  And cryptographic ratchets remain continuous

Scenario: Outbound Transmission on Soviet R-250 Skin
  Given the active skin is "Soviet Military Transceiver R-250"
  When the user submits a message "Radio check"
  Then the message is posted with a stamped red "[СЕКРЕТНО]" seal and "[DELIVERED]" badge
  And the analog signal needle performs a transient transmission deflection
```

## 11. Verification
- **Build Verification:** `pnpm web:build` succeeds with 0 errors.
- **Visual Smoke Test:** Switch through all 12 skins on `http://localhost:3001` and `http://localhost:3002`.
- **End-to-End Cryptographic Test:** Bidirectional send/receive verification with live Double Ratchet key advancement.
