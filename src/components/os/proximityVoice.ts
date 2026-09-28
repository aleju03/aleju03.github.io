import * as THREE from 'three'
import { sharedAudio } from '../../game/core/sfx'
import type { PlayerId, VoiceSignal } from '../../game/net/protocol'
import type { RemotePlayer } from '../../game/net/remotePlayers'
import { createVoiceFx, type VoiceFilter } from './voiceFilters'

/*
  Proximity voice: a WebRTC mesh between the browsers standing near each
  other, with the server relaying nothing but the handshake. No audio ever
  touches the VPS, which is the whole reason this is affordable to run — and
  the reason it is here rather than in server/.

  The ICE servers come from the server at join rather than being compiled in
  here, because a TURN credential has to expire to be safe to hand a browser.
  With STUN only — the default — a pair of visitors both behind symmetric NATs
  cannot find a path to each other: they still see everyone, hear the world and
  can type, they just stay silent to that one peer. Configure TURN_URLS on the
  server and those calls route through the relay instead.

  Distance is done in WebAudio, not in the protocol. Each peer's incoming
  stream lands on its own PannerNode, the listener rides the camera, and the
  inverse distance model does the rest — so a voice comes from where its body
  is, gets quieter across a field and disappears over a hill's worth of
  distance. Peers are opened at CONNECT_DIST and dropped at DROP_DIST, with
  the gap between the two being what stops a player pacing a boundary from
  reconnecting forty times a minute.

  Loudness is a graph, not a hope. Two gains hold the visitor's two dials
  (`roamPrefs`' `micVol` and `voiceVol`, edited on the pause sheet): one trims
  the microphone before the gate, the other is the bus every incoming panner
  lands on. The bus carries a fixed makeup gain under the dial, because the
  distance model alone cannot be loud enough: an inverse rolloff is already
  a third of the way down at conversational range, HRTF panning costs a few
  dB on top, and the first version of this ran all of that straight into
  `ctx.destination` at unity, which is why two people standing in a field
  could barely hear each other. A limiter sits after the bus so that boost
  can never turn a shout into clipping. The mic trim is deliberately *before*
  the analyser as well as before the gate: turning yourself up has to make
  the voice gate open more readily, or a quiet speaker turns the dial up and
  still gets cut off mid-word.

  The visitor's voice filter (`voiceFilters.ts`: helium, giant, robot, radio,
  cave, or none, picked on the pause sheet as `roamPrefs.voiceFx`) sits
  between the gate and the send limiter, so it is applied on *this* side and
  every listener hears it with nothing added to the protocol. Its two ends
  are fixed nodes and a switch is a crossfade behind them, which is what makes
  it live mid-call. The radio's squelch is keyed off this gate closing.

  The sheet's mic test (`test()`, Discord's "Mic Test") holds the gate open,
  mutes the send so the test stays private, and routes the filtered voice to
  your own speakers until it is switched off, arming the microphone for the
  duration if it was off; `level()` is its meter. The monitor carries the
  same makeup and the same speaker dial a nearby voice gets, so you hear
  yourself at the level somebody standing next to you does. It used to go
  out at unity, ~9 dB under that (the makeup is x2.8), which read as "I can
  barely hear myself".

  Devices are the visitor's too (`roamPrefs.micDevice`/`outDevice`, '' for
  the system default). A new microphone is only a new source node in front
  of the trim, since peers carry the destination's track and never the
  microphone's (below), so switching mid-call needs no `replaceTrack`. The
  speaker is `AudioContext.setSinkId`, which moves the shared context and so
  everything the walk plays, not only the voices; where the browser has no
  `setSinkId` (Firefox, Safari) the sheet offers no picker at all.

  Two details that are load-bearing and look like mistakes:

  - The microphone is never handed straight to a peer connection. It goes
    mic -> trim -> gate -> filter -> limiter -> MediaStreamDestination, and
    the *destination's* track is
    what every peer sends. That track exists from the moment the module does,
    so turning the mic on, muting it, switching between open-mic and
    push-to-talk, and revoking it again are all a gain ramp — no track
    swapping, no renegotiation, no SDP churn on a live call. The voice
    detector taps the microphone ahead of the gate, so a closed gate can
    still hear you start talking.
  - Every remote stream is also sunk into a muted <audio> element it does not
    play through. Chrome will not pump a WebRTC track into WebAudio until the
    stream has a media-element consumer; without this the graph is wired
    correctly, the panners are in the right places, and there is silence.

  Who calls whom is settled by id: the lower id makes the offer. Both sides
  discover each other in the same snapshot, so without a rule they would both
  offer at once and glare. It is a smaller thing to reason about than perfect
  negotiation, and there is nothing here to renegotiate.
*/

