import { describe, expect, test } from "bun:test";
import {
  KITTY_CHUNK_CHARS,
  KittyImageSync,
  deleteImage,
  deletePlacement,
  placeImage,
  transmitPng,
  type KittyImageData,
  type KittyPlacement,
} from "./kittyimages";

const image = (kittyId = 7, base64 = "QUJD"): KittyImageData => ({ kittyId, base64, pixelWidth: 200, pixelHeight: 100 });

const placement = (overrides: Partial<KittyPlacement> = {}): KittyPlacement => ({
  image: image(),
  placementId: 3,
  row: 5,
  col: 4,
  columns: 20,
  rows: 10,
  ...overrides,
});

/** Split a payload into its APC commands' control strings. */
function controls(payload: string): string[] {
  return [...payload.matchAll(/\x1b_G([^;]*);[^\x1b]*\x1b\\/g)].map(match => match[1]);
}

describe("escape generation", () => {
  test("small images transmit in one direct-transport command", () => {
    expect(transmitPng(image(9, "AAAA"))).toBe("\x1b_Ga=t,t=d,f=100,i=9,q=2;AAAA\x1b\\");
  });

  test("large images are chunked at 4096 base64 characters", () => {
    const data = "A".repeat(KITTY_CHUNK_CHARS * 2 + 10);
    const payload = transmitPng(image(9, data));
    expect(controls(payload)).toEqual(["a=t,t=d,f=100,i=9,q=2,m=1", "m=1,q=2", "m=0,q=2"]);
    const chunks = [...payload.matchAll(/;([^\x1b]*)\x1b\\/g)].map(match => match[1]);
    expect(chunks.map(chunk => chunk.length)).toEqual([KITTY_CHUNK_CHARS, KITTY_CHUNK_CHARS, 10]);
    expect(chunks.join("")).toBe(data);
  });

  test("placements move the cursor, keep it still, and crop the source when partial", () => {
    expect(placeImage(placement())).toBe("\x1b[5;4H\x1b_Ga=p,i=7,p=3,c=20,r=10,C=1,z=1,q=1;\x1b\\");
    expect(placeImage(placement({ rows: 4, sourceY: 60, sourceHeight: 40 })))
      .toBe("\x1b[5;4H\x1b_Ga=p,i=7,p=3,c=20,r=4,x=0,y=60,w=200,h=40,C=1,z=1,q=1;\x1b\\");
    expect(placeImage(placement({ columns: 8, sourceX: 120, sourceWidth: 80 })))
      .toBe("\x1b[5;4H\x1b_Ga=p,i=7,p=3,c=8,r=10,x=120,y=0,w=80,h=100,C=1,z=1,q=1;\x1b\\");
  });

  test("a higher z stacks a placement above the rest and re-places on change", () => {
    expect(placeImage(placement({ z: 2 }))).toContain(",C=1,z=2,q=1;");
    const sync = new KittyImageSync();
    sync.sync([placement()]);
    expect(controls(sync.sync([placement({ z: 2 })]))).toEqual(["a=p,i=7,p=3,c=20,r=10,C=1,z=2,q=1"]);
    expect(controls(sync.sync([placement({ z: 2, columns: 8, sourceX: 120, sourceWidth: 80 })])))
      .toEqual(["a=p,i=7,p=3,c=8,r=10,x=120,y=0,w=80,h=100,C=1,z=2,q=1"]);
  });

  test("a selected placement carries st's V=1 tint", () => {
    expect(placeImage(placement({ selected: true }))).toContain(",z=1,V=1,q=1;");
    const sync = new KittyImageSync();
    sync.sync([placement()]);
    expect(controls(sync.sync([placement({ selected: true })]))).toEqual(["a=p,i=7,p=3,c=20,r=10,C=1,z=1,V=1,q=1"]);
  });

  test("deletes placements softly and images hard", () => {
    expect(deletePlacement(7, 3)).toBe("\x1b_Ga=d,d=i,i=7,p=3,q=2;\x1b\\");
    expect(deleteImage(7)).toBe("\x1b_Ga=d,d=I,i=7,q=2;\x1b\\");
  });
});

describe("KittyImageSync", () => {
  test("transmits once, places once, and is silent while nothing changes", () => {
    const sync = new KittyImageSync();
    expect(controls(sync.sync([placement()]))).toEqual(["a=t,t=d,f=100,i=7,q=2", "a=p,i=7,p=3,c=20,r=10,C=1,z=1,q=1"]);
    expect(sync.hasPlacements()).toBe(true);
    expect(sync.sync([placement()])).toBe("");
  });

  test("scrolling re-places with a crop instead of re-sending data", () => {
    const sync = new KittyImageSync();
    sync.sync([placement()]);
    const scrolled = sync.sync([placement({ row: 3, rows: 8, sourceY: 20, sourceHeight: 80 })]);
    expect(controls(scrolled)).toEqual(["a=p,i=7,p=3,c=20,r=8,x=0,y=20,w=200,h=80,C=1,z=1,q=1"]);
    expect(scrolled.startsWith("\x1b[3;4H")).toBe(true);
  });

  test("deletes placements that left the screen but keeps their data for later", () => {
    const sync = new KittyImageSync();
    sync.sync([placement(), placement({ placementId: 4, row: 20 })]);
    expect(controls(sync.sync([placement({ placementId: 4, row: 20 })]))).toEqual(["a=d,d=i,i=7,p=3,q=2"]);
    expect(controls(sync.sync([]))).toEqual(["a=d,d=i,i=7,p=4,q=2"]);
    expect(sync.hasPlacements()).toBe(false);
    // Scrolling back needs no retransmit.
    expect(controls(sync.sync([placement()]))).toEqual(["a=p,i=7,p=3,c=20,r=10,C=1,z=1,q=1"]);
  });

  test("invalidated placements are re-sent after a resize", () => {
    const sync = new KittyImageSync();
    sync.sync([placement()]);
    sync.invalidatePlacements();
    expect(controls(sync.sync([placement()]))).toEqual(["a=p,i=7,p=3,c=20,r=10,C=1,z=1,q=1"]);
  });

  test("an image the terminal evicted is transmitted again", () => {
    const sync = new KittyImageSync();
    sync.sync([placement()]);
    expect(sync.forgetImage(7)).toBe(true);
    expect(controls(sync.sync([placement()]))).toEqual(["a=t,t=d,f=100,i=7,q=2", "a=p,i=7,p=3,c=20,r=10,C=1,z=1,q=1"]);
  });

  test("evicts least recently used off-screen images past the residency limit", () => {
    const sync = new KittyImageSync();
    for (let id = 1; id <= 32; id++) sync.sync([placement({ image: image(id), placementId: id })]);
    // The 33rd image pushes residency over 32: the oldest unused one goes.
    expect(controls(sync.sync([placement({ image: image(33), placementId: 33 })]))).toContain("a=d,d=I,i=1,q=2");
    const next = controls(sync.sync([placement({ image: image(34), placementId: 34 })]));
    expect(next).toContain("a=d,d=I,i=2,q=2");
    expect(next.filter(command => command.startsWith("a=d,d=I"))).toEqual(["a=d,d=I,i=2,q=2"]);
  });

  test("dispose frees everything it sent", () => {
    const sync = new KittyImageSync();
    sync.sync([placement(), placement({ image: image(8), placementId: 9 })]);
    expect(controls(sync.dispose()).sort()).toEqual(["a=d,d=I,i=7,q=2", "a=d,d=I,i=8,q=2"]);
    expect(sync.dispose()).toBe("");
  });
});
