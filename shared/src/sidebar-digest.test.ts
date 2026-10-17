import { describe, expect, test } from "bun:test";
import { computeSidebarDigest, isSidebarDigest, SIDEBAR_DIGEST_BUCKETS, sidebarBucket, sidebarListDelta } from "./sidebar-digest";

const conversations = Array.from({ length: 600 }, (_, i) => ({ id: `conv-${i}`, title: `Title ${i} — café 🐋`, updatedAt: i }));
const folders = [{ id: "f1", name: "Folder", sortOrder: 0 }];
const digestOf = (list: typeof conversations, folderList = folders) =>
  computeSidebarDigest(list.map(c => [c.id, JSON.stringify(c)] as [string, string]), JSON.stringify(folderList));

describe("sidebar digest", () => {
  test("buckets are stable and in range", () => {
    expect(sidebarBucket("conv-1")).toBe(sidebarBucket("conv-1"));
    for (const conversation of conversations) {
      const bucket = sidebarBucket(conversation.id);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(SIDEBAR_DIGEST_BUCKETS);
    }
    expect(isSidebarDigest(digestOf(conversations))).toBe(true);
    expect(isSidebarDigest({ buckets: ["x"], folders: "y" })).toBe(false);
  });

  test("row order does not matter; content does", () => {
    expect(digestOf([...conversations].reverse())).toEqual(digestOf(conversations));
    const edited = conversations.map(c => c.id === "conv-7" ? { ...c, title: "renamed" } : c);
    const delta = sidebarListDelta(edited, folders, digestOf(conversations))!;
    expect(delta.sidebarBuckets).toEqual([sidebarBucket("conv-7")]);
    expect(delta.conversations.map(c => c.id)).toContain("conv-7");
    expect(delta.conversations.every(c => sidebarBucket(c.id) === sidebarBucket("conv-7"))).toBe(true);
    expect("folders" in delta).toBe(false);
  });

  test("additions, deletions and folder changes are reported", () => {
    const changed = [...conversations.slice(1), { id: "conv-new", title: "new", updatedAt: 1 }];
    const delta = sidebarListDelta(changed, [...folders, { id: "f2", name: "Two", sortOrder: 1 }], digestOf(conversations))!;
    expect(new Set(delta.sidebarBuckets)).toEqual(new Set([sidebarBucket("conv-0"), sidebarBucket("conv-new")]));
    expect(delta.folders).toHaveLength(2);
  });

  test("falls back to a full list when nothing matches", () => {
    // Enough rows that no bucket is empty (empty buckets match trivially).
    const many = Array.from({ length: 5000 }, (_, i) => ({ id: `c${i}`, title: "", updatedAt: i }));
    const other = many.map(c => ({ ...c, updatedAt: c.updatedAt + 1 }));
    expect(sidebarListDelta(other, folders, digestOf(many))).toBeNull();
  });
});
