/**
 * The macOS default input device's transport, read from CoreAudio.
 *
 * Reading a device property needs no microphone access and takes ~0.1 ms once
 * CoreAudio is loaded (~100 ms the first time), so it can be asked at the
 * moment a recording starts and is never stale.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";

const CORE_AUDIO = "/System/Library/Frameworks/CoreAudio.framework/CoreAudio";
const SYSTEM_OBJECT = 1; // kAudioObjectSystemObject

function fourCC(code: string): number {
  return ((code.charCodeAt(0) << 24) | (code.charCodeAt(1) << 16) | (code.charCodeAt(2) << 8) | code.charCodeAt(3)) >>> 0;
}

function fourCCText(value: number): string {
  return String.fromCharCode((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
}

type ReadProperty = (object: number, selector: string) => number | null;

/** undefined: not loaded yet; null: CoreAudio could not be loaded. */
let readProperty: ReadProperty | null | undefined;

function loadCoreAudio(): ReadProperty | null {
  try {
    const lib = dlopen(CORE_AUDIO, {
      AudioObjectGetPropertyData: {
        args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    return (object, selector) => {
      // AudioObjectPropertyAddress { selector, scope: global, element: main }
      const address = new Uint32Array([fourCC(selector), fourCC("glob"), 0]);
      const size = new Uint32Array([4]);
      const value = new Uint32Array(1);
      const status = lib.symbols.AudioObjectGetPropertyData(object, ptr(address), 0, null, ptr(size), ptr(value));
      return status === 0 && size[0] === 4 ? value[0]! : null;
    };
  } catch {
    return null;
  }
}

/**
 * kAudioDevicePropertyTransportType of the default input device as its
 * four-character code ("bltn" built-in, "blue" Bluetooth, "blea" Bluetooth LE,
 * "usb ", "virt", …), or null off macOS or when it cannot be read.
 */
export function defaultInputTransport(): string | null {
  if (process.platform !== "darwin") return null;
  if (readProperty === undefined) readProperty = loadCoreAudio();
  if (!readProperty) return null;
  try {
    const device = readProperty(SYSTEM_OBJECT, "dIn "); // kAudioHardwarePropertyDefaultInputDevice
    if (!device) return null;
    const transport = readProperty(device, "tran"); // kAudioDevicePropertyTransportType
    return transport === null ? null : fourCCText(transport);
  } catch {
    return null;
  }
}

/** kAudioDeviceTransportTypeBluetooth and kAudioDeviceTransportTypeBluetoothLE. */
export function isBluetoothTransport(transport: string | null): boolean {
  return transport === "blue" || transport === "blea";
}
