#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const readline = require("node:readline");
const wrtc = require("@roamhq/wrtc");
const { captureSpec, playbackSpec } = require("./call-media-platform.cjs");

const SAMPLE_RATE = 48_000;
const CHANNEL_COUNT = 1;
const BITS_PER_SAMPLE = 16;
const FRAMES_PER_CHUNK = 480; // 10 ms at 48 kHz
const BYTES_PER_CHUNK = FRAMES_PER_CHUNK * CHANNEL_COUNT * 2;
const ICE_GATHER_TIMEOUT_MS = 5_000;

let stopping = false;
let capture = null;
let playback = null;
let playbackFormat = null;
let captureBuffer = Buffer.alloc(0);
let remoteSink = null;
let micGainDb = 0;
let micGainLinear = 1;
const intentionallyStoppedChildren = new WeakSet();

function send(message) {
  if (!process.stdout.destroyed) process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  send({ type: "error", message });
  void stop(1);
}

function waitForIceGathering(peer) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS);
    function done() {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", changed);
      resolve();
    }
    function changed() {
      if (peer.iceGatheringState === "complete") done();
    }
    peer.addEventListener("icegatheringstatechange", changed);
  });
}

const source = new wrtc.nonstandard.RTCAudioSource();
const localTrack = source.createTrack();
const peer = new wrtc.RTCPeerConnection();
peer.addTrack(localTrack);
peer.createDataChannel("oai-events");

function stopChild(child) {
  if (!child) return;
  intentionallyStoppedChildren.add(child);
  try { child.stdin?.end(); } catch {}
  try { child.kill("SIGTERM"); } catch {}
}

function setMicGainDb(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Microphone gain must be a finite number.");
  micGainDb = Object.is(value, -0) ? 0 : value;
  micGainLinear = 10 ** (micGainDb / 20);
}

function applyMicGain(samples) {
  if (micGainLinear === 1) return;
  for (let index = 0; index < samples.length; index++) {
    const amplified = Math.round(samples[index] * micGainLinear);
    samples[index] = Math.max(-32_768, Math.min(32_767, amplified));
  }
}

function startCapture() {
  if (capture || stopping) return;
  let spec;
  try {
    spec = captureSpec();
  } catch (error) {
    fail(error);
    return;
  }
  const child = spawn(spec.command, spec.args, { stdio: ["ignore", "pipe", "pipe"] });
  capture = child;
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  child.stdout.on("data", chunk => {
    captureBuffer = captureBuffer.length === 0 ? chunk : Buffer.concat([captureBuffer, chunk]);
    while (captureBuffer.length >= BYTES_PER_CHUNK) {
      const frame = captureBuffer.subarray(0, BYTES_PER_CHUNK);
      captureBuffer = captureBuffer.subarray(BYTES_PER_CHUNK);
      const samples = new Int16Array(FRAMES_PER_CHUNK * CHANNEL_COUNT);
      Buffer.from(samples.buffer).set(frame);
      applyMicGain(samples);
      try {
        source.onData({
          samples,
          sampleRate: SAMPLE_RATE,
          bitsPerSample: BITS_PER_SAMPLE,
          channelCount: CHANNEL_COUNT,
          numberOfFrames: FRAMES_PER_CHUNK,
        });
      } catch (error) {
        fail(error);
        return;
      }
    }
  });
  child.on("error", error => fail(new Error(`Cannot start microphone capture: ${error.message}`)));
  child.on("exit", (code, signal) => {
    const expected = stopping || intentionallyStoppedChildren.has(child);
    if (capture === child) capture = null;
    if (!expected) fail(new Error(`Microphone capture stopped (${signal ?? code ?? "unknown"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
  });
}

function ensurePlayback(sampleRate, channels) {
  const format = `${sampleRate}/${channels}`;
  if (playback && playbackFormat === format) return playback;
  stopChild(playback);
  playbackFormat = format;
  const spec = playbackSpec(sampleRate, channels);
  const child = spawn(spec.command, spec.args, { stdio: ["pipe", "ignore", "pipe"] });
  playback = child;
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  child.on("error", error => fail(new Error(`Cannot start call audio playback: ${error.message}`)));
  child.on("exit", (code, signal) => {
    const expected = stopping || intentionallyStoppedChildren.has(child);
    if (playback === child) {
      playback = null;
      playbackFormat = null;
    }
    if (!expected) fail(new Error(`Call audio playback stopped (${signal ?? code ?? "unknown"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
  });
  return child;
}

peer.ontrack = ({ track }) => {
  if (track.kind !== "audio" || stopping) return;
  remoteSink?.stop();
  remoteSink = new wrtc.nonstandard.RTCAudioSink(track);
  remoteSink.ondata = data => {
    if (stopping) return;
    const player = ensurePlayback(data.sampleRate, data.channelCount);
    const bytes = Buffer.from(data.samples.buffer, data.samples.byteOffset, data.samples.byteLength);
    player.stdin?.write(bytes);
  };
};

peer.onconnectionstatechange = () => {
  const state = peer.connectionState;
  send({ type: "state", state });
  if (state === "connected") startCapture();
  if (state === "failed" || state === "closed") {
    if (!stopping) fail(new Error(`WebRTC call ${state}.`));
  }
};

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  stopChild(capture);
  stopChild(playback);
  capture = null;
  playback = null;
  try { remoteSink?.stop(); } catch {}
  remoteSink = null;
  try { localTrack.stop(); } catch {}
  try { peer.close(); } catch {}
  // Exit explicitly after native objects close. Letting Node tear the wrtc addon
  // down during ordinary event-loop exhaustion can trip an upstream destructor crash.
  setTimeout(() => process.exit(exitCode), 20);
}

async function handle(message) {
  if (!message || typeof message !== "object") throw new Error("Invalid media-adapter command.");
  if (message.type === "answer") {
    if (typeof message.sdp !== "string" || !message.sdp.trim()) throw new Error("The call SDP answer is empty.");
    await peer.setRemoteDescription({ type: "answer", sdp: message.sdp });
    return;
  }
  if (message.type === "stop") {
    await stop(0);
    return;
  }
  if (message.type === "mic_gain") {
    setMicGainDb(message.gainDb);
    return;
  }
  throw new Error(`Unknown media-adapter command: ${String(message.type)}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", line => {
  if (!line.trim()) return;
  try {
    const message = JSON.parse(line);
    Promise.resolve(handle(message)).catch(fail);
  } catch (error) {
    fail(error);
  }
});
input.on("close", () => { void stop(0); });
process.on("SIGTERM", () => { void stop(0); });
process.on("SIGINT", () => { void stop(0); });
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

(async () => {
  const offer = await peer.createOffer({ offerToReceiveAudio: true });
  await peer.setLocalDescription(offer);
  await waitForIceGathering(peer);
  if (!peer.localDescription?.sdp) throw new Error("WebRTC did not produce an SDP offer.");
  send({ type: "offer", sdp: peer.localDescription.sdp });
})().catch(fail);
