# Runbook — ASR provider outage

Deepgram is unreachable or degraded. Testers cannot talk, or can talk and get nothing back.

## What exists today

The pipeline is complete (Phase 9) and every state, buffer bound and backoff figure below is in
`apps/extension/src/voice/`. Two things are **not** built and change what you can do:

- **There is no gateway-side ASR credential.** `apps/gateway/src/routes/` contains `memory.ts`,
  `resolve.ts` and `sessions.ts`; there is no token route. The service worker's `mintToken` is
  `() => Promise.resolve(__WISPR_ASR_TOKEN__ === '' ? null : __WISPR_ASR_TOKEN__)`
  (`apps/extension/src/background/main.ts`) — a **build-time define**, populated for local
  development and empty otherwise. The comment says so: *"Production mints a short-lived one from
  the gateway (a later phase); until then this truthfully reports no token."* So there is no
  credential to rotate centrally, and a production build ships with voice reporting `no_token`.
- **Nothing collects the voice metric.** `wispr_speech_to_partial_ms` is measured in the pipeline
  and emitted to the service worker, which writes it as a structured log line
  (`voice.metric`, with `metric` / `value_ms` / `unit`). It is **not** forwarded to the gateway or
  to OTLP. There is no ASR metric in any collector. `wispr_speech_to_reticle_ms` from
  `docs/ARCHITECTURE.md § 7` does not exist at all — the only thing that measures it is the
  `bench:speech-to-reticle` benchmark, which is report-only in CI
  ([ADR 0014](../adr/0014-benchmarks-report-only-in-ci.md)).

The consequence: **an ASR outage is invisible to us and visible only to testers.** There is no
alert to receive. You will learn about this from a person.

---

## Symptoms

Everything a tester can see is one of six phases (`VoicePhase`, `apps/extension/src/voice/messages.ts`).
Learn these — the phase in the HUD *is* the diagnosis:

| Phase | HUD | Means |
|-------|-----|-------|
| `idle` | not listening | microphone closed |
| `connecting` | opening | the socket is being opened; speech is being buffered |
| `listening` | live | connected, VAD gating, frames on the wire |
| `reconnecting` | reconnecting | the socket dropped; backing off, buffering |
| `dropped` | **"Audio dropped"** (drift tone) | the 3 s buffer overran — audio was lost, and the tester is told |
| `error` | error | fatal; carries a `VoiceErrorReason` |

`VoiceErrorReason` is a closed set: `mic_denied`, `mic_unavailable`, `no_token`, `asr_failed`,
`internal`. Only two of those are the provider's fault.

What an outage looks like, in order of what a tester reports:

- **"It says audio dropped."** The socket is down and the reconnect outran the 3 s buffer. The
  tester lost speech and was told, which is the design — `reconnect.ts` returns a boolean from
  `push()` specifically so a drop can never be silent.
- **"It just spins on reconnecting."** The socket is closing repeatedly. Provider degraded rather
  than down.
- **"It gave up."** `asr_failed` — six reconnect attempts exhausted.
- **"Nothing happens when I hold the key."** `no_token`. Not an outage. See below; today this is
  the *expected* state of any build without a baked-in token.
- **Partials arrive but late.** The provider is up and slow. Nothing in the pipeline times this
  out; `MODEL_TIMEOUT_MS` on the gateway governs T2 escalation, not ASR.

### The timing, so you can tell these apart

`DEFAULT_BACKOFF` is `baseMs 250, factor 2, maxMs 8000, jitter 0.2`, and
`DEFAULT_MAX_RECONNECT_ATTEMPTS` is 6. So the delays are roughly 250 ms, 500 ms, 1 s, 2 s, 4 s,
8 s — about **16 seconds** of `reconnecting` before `asr_failed`, ±20% jitter.

The ring buffer holds **3 s** of speech (`DEFAULT_BUFFER_MAX_MS = 3000`, at `frameMs = 20`, so 150
frames, drop-oldest). Against a 16-second reconnect window that means **`dropped` appears about
three seconds in, and `error` about thirteen seconds after that.** A tester who reports "audio
dropped" is describing a partial outage; one who reports "it gave up" waited a quarter of a minute.
Both are the same failure at different depths.