/** used until the server's `world-welcome` says otherwise. STUN alone is
    enough for most pairs; a TURN relay, when one is configured, arrives from
    the server with a credential that expires — see iceServers() there */
const DEFAULT_ICE: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
]

/** open a peer inside this, drop it outside DROP_DIST. The gap is hysteresis:
    a player standing exactly on the line must not thrash the connection */
const CONNECT_DIST = 55
const DROP_DIST = 80
/** the panner stops attenuating here; past it a voice is effectively gone */
const MAX_AUDIBLE = 70
/** inside this a voice is at full strength: the bubble two people stand in
    to talk to each other, about three metres at this world's scale. It was 4,
    which is close enough that anyone you could comfortably see was already
    being attenuated */
const REF_DIST = 8
/** and how fast it falls off past that. Under 1 so the curve reaches across a
    yard rather than dying at the edge of it */
const ROLLOFF = 0.9
/** what the bus adds under the visitor's dial. A voice track lands around
    -20 dBFS after the browser's own AGC and the panner takes a chunk more;
    unity here is a conversation you have to lean into */
const VOICE_MAKEUP = 2.8
/** how far up either dial may go, so a stored number cannot hand the graph
    something it will scream through */
const VOL_MAX = 2
/** where a mouth is over a pair of feet, as a fraction of eye height */
const MOUTH = 0.94

/** voice-activity gate, in dBFS over the analyser's RMS */
const VAD_ON_DB = -50
const VAD_OFF_DB = -56
/** how long the gate stays open after you stop, so words are not clipped */
const VAD_HANG_MS = 320
/** the gate's own ramp; abrupt enough to feel instant, soft enough not to click */
const GATE_RAMP = 0.015

const MODE_KEY = 'alejos-voice-mode'

/** where the open-mic gate opens, on the mic test's meter (0..1 over
    METER_FLOOR_DB..0 dBFS), so the sheet can mark it */
const METER_FLOOR_DB = -66
export const GATE_ON_LEVEL = 1 - VAD_ON_DB / METER_FLOOR_DB

/** the speaker picker needs `AudioContext.setSinkId` (Chromium 110+) */
type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }
export const canPickSpeaker = () =>
  typeof AudioContext !== 'undefined' &&
  typeof (AudioContext.prototype as SinkContext).setSinkId === 'function'

export type VoiceMode = 'open' | 'ptt'

interface Peer {
  pc: RTCPeerConnection
  panner: PannerNode
  el: HTMLAudioElement | null
  source: MediaStreamAudioSourceNode | null
  /** we are the offerer; the other side is waiting on us */
  caller: boolean
}

