/**
 * Font subsetting with HarfBuzz (harfbuzzjs' standalone hb-subset WebAssembly build, MIT).
 * @pdf-lib/fontkit's own subsetter drops glyphs for large CJK TrueType fonts, so we
 * subset here and let pdf-lib embed the (small) result as-is.
 */

interface HbExports {
  memory: WebAssembly.Memory;
  malloc(n: number): number;
  free(p: number): void;
  hb_blob_create(data: number, len: number, mode: number, user: number, destroy: number): number;
  hb_blob_destroy(b: number): void;
  hb_blob_get_length(b: number): number;
  hb_blob_get_data(b: number, lenPtr: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(f: number): void;
  hb_face_reference_blob(f: number): number;
  hb_set_add(s: number, cp: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(i: number): void;
  hb_subset_input_unicode_set(i: number): number;
  hb_subset_input_set(i: number, which: number): number;
  hb_subset_input_get_flags(i: number): number;
  hb_subset_input_set_flags(i: number, f: number): void;
  hb_subset_preprocess(face: number): number;
  hb_subset_or_fail(face: number, input: number): number;
}

const HB_MEMORY_MODE_WRITABLE = 2;
const HB_SUBSET_SETS_DROP_TABLE_TAG = 3;
const tag = (t: string) => ((t.charCodeAt(0) << 24) | (t.charCodeAt(1) << 16) | (t.charCodeAt(2) << 8) | t.charCodeAt(3)) >>> 0;
const HB_SUBSET_FLAGS_NO_HINTING = 0x1;

export interface Subsetter {
  /** Returns a TrueType/OpenType font containing only the glyphs for `codepoints`. */
  subset(codepoints: Iterable<number>): Uint8Array;
  destroy(): void;
}

let modulePromise: Promise<WebAssembly.Module> | null = null;

function loadModule(wasm: ArrayBuffer | Uint8Array | (() => Promise<ArrayBuffer>)): Promise<WebAssembly.Module> {
  modulePromise ??= (async () => {
    const bytes = typeof wasm === 'function' ? await wasm() : wasm;
    return WebAssembly.compile(bytes as BufferSource);
  })();
  return modulePromise;
}

/**
 * Create a subsetter for one font. The font is copied into WASM memory once and
 * preprocessed, so repeated subset() calls are fast.
 */
export async function createSubsetter(
  fontBytes: Uint8Array,
  wasm: ArrayBuffer | Uint8Array | (() => Promise<ArrayBuffer>),
): Promise<Subsetter> {
  const instance = await WebAssembly.instantiate(await loadModule(wasm), {});
  const e = instance.exports as unknown as HbExports;
  const fontPtr = e.malloc(fontBytes.byteLength);
  new Uint8Array(e.memory.buffer).set(fontBytes, fontPtr);
  const blob = e.hb_blob_create(fontPtr, fontBytes.byteLength, HB_MEMORY_MODE_WRITABLE, 0, 0);
  const rawFace = e.hb_face_create(blob, 0);
  e.hb_blob_destroy(blob);
  // Preprocessing builds acceleration tables once for repeated subsetting.
  const face = e.hb_subset_preprocess(rawFace) || rawFace;
  if (face !== rawFace) e.hb_face_destroy(rawFace);

  return {
    subset(codepoints) {
      const input = e.hb_subset_input_create_or_fail();
      if (!input) throw new Error('hb_subset_input_create_or_fail failed');
      try {
        const set = e.hb_subset_input_unicode_set(input);
        for (const cp of codepoints) e.hb_set_add(set, cp);
        e.hb_subset_input_set_flags(input, e.hb_subset_input_get_flags(input) | HB_SUBSET_FLAGS_NO_HINTING);
        // Drop OpenType layout tables: pdf-lib shapes text with fontkit, and GSUB/GPOS substitutions
        // (e.g. digits next to Han text) yield glyphs with no ToUnicode entry and mismatched widths.
        const drop = e.hb_subset_input_set(input, HB_SUBSET_SETS_DROP_TABLE_TAG);
        for (const t of ['GSUB', 'GPOS', 'GDEF', 'BASE', 'JSTF', 'vhea', 'vmtx', 'VORG']) e.hb_set_add(drop, tag(t));
        const sub = e.hb_subset_or_fail(face, input);
        if (!sub) throw new Error('hb_subset_or_fail failed');
        const outBlob = e.hb_face_reference_blob(sub);
        const ptr = e.hb_blob_get_data(outBlob, 0);
        const len = e.hb_blob_get_length(outBlob);
        const out = new Uint8Array(e.memory.buffer, ptr, len).slice();
        e.hb_blob_destroy(outBlob);
        e.hb_face_destroy(sub);
        return out;
      } finally {
        e.hb_subset_input_destroy(input);
      }
    },
    destroy() {
      e.hb_face_destroy(face);
      e.free(fontPtr);
    },
  };
}
