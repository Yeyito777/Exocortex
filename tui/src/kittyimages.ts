/**
 * Kitty graphics protocol output for inline history images.
 *
 * The renderer describes, every frame, which images should be visible where
 * (cell rectangle plus source crop). `KittyImageSync` turns that into
 * the minimal protocol traffic: transmit image data once (direct `t=d`
 * transport, chunked, so it works over SSH), move or crop a placement only
 * when its geometry changed, and delete placements that are no longer wanted.
 * Placements are positioned explicitly every time they change, so terminal
 * scrolling never has to carry them; the frame renderer disables its scroll
 * region optimization while images are placed.
 */

const APC = "\x1b_G";
const ST = "\x1b\\";
const moveTo = (row: number, col: number) => `\x1b[${row};${col}H`;
export const KITTY_CHUNK_CHARS = 4096;
/** Terminal-side data we keep resident beyond what is on screen. */
const MAX_RESIDENT_IMAGES = 32;
const MAX_RESIDENT_BASE64_CHARS = 96 * 1024 * 1024;

export interface KittyImageData {
  /** Protocol image id (`i`), unique per transmitted preview. */
  kittyId: number;
  /** Base64 PNG payload. */
  base64: string;
  pixelWidth: number;
  pixelHeight: number;
}

export interface KittyPlacement {
  image: KittyImageData;
  /** Protocol placement id (`p`), unique per rendered occurrence. */
  placementId: number;
  /** 1-based screen cell of the placement's top-left corner. */
  row: number;
  col: number;
  columns: number;
  rows: number;
  /** Visible source rectangle, in image pixels, when the image is partly scrolled out or covered. */
  sourceX?: number;
  sourceY?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  /** Stacking order; thumbnails use 1, the image viewer draws above them. */
  z?: number;
  /** Tint as one selected object (st's `V=1`; other terminals ignore the key). */
  selected?: boolean;
}

function command(controls: string, payload = ""): string {
  return `${APC}${controls};${payload}${ST}`;
}

/** Chunked direct-transport transmit of a PNG without displaying it. */
export function transmitPng(image: KittyImageData): string {
  const data = image.base64;
  if (data.length <= KITTY_CHUNK_CHARS) return command(`a=t,t=d,f=100,i=${image.kittyId},q=2`, data);
  const out: string[] = [];
  for (let offset = 0; offset < data.length; offset += KITTY_CHUNK_CHARS) {
    const chunk = data.slice(offset, offset + KITTY_CHUNK_CHARS);
    const more = offset + KITTY_CHUNK_CHARS < data.length ? 1 : 0;
    out.push(offset === 0
      ? command(`a=t,t=d,f=100,i=${image.kittyId},q=2,m=1`, chunk)
      : command(`m=${more},q=2`, chunk));
  }
  return out.join("");
}

export function placeImage(placement: KittyPlacement): string {
  const { image } = placement;
  const sourceX = Math.max(0, Math.floor(placement.sourceX ?? 0));
  const sourceY = Math.max(0, Math.floor(placement.sourceY ?? 0));
  const sourceWidth = Math.max(1, Math.min(image.pixelWidth - sourceX, Math.floor(placement.sourceWidth ?? image.pixelWidth)));
  const sourceHeight = Math.max(1, Math.min(image.pixelHeight - sourceY, Math.floor(placement.sourceHeight ?? image.pixelHeight)));
  const crop = sourceX > 0 || sourceY > 0 || sourceWidth < image.pixelWidth || sourceHeight < image.pixelHeight
    ? `,x=${sourceX},y=${sourceY},w=${sourceWidth},h=${sourceHeight}`
    : "";
  // C=1 keeps the cursor still; q=1 reports only failures (an evicted image).
  return moveTo(placement.row, placement.col)
    + command(`a=p,i=${image.kittyId},p=${placement.placementId},c=${placement.columns},r=${placement.rows}${crop},C=1,z=${placement.z ?? 1}${placement.selected ? ",V=1" : ""},q=1`);
}

export function deletePlacement(kittyId: number, placementId: number): string {
  return command(`a=d,d=i,i=${kittyId},p=${placementId},q=2`);
}