Jitter is not decoration: it spreads the reconnect storm when the provider blips for every tester
at once.

---

## Confirm

### 1. Is it the provider, or is it one tester?

The pipeline has no server side, so there is nothing of ours to check first. Check Deepgram's
status page, then reproduce:

```bash
# The same URL the client builds (apps/extension/src/voice/deepgram-asr.ts, buildUrl).
# The key travels as a subprotocol, never in the URL — it would land in access logs there.
websocat -H= --protocol 'token,<key>' \
  'wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&model=nova-2&language=en-US&interim_results=true&endpointing=300'
```

If that connects and the extension does not, it is not the provider.

### 2. Read the close code

`onClose` reports `code`, `reason` and `wasClean` (`streaming-asr.ts`), and the distinction between
an orderly close and a drop is the whole reason the callback carries `wasClean`. The pipeline only
reconnects from `listening`, `connecting` or `reconnecting`; a close in any other phase is left
alone.

A `1006` with no reason is a transport drop — network, proxy, TLS interception. A `4xxx`
application close usually carries a reason string, and an auth rejection appears here rather than
as an HTTP status, because the credential is a WebSocket subprotocol.

### 3. Is it the credential rather than the provider?

Today this is the most likely answer, because there is no credential path in production.

`no_token` means `mintToken` returned null — the build had an empty `__WISPR_ASR_TOKEN__`. The
offscreen document *refuses to open a socket without one* and the HUD is shown a truthful error
rather than a microphone that opens and streams nowhere. That is deliberate
(`apps/extension/src/background/voice-controller.ts`).

An invalid or expired token is different: the socket opens and is closed by the provider, so it
presents as `reconnecting` → `asr_failed`, not as `no_token`. **A rejected credential and a dead
provider are indistinguishable from the HUD.** Step 1 is what separates them.

### 4. Is it the microphone rather than the network?

`mic_denied` (the tester declined the permission) and `mic_unavailable` (no input device, or
`getUserMedia` not available) are local and are not this runbook. Note that capture lives in an
offscreen document because `getUserMedia` does not exist in a service worker
([ADR 0001](../adr/0001-in-process-mv3-runtime.md)); if the offscreen document fails to be created
the failure surfaces as `internal`, not as a microphone error.

### 5. Read the logs

Extension log lines are structured JSON in the same shape as the services'
(`apps/extension/src/log.ts`). The ones that matter:

- `voice.metric` — `wispr_speech_to_partial_ms` for an utterance. Rising values with the socket up
  is a degraded provider.
- The voice controller's `onError` writes a `warn` line with a `detail` field for anything it
  recovered from.

There is no server-side log for any of this. The gateway never sees an ASR frame.

---

## Immediate mitigation

**There is no failover. Say that plainly to whoever is asking.** The provider is a single
configured endpoint, and switching providers is a code change, not a runtime one — see *Prevention*.

### Tell testers what the phases mean

The most useful immediate action is usually communication. `dropped` means "the words you just
said were lost, say them again"; `reconnecting` means "wait". Testers who understand the two do not
lose work; testers who do not will repeat an utterance into a dead socket and then wonder whether
it executed. There is no risk of a stale utterance executing later — `stop()` on a non-open socket
goes straight to `idle` and the buffer is cleared — but the tester does not know that.

### Nothing else is at risk

Voice failure degrades cleanly to nothing. The extension stays attached, the HUD stays up, memory
is still loaded, and no action is dispatched from a hypothesis that never arrived. There is no
partial-execution hazard here: the speculation controller acts on hypotheses, and an outage
produces none. Do not detach the extension or clear memory as a remedy — that costs the tester
their snapshot and fixes nothing.

### If it is the credential

Rebuild with a valid `__WISPR_ASR_TOKEN__` and reload the unpacked extension. That is a developer
action on a developer machine and it is the only credential path that exists today.

### Do not raise the buffer or the attempt count as a workaround

`bufferMaxMs` and `maxReconnectAttempts` are both injectable. Raising the buffer past 3 s means a
tester speaks for longer into nothing and gets a transcript back for words they said ten seconds
ago, which is worse than being told the audio was lost. Raising the attempt count extends the time
before the tester is told the truth. The phase requirement is verbatim: *"never silently lose
audio."*

