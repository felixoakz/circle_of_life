// Test helper: encodes nodes in the v2 tile format (docs/tile-format.md).

export interface TestNode {
  id: number;
  parent: number;
  angle: number;
  arcLo?: number;
  arcHi?: number;
  leafCount?: number;
  firstTip?: number;
  r?: number;
  parentR?: number;
  childLevel?: number;
  tip?: boolean;
}

export function encodeTile(level: number, sector: number, nodes: TestNode[]): ArrayBuffer {
  const internal = nodes.filter((n) => !n.tip);
  const tips = nodes.filter((n) => n.tip);
  const ordered = [...internal, ...tips];
  const n = ordered.length;
  const nameOff = (24 + 39 * n + 3) & ~3;
  const buf = new ArrayBuffer(nameOff + 4 * (n + 1));
  const dv = new DataView(buf);
  [0x53, 0x50, 0x54, 0x32].forEach((b, i) => dv.setUint8(i, b));
  dv.setUint8(4, 2);
  dv.setUint8(5, level);
  dv.setUint32(8, sector, true);
  dv.setUint32(12, n, true);
  dv.setUint32(16, internal.length, true);
  ordered.forEach((node, i) => {
    dv.setUint32(24 + 4 * i, node.id, true);
    dv.setUint32(24 + 4 * n + 4 * i, node.parent, true);
    dv.setUint32(24 + 8 * n + 4 * i, node.angle, true);
    dv.setUint32(24 + 12 * n + 4 * i, node.arcLo ?? node.angle, true);
    dv.setUint32(24 + 16 * n + 4 * i, node.arcHi ?? node.angle, true);
    dv.setUint32(24 + 20 * n + 4 * i, node.leafCount ?? 1, true);
    dv.setUint32(24 + 24 * n + 4 * i, node.firstTip ?? 0, true);
    dv.setFloat32(24 + 28 * n + 4 * i, node.r ?? 1, true);
    dv.setFloat32(24 + 32 * n + 4 * i, node.parentR ?? 0.5, true);
    dv.setUint8(24 + 37 * n + i, node.tip ? 1 : 0);
    dv.setUint8(24 + 38 * n + i, node.childLevel ?? (node.tip ? 255 : 0));
  });
  return buf;
}