export interface ProximityVoice {
  /** the browser has the APIs and an audio context; false kills the UI */
  readonly available: boolean
  /** the microphone is live (muted or not) */
  readonly enabled: boolean
  readonly mode: VoiceMode
  /** the gate is open right now — this is the bit that rides the wire */
  readonly speaking: boolean
  /** how many peers are actually carrying audio */
  readonly peerCount: number
  /** set when permission was refused or the mic could not be opened */
  readonly error: string | null
  /** M: acquire the microphone, or release it. Needs a user gesture the
      first time, which is why it returns a promise nobody has to await */
  toggle: () => Promise<void>
  /** N: swap between open-mic and push-to-talk */
  cycleMode: () => void
  /** B, held */
  setPushing: (down: boolean) => void
  /** one frame: place the listener, open and close peers, move the panners */
  update: (
    players: ReadonlyMap<PlayerId, RemotePlayer>,
    camera: THREE.Camera,
    dt: number,
  ) => void
  /** the mic test: play your own filtered voice back to you, privately (the
      send is muted), until it is switched off. Arms the microphone for the
      duration if it was off; false when it could not be opened */
  test: (on: boolean) => Promise<boolean>
  readonly testing: boolean
  /** how loud the microphone is right now after its trim, 0..1 for a meter
      (METER_FLOOR_DB..0 dBFS); 0 with the mic off */
  level: () => number
  /** a world-signal came back off the socket */
  accept: (from: PlayerId, data: VoiceSignal) => void
  dispose: () => void
}

export interface ProximityVoiceOpts {
  /** our own id, for deciding who offers */
  self: () => PlayerId | null
  /** the walk's standing eye height, for putting a voice at head height over
      the feet the network reports */
  eye: number
  /** the visitor's two dials, 0..2 each, read fresh every frame. Both are
      checked against what is already on the graph before anything is set, so
      asking every frame costs a pair of comparisons */
  levels: () => { mic: number; out: number }
  /** the voice filter, read fresh every frame like the dials */
  filter: () => VoiceFilter
  /** the chosen microphone and speaker ('' the system default), read fresh
      every frame like the dials; a change is acted on, not re-set */
  devices: () => { mic: string; out: string }
  /** the ICE servers to open the next peer with, read fresh each time: the
      server hands them over at join, and a TURN credential in them expires */
  ice: () => RTCIceServer[]
  send: (to: PlayerId, data: VoiceSignal) => void
  /** told whenever something user-visible changed, so the HUD can repaint */
  onChange: () => void
}

/**
  A brick wall on a bus, both directions.

  Measured offline against a -20 dBFS voice track, which is where a browser's
  own AGC leaves one: at -6/12:1 the makeup gain still pushed peaks half a dB
  past full scale at the top of the dial. At -10/20:1 the loudest thing either
  chain can produce peaks at -1 dBFS, which is the point: a volume control
  that can distort is a volume control people learn not to turn up.
*/
const limiterIn = (ctx: AudioContext) => {
  const c = ctx.createDynamicsCompressor()
  c.threshold.value = -10
  c.knee.value = 0
  c.ratio.value = 20
  c.attack.value = 0.002
  c.release.value = 0.2
  return c
}

const loadMode = (): VoiceMode => {
  try {
    return localStorage.getItem(MODE_KEY) === 'ptt' ? 'ptt' : 'open'
  } catch {
    return 'open'
  }
}

