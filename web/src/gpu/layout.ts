// WGSL host-shareable struct layout (docs/plan-webgpu.md §2.3), computed in
// TS so the uniform packers and the WGSL struct text come from one field
// list: `structLayout` gives each field's byte offset, `wgslStruct` writes
// the matching WGSL declaration.
//
// Rules: f32/u32/i32 align 4, size 4; vec2 align 8, size 8; vec3 align 16,
// size 12 (a scalar can pack after it); vec4 align 16, size 16; an array's
// stride is its element size rounded up to the element alignment, and in the
// uniform address space array strides must be multiples of 16. A struct's
// size rounds up to its largest alignment.

export type Scalar = 'f32' | 'u32' | 'i32';
export type Vector = 'vec2f' | 'vec2u' | 'vec2i' | 'vec3f' | 'vec3u' | 'vec3i' | 'vec4f' | 'vec4u' | 'vec4i';
export type Plain = Scalar | Vector;
export type WgslType = Plain | { array: Plain; length: number };

export type AddressSpace = 'uniform' | 'storage';

export interface FieldLayout {
  name: string;
  type: WgslType;
  offset: number;
  size: number;
}

export interface StructLayout {
  fields: FieldLayout[];
  /** Byte offset of each field by name. */
  offsets: Record<string, number>;
  size: number;
  align: number;
}

/** Alignment and size of a scalar or vector (WGSL spec, "Alignment and Size"). */
function plainAlignSize(t: Plain): { align: number; size: number } {
  if (t === 'f32' || t === 'u32' || t === 'i32') return { align: 4, size: 4 };
  const lanes = Number(t.charAt(3));
  if (lanes === 2) return { align: 8, size: 8 };
  if (lanes === 3) return { align: 16, size: 12 };
  return { align: 16, size: 16 };
}

const roundUp = (x: number, to: number): number => Math.ceil(x / to) * to;

/** Offsets and size of a struct with these fields; throws on an array stride WGSL rejects in `space`. */
export function structLayout(
  fields: readonly (readonly [string, WgslType])[],
  space: AddressSpace = 'uniform',
): StructLayout {
  const out: FieldLayout[] = [];
  const offsets: Record<string, number> = {};
  let offset = 0;
  let structAlign = 4;
  for (const [name, type] of fields) {
    let align: number;
    let size: number;
    if (typeof type === 'string') {
      ({ align, size } = plainAlignSize(type));
    } else {
      const el = plainAlignSize(type.array);
      const stride = roundUp(el.size, el.align);
      if (space === 'uniform' && stride % 16 !== 0) {
        throw new Error(`${name}: uniform array stride ${stride} is not a multiple of 16`);
      }
      // Uniform arrays also align to 16.
      align = space === 'uniform' ? roundUp(el.align, 16) : el.align;
      size = stride * type.length;
    }
    offset = roundUp(offset, align);
    out.push({ name, type, offset, size });
    offsets[name] = offset;
    offset += size;
    structAlign = Math.max(structAlign, align);
  }
  return { fields: out, offsets, size: roundUp(offset, structAlign), align: structAlign };
}

function wgslType(t: WgslType): string {
  return typeof t === 'string' ? t : `array<${t.array}, ${t.length}>`;
}

/** WGSL text of the struct: `struct Name {\n  field: type,\n}\n`. */
export function wgslStruct(name: string, layout: StructLayout): string {
  const lines = [`struct ${name} {`];
  for (const f of layout.fields) lines.push(`  ${f.name}: ${wgslType(f.type)},`);
  lines.push('}', '');
  return lines.join('\n');
}
