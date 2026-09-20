# PRD_SPEC: Echolet Modular Web/Desktop Chassis & 12-Skin Engine

```yaml
spec_metadata:
  feature_id: FEAT-WEB-SKINS-12
  version: 1.0.0
  status: approved
  date: 2026-09-19
  module: apps/web
  chassis_architecture: semantic-slot-matrix-v1
```

## Schema & Slot Contracts

| Slot ID | Canonical Slot Name | Primary Interface | Dynamic Capabilities |
|---|---|---|---|
| `SLOT_TOP` | TopDeck | Status & Skin Selector | Brand title, frequency readout, ping latency, skin dropdown |
| `SLOT_VIS` | VisDeck | Signal & Audio Visualizer | FFT Canvas, Analog VU, Optical dial, CRT Lissajous, OLED, Matrix Rain |
| `SLOT_CONTACTS` | ContactTuner | Channel & Peer List | Bakelite buttons, military tags, OP-1 dials, 8-bit directory, bento |
| `SLOT_CHAT` | MessageStream | Cryptographic Message Feed | Parchment, teletype stamps, ticker tape, glass bubbles, CRT text |
| `SLOT_INPUT` | TransmitDeck | Message Submission | Monospace input, ratchet advance trigger, transmit button |
| `SLOT_INSPECT` | HardwareInspector | Live Telemetry & Control | PreKey pool, rotary dials, EMP toggle, safety fingerprint, stream log |

## Skin Manifest Matrix (12 Skins)

```json
[
  { "id": "split-horizon", "category": "tactical", "vis": "fft-waterfall", "accent": "#00ff41" },
  { "id": "vintage-radiola", "category": "vacuum-tube", "vis": "needle-meter-magic-eye", "accent": "#ffaa33" },
  { "id": "military-r250", "category": "vacuum-tube", "vis": "optical-dial-voltmeter", "accent": "#4d7c0f" },
  { "id": "oscilloscope-crt", "category": "vacuum-tube", "vis": "crt-lissajous-green", "accent": "#22c55e" },
  { "id": "steampunk-brass", "category": "vintage-mechanical", "vis": "spark-gap-ticker", "accent": "#d97706" },
  { "id": "audiophile-hifi", "category": "vacuum-tube", "vis": "dual-vu-kt88", "accent": "#38bdf8" },
  { "id": "nordic-op1", "category": "modern-industrial", "vis": "oled-vector-waveform", "accent": "#f97316" },
  { "id": "system84-pc", "category": "retro-computing", "vis": "amber-crt-floppy-led", "accent": "#ffb000" },
  { "id": "nothing-glyph", "category": "modern-minimal", "vis": "glyph-led-strip", "accent": "#ffffff" },
  { "id": "cyberpunk-arasaka", "category": "modern-cyber", "vis": "glitch-ice-spectrum", "accent": "#fcee0a" },
  { "id": "matrix-1999", "category": "scifi-cinema", "vis": "digital-rain-canvas", "accent": "#00ff41" },
  { "id": "aerospace-glass", "category": "scifi-cinema", "vis": "topological-mesh-3d", "accent": "#38bdf8" }
]
```

## Formal Acceptance Criteria (Gherkin AI Verification)

```gherkin
Feature: WinAmp-style Modular Skin Engine

  Background:
    Given the companion server is running on "http://localhost:3001"
    And the cryptographic store is unlocked with valid credentials
    And the Signal Double Ratchet session is established with recipient "Bob"

  Scenario Outline: Skin Transformation Verification
    When the user triggers theme switch to "<skin_id>"
    Then the DOM root attribute "data-theme" must equal "<skin_id>"
    And the VisDeck slot must instantiate renderer "<expected_renderer>"
    And active canvas animation loops must not exceed 1 concurrent loop
    And message history count must match pre-switch state exactly

    Examples:
      | skin_id             | expected_renderer       |
      | split-horizon       | fft-waterfall           |
      | vintage-radiola     | needle-meter-magic-eye  |
      | military-r250       | optical-dial-voltmeter  |
      | oscilloscope-crt    | crt-lissajous-green     |
      | steampunk-brass     | spark-gap-ticker        |
      | audiophile-hifi     | dual-vu-kt88            |
      | nordic-op1          | oled-vector-waveform    |
      | system84-pc         | amber-crt-floppy-led    |
      | nothing-glyph       | glyph-led-strip         |
      | cyberpunk-arasaka   | glitch-ice-spectrum     |
      | matrix-1999         | digital-rain-canvas     |
      | aerospace-glass     | topological-mesh-3d     |

  Scenario: Zero Latency Message Continuity
    Given active input text "Mission control, status nominal"
    When the user cycles through 3 skins consecutively within 1 second
    Then the input field must retain "Mission control, status nominal"
    And triggering transmit must deliver ciphertext envelope to the relay
    And inbound delivery receipt must advance ratchet sequence monotonically
```