export function createProximityVoice(opts: ProximityVoiceOpts): ProximityVoice {
  const ctx = sharedAudio()
  const canRtc =
    typeof RTCPeerConnection !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  const available = Boolean(ctx) && canRtc

  const peers = new Map<PlayerId, Peer>()
  let mode = loadMode()
  let enabled = false
  let pushing = false
  let speaking = false
  let error: string | null = null
  let opening = false

  let mic: MediaStream | null = null
  let micSource: MediaStreamAudioSourceNode | null = null
  let analyser: AnalyserNode | null = null
  // spelled out over its own ArrayBuffer: getFloatTimeDomainData will not
  // accept the SharedArrayBuffer-backed view the bare constructor infers
  let samples: Float32Array<ArrayBuffer> | null = null
  let vadUntil = 0
  let spatialAcc = 0

  // The send chain, built once and never rebuilt: trim -> gate -> filter ->
  // send -> limiter -> destination, and the destination's track is what every
  // peer connection carries for the whole session. Muting is
  // `gate.gain = 0`, not a track swap; a filter change is a rewire *inside*
  // `fx`, whose two ends never move.
  const trim = ctx ? ctx.createGain() : null
  const gate = ctx ? ctx.createGain() : null
  const fx = ctx ? createVoiceFx(ctx, opts.filter()) : null
  const send = ctx ? ctx.createGain() : null
  const outLimit = ctx ? limiterIn(ctx) : null
  const outDest = ctx ? ctx.createMediaStreamDestination() : null
  // the mic test's tap: the filtered voice, back to this machine's speakers
  const monitor = ctx ? ctx.createGain() : null
  if (gate && fx && send && outDest && outLimit) {
    gate.gain.value = 0
    // the trim can be pushed to +6 dB, and the browser's AGC is not on every
    // platform: what leaves here is what everybody else hears, so it leaves
    // through a limiter rather than as somebody's clipped track
    gate.connect(fx.input)
    fx.output.connect(send)
    send.connect(outLimit)
    outLimit.connect(outDest)
  }
  const outTrack = outDest?.stream.getAudioTracks()[0] ?? null

  // ...and the return chain, likewise built once: every peer's panner lands on
  // one bus, the bus carries the dial, and the limiter after it is what makes
  // a boost above unity safe to offer at all
  const bus = ctx ? ctx.createGain() : null
  const limiter = ctx ? limiterIn(ctx) : null
  if (ctx && bus && limiter) {
    bus.gain.value = VOICE_MAKEUP
    bus.connect(limiter)
    limiter.connect(ctx.destination)
    // the monitor skips the bus (its gain is set per test to the bus's own
    // makeup times the dial, with no panner to lose level in) but not its
    // limiter
    if (fx && monitor) {
      monitor.gain.value = 0
      fx.output.connect(monitor)
      monitor.connect(limiter)
    }
  }
  let previewing = false
  /** the mic test is up, and whether it had to arm the microphone itself */
  let testArmed = false
  let testTimer = 0
  // what the graph is currently set to, so a per-frame read is two compares
  let micVol = 1
  let outVol = 1
  const clampVol = (v: number) => (v > VOL_MAX ? VOL_MAX : v > 0 ? v : 0)
  /** the monitor's level while testing: a nearby voice's (makeup times the
      speaker dial), which is the honest answer to "how do I sound" */
  const monitorGain = () => VOICE_MAKEUP * outVol
  // the devices in force: what the microphone was opened on and where the
  // context is playing. A change in the prefs is acted on once
  let micDevice = ''
  let outDevice = ''
  let switching = false
  const applyLevels = () => {
    if (!ctx) return
    const want = opts.levels()
    const m = clampVol(want.mic)
    const o = clampVol(want.out)
    if (m !== micVol) {
      micVol = m
      trim?.gain.setTargetAtTime(m, ctx.currentTime, 0.02)
    }
    if (o !== outVol) {
      outVol = o
      bus?.gain.setTargetAtTime(VOICE_MAKEUP * o, ctx.currentTime, 0.02)
      if (previewing) monitor?.gain.setTargetAtTime(monitorGain(), ctx.currentTime, 0.02)
    }
    fx?.set(opts.filter())
    const dev = opts.devices()
    if (dev.out !== outDevice) {
      outDevice = dev.out
      const sink = (ctx as SinkContext).setSinkId
      // a speaker that has gone away plays on the default rather than nowhere
      if (sink) void sink.call(ctx, dev.out).catch(() => sink.call(ctx, '').catch(() => {}))
    }
    if (dev.mic !== micDevice && !switching) {
      micDevice = dev.mic
      if (enabled) void switchMic()
    }
  }

  // scratch, reused per frame
  const camPos = new THREE.Vector3()
  const camQuat = new THREE.Quaternion()
  const fwd = new THREE.Vector3()
  const up = new THREE.Vector3()

  const changed = () => opts.onChange()

  const setGate = (open: boolean) => {
    if (!ctx || !gate) return
    if (speaking === open) return
    speaking = open
    gate.gain.setTargetAtTime(open ? 1 : 0, ctx.currentTime, GATE_RAMP)
    if (!open) fx?.gateClosed()
    changed()
  }

  // ---------------------------------------------------------------- peers

  const closePeer = (id: PlayerId) => {
    const peer = peers.get(id)
    if (!peer) return
    peers.delete(id)
    try {
      peer.source?.disconnect()
      peer.panner.disconnect()
    } catch {
      /* already torn down */
    }
    if (peer.el) {
      peer.el.srcObject = null
      peer.el.remove()
    }
    peer.pc.onicecandidate = null
    peer.pc.ontrack = null
    peer.pc.onconnectionstatechange = null
    peer.pc.close()
    changed()
  }

  const makePeer = (id: PlayerId, caller: boolean): Peer | null => {
    if (!ctx) return null
    const offered = opts.ice()
    const pc = new RTCPeerConnection({
      iceServers: offered.length > 0 ? offered : DEFAULT_ICE,
    })
    const panner = ctx.createPanner()
    panner.panningModel = 'HRTF'
    panner.distanceModel = 'inverse'
    panner.refDistance = REF_DIST
    panner.maxDistance = MAX_AUDIBLE
    panner.rolloffFactor = ROLLOFF
    panner.connect(bus ?? ctx.destination)

    const peer: Peer = { pc, panner, el: null, source: null, caller }
    peers.set(id, peer)

    // the gated microphone bus — silent until the gate opens, always present
    if (outTrack) pc.addTrack(outTrack, outDest!.stream)
    else pc.addTransceiver('audio', { direction: 'recvonly' })

    pc.onicecandidate = (ev) => {
      if (ev.candidate) opts.send(id, { kind: 'ice', candidate: ev.candidate.toJSON() })
    }

    pc.ontrack = (ev) => {
      const stream = ev.streams[0]
      if (!stream || peer.source) return
      // Chrome needs a media-element consumer before it will feed a remote
      // track into WebAudio. Muted: the panner is what we actually listen to.
      const el = new Audio()
      el.srcObject = stream
      el.muted = true
      el.autoplay = true
      void el.play().catch(() => {})
      peer.el = el
      peer.source = ctx.createMediaStreamSource(stream)
      peer.source.connect(panner)
      changed()
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(id)
    }

    if (caller) {
      void (async () => {
        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          opts.send(id, { kind: 'offer', sdp: pc.localDescription?.sdp ?? '' })
        } catch {
          closePeer(id)
        }
      })()
    }
    return peer
  }

  // ---------------------------------------------------------------- mic

  const stopMic = () => {
    micSource?.disconnect()
    // the trim stays in the graph, but it must not keep feeding a dead
    // analyser or a second start would tap through two of them
    if (trim && gate) {
      trim.disconnect()
      trim.connect(gate)
    }
    micSource = null
    analyser = null
    samples = null
    mic?.getTracks().forEach((t) => t.stop())
    mic = null
    enabled = false
    setGate(false)
    changed()
  }

  /** the microphone asked for: the chosen one, or the system's own when
      that one has been unplugged since it was picked */
  const openMic = async () => {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    if (micDevice) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: micDevice } } })
      } catch (e) {
        if (!(e instanceof DOMException) || (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError')) throw e
      }
    }
    return navigator.mediaDevices.getUserMedia({ audio })
  }

  /** another microphone, mid-call: only the source in front of the trim
      changes. Peers carry the destination's track, so nobody renegotiates */
  const switchMic = async () => {
    if (!ctx || !trim || switching) return
    switching = true
    try {
      const stream = await openMic()
      if (!enabled) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      micSource?.disconnect()
      mic?.getTracks().forEach((t) => t.stop())
      mic = stream
      micSource = ctx.createMediaStreamSource(stream)
      micSource.connect(trim)
      error = null
    } catch {
      // the old microphone is still connected; say so and keep it
      error = 'That microphone could not be opened'
    } finally {
      switching = false
      changed()
    }
  }

  const startMic = async () => {
    if (!ctx || opening) return
    opening = true
    error = null
    changed()
    try {
      micDevice = opts.devices().mic
      const stream = await openMic()
      if (ctx.state === 'suspended') await ctx.resume()
      mic = stream
      micSource = ctx.createMediaStreamSource(stream)
      analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.4
      samples = new Float32Array(new ArrayBuffer(analyser.fftSize * 4))
      // the detector taps after the trim and ahead of the gate: a shut gate
      // can still hear you begin to speak, and turning yourself up turns the
      // gate's own threshold down with you
      micSource.connect(trim!)
      trim!.connect(analyser)
      trim!.connect(gate!)
      enabled = true
    } catch (e) {
      error =
        e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
          ? 'Microphone permission denied'
          : 'No microphone available'
      enabled = false
    } finally {
      opening = false
      changed()
    }
  }

  /** the mic test over: monitor down, send back up, and the microphone
      handed back if the test was what opened it */
  const endTest = () => {
    if (!ctx || !send || !monitor) return
    if (!previewing) return
    previewing = false
    window.clearInterval(testTimer)
    setGate(false)
    const t = ctx.currentTime
    monitor.gain.setTargetAtTime(0, t, GATE_RAMP)
    send.gain.setTargetAtTime(1, t, GATE_RAMP)
    if (testArmed && enabled) stopMic()
    testArmed = false
    changed()
  }

  /** RMS of the last analyser frame, in dBFS */
  const micLevelDb = () => {
    if (!analyser || !samples) return -Infinity
    analyser.getFloatTimeDomainData(samples)
    let sum = 0
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
    const rms = Math.sqrt(sum / samples.length)
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity
  }

  return {
    available,
    get enabled() {
      return enabled
    },
    get mode() {
      return mode
    },
    get speaking() {
      // a mic test holds the gate open with the send muted: nobody is hearing
      // it, so nobody should see the speaking mark either
      return speaking && !previewing
    },
    get peerCount() {
      let n = 0
      for (const peer of peers.values()) if (peer.source) n++
      return n
    },
    get error() {
      return error
    },

    async toggle() {
      if (!available) return
      if (enabled) stopMic()
      else await startMic()
    },

    cycleMode() {
      mode = mode === 'open' ? 'ptt' : 'open'
      try {
        localStorage.setItem(MODE_KEY, mode)
      } catch {
        /* storage unavailable; the mode just won't persist */
      }
      changed()
    },

    setPushing(down) {
      pushing = down
    },

    update(players, camera, dt) {
      if (!ctx) return
      applyLevels()

      // --- the gate ------------------------------------------------------
      if (previewing) {
        setGate(enabled)
      } else if (enabled) {
        const now = performance.now()
        if (mode === 'ptt') {
          setGate(pushing)
        } else {
          const db = micLevelDb()
          if (db > VAD_ON_DB) vadUntil = now + VAD_HANG_MS
          else if (db < VAD_OFF_DB && now > vadUntil) vadUntil = 0
          setGate(pushing || now < vadUntil)
        }
      } else if (speaking) {
        setGate(false)
      }

      // --- who we should be talking to -----------------------------------
      const self = opts.self()
      camera.getWorldPosition(camPos)
      for (const [id, player] of players) {
        // head to head, like the panner below: `player.y` is a pair of feet,
        // and measuring those against a lens puts an eye height of bias into
        // every distance on flat ground
        const d = Math.hypot(
          player.x - camPos.x,
          player.y + opts.eye * MOUTH - camPos.y,
          player.z - camPos.z,
        )
        const peer = peers.get(id)
        if (!peer && d < CONNECT_DIST && self !== null) {
          // one side calls, the other waits: lowest id dials
          if (self < id) makePeer(id, true)
        } else if (peer && d > DROP_DIST) {
          closePeer(id)
        }
      }
      // anyone who walked out of the level, or left entirely
      for (const id of peers.keys()) {
        if (!players.has(id)) closePeer(id)
      }

      // --- where everything is -------------------------------------------
      // 30Hz is plenty for a head that moves at walking pace, and halves the
      // AudioParam traffic on a busy scene
      spatialAcc += dt
      if (spatialAcc < 1 / 30) return
      spatialAcc = 0
      const t = ctx.currentTime
      camera.getWorldQuaternion(camQuat)
      fwd.set(0, 0, -1).applyQuaternion(camQuat)
      up.set(0, 1, 0).applyQuaternion(camQuat)
      const listener = ctx.listener
      if (listener.positionX) {
        listener.positionX.setTargetAtTime(camPos.x, t, 0.02)
        listener.positionY.setTargetAtTime(camPos.y, t, 0.02)
        listener.positionZ.setTargetAtTime(camPos.z, t, 0.02)
        listener.forwardX.setTargetAtTime(fwd.x, t, 0.02)
        listener.forwardY.setTargetAtTime(fwd.y, t, 0.02)
        listener.forwardZ.setTargetAtTime(fwd.z, t, 0.02)
        listener.upX.setTargetAtTime(up.x, t, 0.02)
        listener.upY.setTargetAtTime(up.y, t, 0.02)
        listener.upZ.setTargetAtTime(up.z, t, 0.02)
      } else {
        // Safari still ships the pre-AudioParam listener
        listener.setPosition(camPos.x, camPos.y, camPos.z)
        listener.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z)
      }
      for (const [id, peer] of peers) {
        const player = players.get(id)
        if (!player) continue
        // the mouth, not the soles: a voice should come from head height, and
        // the network reports where somebody's feet are
        const p = peer.panner
        const mouthY = player.y + opts.eye * MOUTH
        if (p.positionX) {
          p.positionX.setTargetAtTime(player.x, t, 0.02)
          p.positionY.setTargetAtTime(mouthY, t, 0.02)
          p.positionZ.setTargetAtTime(player.z, t, 0.02)
        } else {
          p.setPosition(player.x, mouthY, player.z)
        }
      }
    },

    get testing() {
      return previewing
    },

    async test(on) {
      if (!available || !ctx || !send || !monitor) return false
      if (!on) {
        endTest()
        return true
      }
      if (previewing) return true
      // a click on the sheet is the gesture getUserMedia wants, so a test
      // with the mic off arms it for the duration and hands it back after
      const armed = !enabled
      if (armed) await startMic()
      if (!enabled) return false
      if (ctx.state === 'suspended') await ctx.resume()
      applyLevels()
      previewing = true
      testArmed = armed
      const t = ctx.currentTime
      send.gain.setTargetAtTime(0, t, GATE_RAMP)
      monitor.gain.setTargetAtTime(monitorGain(), t, GATE_RAMP)
      setGate(true)
      // the walk is paused under the sheet, so nothing is calling update():
      // the dials, the filter and the devices are followed from here instead
      testTimer = window.setInterval(applyLevels, 50)
      changed()
      return true
    },

    level() {
      const db = micLevelDb()
      return db > METER_FLOOR_DB ? 1 - db / METER_FLOOR_DB : 0
    },

    accept(from, data) {
      if (!ctx) return
      void (async () => {
        let peer = peers.get(from)
        try {
          if (data.kind === 'offer') {
            // they dialled us; build the answering side on demand
            if (!peer) peer = makePeer(from, false) ?? undefined
            if (!peer) return
            await peer.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp })
            const answer = await peer.pc.createAnswer()
            await peer.pc.setLocalDescription(answer)
            opts.send(from, { kind: 'answer', sdp: peer.pc.localDescription?.sdp ?? '' })
          } else if (data.kind === 'answer') {
            if (!peer || peer.pc.signalingState !== 'have-local-offer') return
            await peer.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp })
          } else if (data.kind === 'ice') {
            // candidates outrun the description they belong to often enough
            // that a throw here is routine, not a fault
            if (peer?.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate)
          }
        } catch {
          if (data.kind !== 'ice') closePeer(from)
        }
      })()
    },

    dispose() {
      endTest()
      for (const id of [...peers.keys()]) closePeer(id)
      stopMic()
      trim?.disconnect()
      gate?.disconnect()
      fx?.dispose()
      send?.disconnect()
      monitor?.disconnect()
      outLimit?.disconnect()
      bus?.disconnect()
      limiter?.disconnect()
    },
  }
}
