import { describe, expect, test } from "bun:test";
import { defaultInputTransport, isBluetoothTransport } from "./macaudio";

describe("macOS default input transport", () => {
  test("only CoreAudio's Bluetooth transport types count as Bluetooth", () => {
    expect(isBluetoothTransport("blue")).toBe(true);
    expect(isBluetoothTransport("blea")).toBe(true);
    for (const transport of ["bltn", "usb ", "virt", "ccwd", "", null]) {
      expect(isBluetoothTransport(transport)).toBe(false);
    }
  });

  test("reads a four-character transport on macOS and nothing elsewhere", () => {
    const transport = defaultInputTransport();
    if (process.platform === "darwin") {
      // A Mac with no input device at all has none to report.
      if (transport !== null) expect(transport).toMatch(/^[\x20-\x7e]{4}$/);
    } else {
      expect(transport).toBeNull();
    }
  });
});