---

## Root-cause investigation

**Repeated `1006` closes with the provider healthy.** Something between the browser and Deepgram
is terminating the socket: a corporate proxy that does not pass WebSocket upgrades, TLS
interception, or an idle timeout shorter than the KeepAlive. The client sends
`{"type":"KeepAlive"}` every 5 s by default (`DEFAULT_KEEPALIVE_MS`) precisely to stop an idle
socket being closed while a tester pauses; a middlebox with a shorter idle timeout defeats it.
This is the most common enterprise-network cause and it will look like a provider outage.

**Verify the extension is permitted to reach the provider at all.** `manifest.ts` sets
`host_permissions: ['<gateway-origin>/*']` and nothing else, and no test in the repository opens a
real socket to Deepgram — `deepgram-asr.test.ts` drives a fake. Whether the offscreen document's
WebSocket to `wss://api.deepgram.com` needs a host permission entry is not settled by anything in
this codebase, and it is worth verifying against a production-mode build before concluding the
provider is at fault.

**Audio arrives but transcripts are empty or wrong.** Check the format contract before blaming the
provider. `StreamingAsr` requires 16 kHz mono PCM16, which is exactly what the framer produces;
`buildUrl` declares `encoding=linear16&sample_rate=16000&channels=1`. A mismatch between the
declared and the actual format produces a healthy socket and garbage output.

**Utterances finalize too early or too late.** `endpointingMs` is 300 ms by default and is
Deepgram's silence threshold, not ours. A tester who pauses mid-sentence gets an early final; one
in a noisy room may not get one at all. This is per-deployment configuration in
`DEFAULT_VOICE_SETTINGS`, and it is the first knob to reach for on "it cuts me off".

**No partials at all, only finals.** Valid per the provider contract — `streaming-asr.ts` says a
provider that only returns finals is still valid, and the pipeline simply has no interim to
speculate on. The product still works; it loses the speculative execution that buys the 400 ms
budget. If this appears with Deepgram it means `interim_results=true` is not being honoured.

**The `dropped` state with the socket apparently up.** `pushFrame` buffers whenever the phase is
not `listening` *or* the socket is not open. A socket in `CONNECTING` for a long time produces the
same overrun as one that is down. Check the phase, not just the socket.

**A metric that never appears.** `wispr_speech_to_partial_ms` is recorded only on the *first*
partial of an utterance, and `onsetAt` is set by the VAD deciding a frame is speech. A VAD whose
noise floor has adapted to a loud room will gate everything, so the absence of the metric can mean
"the microphone heard nothing it considered speech" rather than "ASR is down".

---

## Prevention

- **Build the gateway credential route.** It is the largest gap here. A short-lived, per-session,
  centrally-revocable token is what turns "rebuild the extension" into an operation, and it is
  what `voice-controller.ts` is already written against — `mintToken` is injected precisely so the
  real implementation drops in.
- **Forward `wispr_speech_to_partial_ms` to telemetry.** The seam exists (`onMetric` in the service
  worker) and today it writes a log line. Until it reaches a collector there is no way to see a
  degraded provider except by asking testers.
- **Add a second provider before you need one.** `StreamingAsr` is deliberately shaped so a second
  provider is one file and a config change, not a pipeline rewrite — `AsrProviderConfig.provider`
  is a discriminator with one member today. The failover story does not exist until a second
  implementation does, and writing one during an outage is not the time.
- **Alert on phase distribution once the metric ships.** A rise in `reconnecting` and `dropped`
  across many testers is the signal; a single tester is a network.
- **Do not let `endpointingMs`, `bufferMaxMs` or the backoff become per-customer settings.** They
  are per-deployment configuration in one record for a reason ([ADR 0011](../adr/0011-learned-not-configured.md));
  the moment they are tuned per account, every support conversation starts with "what are their
  settings".
- **Test against a real socket somewhere.** Everything in CI drives a fake. That is correct for
  determinism and it means no automated check would notice if the URL, the subprotocol handshake
  or the permission model broke.
