"use strict";

const SAMPLE_RATE = 48_000;
const CHANNEL_COUNT = 1;

function pulseArgs(mode, sampleRate = SAMPLE_RATE, channels = CHANNEL_COUNT) {
  return [
    mode,
    "--raw",
    "--format=s16le",
    `--rate=${sampleRate}`,
    `--channels=${channels}`,
    "--latency-msec=20",
  ];
}

function captureSpec(platform = process.platform, env = process.env) {
  if (platform === "linux") {
    return { command: "parec", args: pulseArgs("--record") };
  }
  if (platform === "darwin") {
    const device = env.EXOCORTEX_CALL_AVFOUNDATION_DEVICE
      || env.EXOCORTEX_VOICE_AVFOUNDATION_DEVICE
      || "none:default";
    return {
      command: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-f", "avfoundation",
        "-i", device,
        "-ac", String(CHANNEL_COUNT),
        "-ar", String(SAMPLE_RATE),
        "-f", "s16le",
        "pipe:1",
      ],
    };
  }
  throw new Error(`Realtime call microphone capture is not supported on ${platform}.`);
}

function playbackSpec(sampleRate, channels, platform = process.platform) {
  if (platform === "linux") {
    return { command: "pacat", args: pulseArgs("--playback", sampleRate, channels) };
  }
  if (platform === "darwin") {
    const channelLayout = channels === 1 ? "mono" : channels === 2 ? "stereo" : `${channels}c`;
    return {
      command: "ffplay",
      args: [
        "-hide_banner",
        "-loglevel", "error",
        "-nodisp",
        "-autoexit",
        "-f", "s16le",
        "-ar", String(sampleRate),
        "-ch_layout", channelLayout,
        "-i", "pipe:0",
      ],
    };
  }
  throw new Error(`Realtime call audio playback is not supported on ${platform}.`);
}

module.exports = { captureSpec, playbackSpec };
