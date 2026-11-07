/**
 * The resources block's data: the connected daemon's machine_resources, and
 * the block's shape (what its width depends on), kept per daemon route in
 * storage/tui-resources.json so the block draws at its final width, empty,
 * from the first frame; the first sample fills it in place.
 *
 * A daemon that sends them does so while handling client_capabilities, ahead
 * of its bootstrap; a bootstrap's tools_available with no sample before it
 * means the daemon predates them, and the block goes.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { storageDir } from "@exocortex/shared/paths";
import { log } from "./log";
import type { MachineResources } from "./protocol";
import type { RenderState } from "./state";

/** What the block's layout depends on. */
export interface ResourcesShape {
  /** RAM total (the MEM figure's width); null: unknown yet. */
  memoryTotalBytes: number | null;
  /** The GPU column shows. */
  gpu: boolean;
  vramTotalBytes: number | null;
}

/** A route never seen: CPU and MEM only. */
export const DEFAULT_RESOURCES_SHAPE: ResourcesShape = { memoryTotalBytes: null, gpu: false, vramTotalBytes: null };

/** The shape a sample gives; a total it lacks (vm_stat not read yet) keeps the one known. */
export function shapeAfter(previous: ResourcesShape | null, resources: MachineResources): ResourcesShape {
  const gpu = resources.gpuPercent !== null || resources.vram !== null;
  return {
    memoryTotalBytes: resources.memory?.totalBytes ?? previous?.memoryTotalBytes ?? null,
    gpu,
    vramTotalBytes: gpu ? resources.vram?.totalBytes ?? previous?.vramTotalBytes ?? null : null,
  };
}

export function applyMachineResources(state: RenderState, resources: MachineResources): void {
  state.machineResources = resources;
  state.machineResourcesSeen = true;
  state.machineResourcesShape = shapeAfter(state.machineResourcesShape, resources);
}

/** The bootstrap's tools_available: no sample ahead of it means the daemon sends none. */
export function machineResourcesBootstrapped(state: RenderState): void {
  if (state.machineResourcesSeen) return;
  state.machineResources = null;
  state.machineResourcesShape = null;
}

/** Figures stop being live; the block keeps its place. */
export function machineResourcesDisconnected(state: RenderState): void {
  state.machineResources = null;
  state.machineResourcesSeen = false;
}

/** Another daemon: its own shape, empty until its first sample. */
export function machineResourcesRouteSwitched(state: RenderState, shape: ResourcesShape | null): void {
  machineResourcesDisconnected(state);
  state.machineResourcesShape = shape;
}

/** Each route's last shape (null: its daemon sends no samples). */
export class ResourcesShapes {
  private byRoute: Record<string, ResourcesShape | null> = {};

  constructor(private readonly path = join(storageDir(), "tui-resources.json")) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { routes?: unknown };
      if (parsed.routes && typeof parsed.routes === "object") {
        for (const [route, shape] of Object.entries(parsed.routes as Record<string, unknown>)) {
          if (shape === null || isShape(shape)) this.byRoute[route] = shape;
        }
      }
    } catch { /* none yet */ }
  }

  forRoute(routeKey: string): ResourcesShape | null {
    return routeKey in this.byRoute ? this.byRoute[routeKey] : DEFAULT_RESOURCES_SHAPE;
  }

  /** Saved only when it changed. */
  remember(routeKey: string, shape: ResourcesShape | null): void {
    if (routeKey in this.byRoute && JSON.stringify(this.byRoute[routeKey]) === JSON.stringify(shape)) return;
    this.byRoute[routeKey] = shape;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ routes: this.byRoute }) + "\n");
      renameSync(temp, this.path);
    } catch (error) {
      log("warn", `tui: could not save the resources block's shape: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function isShape(value: unknown): value is ResourcesShape {
  const shape = value as ResourcesShape;
  const total = (n: unknown) => n === null || (typeof n === "number" && Number.isFinite(n) && n > 0);
  return typeof value === "object" && value !== null && typeof shape.gpu === "boolean"
    && total(shape.memoryTotalBytes) && total(shape.vramTotalBytes);
}
