import * as THREE from 'three'
import { sharedAudio } from '../../game/core/sfx'
import type { PlayerId, VoiceSignal } from '../../game/net/protocol'
import type { RemotePlayer } from '../../game/net/remotePlayers'

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

  Two details that are load-bearing and look like mistakes:

  - The microphone is never handed straight to a peer connection. It goes
    mic -> gate -> MediaStreamDestination, and the *destination's* track is
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
const REF_DIST = 4

/** voice-activity gate, in dBFS over the analyser's RMS */
const VAD_ON_DB = -50
const VAD_OFF_DB = -56
/** how long the gate stays open after you stop, so words are not clipped */
const VAD_HANG_MS = 320
/** the gate's own ramp; abrupt enough to feel instant, soft enough not to click */
const GATE_RAMP = 0.015

const MODE_KEY = 'alejos-voice-mode'

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
  /** a world-signal came back off the socket */
  accept: (from: PlayerId, data: VoiceSignal) => void
  dispose: () => void
}

export interface ProximityVoiceOpts {
  /** our own id, for deciding who offers */
  self: () => PlayerId | null
  /** the ICE servers to open the next peer with, read fresh each time: the
      server hands them over at join, and a TURN credential in them expires */
  ice: () => RTCIceServer[]
  send: (to: PlayerId, data: VoiceSignal) => void
  /** told whenever something user-visible changed, so the HUD can repaint */
  onChange: () => void
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

  // The send chain, built once and never rebuilt: gate -> destination, and the
  // destination's track is what every peer connection carries for the whole
  // session. Muting is `gate.gain = 0`, not a track swap.
  const gate = ctx ? ctx.createGain() : null
  const outDest = ctx ? ctx.createMediaStreamDestination() : null
  if (gate && outDest) {
    gate.gain.value = 0
    gate.connect(outDest)
  }
  const outTrack = outDest?.stream.getAudioTracks()[0] ?? null

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
    panner.rolloffFactor = 1.1
    panner.connect(ctx.destination)

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
    micSource = null
    analyser = null
    samples = null
    mic?.getTracks().forEach((t) => t.stop())
    mic = null
    enabled = false
    setGate(false)
    changed()
  }

  const startMic = async () => {
    if (!ctx || opening) return
    opening = true
    error = null
    changed()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      if (ctx.state === 'suspended') await ctx.resume()
      mic = stream
      micSource = ctx.createMediaStreamSource(stream)
      analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.4
      samples = new Float32Array(new ArrayBuffer(analyser.fftSize * 4))
      // the detector taps ahead of the gate, so a shut gate can still hear
      // you begin to speak
      micSource.connect(analyser)
      micSource.connect(gate!)
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
      return speaking
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

      // --- the gate ------------------------------------------------------
      if (enabled) {
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
        const d = Math.hypot(player.x - camPos.x, player.y - camPos.y, player.z - camPos.z)
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
        // the mouth, not the soles: a voice should come from head height
        const p = peer.panner
        if (p.positionX) {
          p.positionX.setTargetAtTime(player.x, t, 0.02)
          p.positionY.setTargetAtTime(player.y + 3, t, 0.02)
          p.positionZ.setTargetAtTime(player.z, t, 0.02)
        } else {
          p.setPosition(player.x, player.y + 3, player.z)
        }
      }
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
      for (const id of [...peers.keys()]) closePeer(id)
      stopMic()
      gate?.disconnect()
    },
  }
}