/** Delete an image's placements and free its data. */
export function deleteImage(kittyId: number): string {
  return command(`a=d,d=I,i=${kittyId},q=2`);
}

function placementKey(kittyId: number, placementId: number): string {
  return `${kittyId}:${placementId}`;
}

function fingerprint(placement: KittyPlacement): string {
  return [
    placement.row, placement.col, placement.columns, placement.rows,
    placement.sourceX ?? 0, placement.sourceY ?? 0,
    placement.sourceWidth ?? placement.image.pixelWidth, placement.sourceHeight ?? placement.image.pixelHeight,
    placement.z ?? 1, placement.selected ? 1 : 0,
  ].join(":");
}

interface ResidentImage {
  base64: string;
  lastUsed: number;
}

/** Terminal-side image and placement state for one screen. */
export class KittyImageSync {
  private readonly resident = new Map<number, ResidentImage>();
  /** placement key → fingerprint last sent ("" forces a re-place). */
  private readonly placed = new Map<string, string>();
  private useClock = 0;

  /** Whether any placement may currently be on screen. */
  hasPlacements(): boolean {
    return this.placed.size > 0;
  }

  /** Protocol traffic that turns the current screen into `placements`. */
  sync(placements: readonly KittyPlacement[]): string {
    const out: string[] = [];
    const desired = new Map(placements.map(placement => [placementKey(placement.image.kittyId, placement.placementId), placement]));
    const tick = ++this.useClock;

    for (const key of [...this.placed.keys()]) {
      if (desired.has(key)) continue;
      const [kittyId, placementId] = key.split(":").map(Number);
      out.push(deletePlacement(kittyId, placementId));
      this.placed.delete(key);
    }

    for (const [key, placement] of desired) {
      const { image } = placement;
      const resident = this.resident.get(image.kittyId);
      if (!resident || resident.base64 !== image.base64) {
        out.push(transmitPng(image));
        this.resident.set(image.kittyId, { base64: image.base64, lastUsed: tick });
        for (const placedKey of this.placed.keys()) {
          if (placedKey.startsWith(`${image.kittyId}:`)) this.placed.set(placedKey, "");
        }
      } else {
        resident.lastUsed = tick;
      }
      const print = fingerprint(placement);
      if (this.placed.get(key) === print) continue;
      out.push(placeImage(placement));
      this.placed.set(key, print);
    }

    out.push(...this.evict(new Set(placements.map(placement => placement.image.kittyId))));
    return out.join("");
  }

  /** Re-send every placement on the next sync (after a resize reflowed the screen). */
  invalidatePlacements(): void {
    for (const key of this.placed.keys()) this.placed.set(key, "");
  }

  /** The terminal reported an image missing (evicted): send it again next sync. */
  forgetImage(kittyId: number): boolean {
    const known = this.resident.delete(kittyId);
    for (const key of [...this.placed.keys()]) {
      if (key.startsWith(`${kittyId}:`)) this.placed.delete(key);
    }
    return known;
  }

  /** Protocol traffic that removes everything this sync ever sent. */
  dispose(): string {
    const out = [...this.resident.keys()].map(deleteImage);
    for (const key of this.placed.keys()) {
      const [kittyId, placementId] = key.split(":").map(Number);
      if (!this.resident.has(kittyId)) out.push(deletePlacement(kittyId, placementId));
    }
    this.resident.clear();
    this.placed.clear();
    return out.join("");
  }

  private evict(inUse: ReadonlySet<number>): string[] {
    let chars = 0;
    for (const image of this.resident.values()) chars += image.base64.length;
    if (this.resident.size <= MAX_RESIDENT_IMAGES && chars <= MAX_RESIDENT_BASE64_CHARS) return [];
    const out: string[] = [];
    const candidates = [...this.resident.entries()]
      .filter(([kittyId]) => !inUse.has(kittyId))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [kittyId, image] of candidates) {
      if (this.resident.size <= MAX_RESIDENT_IMAGES && chars <= MAX_RESIDENT_BASE64_CHARS) break;
      out.push(deleteImage(kittyId));
      this.resident.delete(kittyId);
      chars -= image.base64.length;
    }
    return out;
  }
}
