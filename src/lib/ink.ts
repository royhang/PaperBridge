import type { InkPoint, InkStroke } from '../db/db';

/** Append a normalized point only if it moved enough to avoid micro-jitter and bloated storage. */
export function appendInkPoint(points: InkPoint[], x: number, y: number, pressure: number, minDist = 0.0014): InkPoint[] {
  const cx = Math.max(0, Math.min(1, x));
  const cy = Math.max(0, Math.min(1, y));
  const cp = Math.max(0.1, Math.min(1, Number.isFinite(pressure) && pressure > 0 ? pressure : 0.5));
  const prev = points[points.length - 1];
  if (prev && Math.hypot(cx - prev[0], cy - prev[1]) < minDist) return points;
  const rx = Math.round(cx * 10000) / 10000;
  const ry = Math.round(cy * 10000) / 10000;
  const rp = Math.round(cp * 100) / 100;
  return [...points, [rx, ry, rp]];
}

/** Build a smooth midpoint quadratic Bézier SVG path in pixel coordinates. */
export function pointsToSvgPath(points: InkPoint[], width: number, height: number): string {
  if (!points.length) return '';
  const px = (i: number) => +(points[i][0] * width).toFixed(2);
  const py = (i: number) => +(points[i][1] * height).toFixed(2);
  if (points.length === 1) {
    const x = px(0);
    const y = py(0);
    return `M ${x} ${y} L ${(x + 0.01).toFixed(2)} ${y}`;
  }
  if (points.length === 2) {
    return `M ${px(0)} ${py(0)} L ${px(1)} ${py(1)}`;
  }
  let d = `M ${px(0)} ${py(0)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const x = px(i);
    const y = py(i);
    const mx = +((x + px(i + 1)) / 2).toFixed(2);
    const my = +((y + py(i + 1)) / 2).toFixed(2);
    d += ` Q ${x} ${y} ${mx} ${my}`;
  }
  const last = points.length - 1;
  d += ` L ${px(last)} ${py(last)}`;
  return d;
}

/** Compute rendered SVG stroke width (pressure-modulated for pen, flat for highlighter). */
export function renderStrokeWidth(stroke: Pick<InkStroke, 'kind' | 'width' | 'points'>, scale: number): number {
  if (stroke.kind === 'highlighter') return Math.max(8, stroke.width * scale);
  let sum = 0;
  for (const p of stroke.points) sum += p[2] ?? 0.5;
  const avgP = stroke.points.length ? sum / stroke.points.length : 0.5;
  return Math.max(0.8, stroke.width * scale * (0.72 + 0.56 * avgP));
}

function pointToSegmentDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Hit-test an eraser point (normalized 0..1) against an ink stroke. */
export function strokeHitsPoint(stroke: InkStroke, nx: number, ny: number, radius = 0.022): boolean {
  const pts = stroke.points;
  if (!pts.length) return false;
  const effectiveR = stroke.kind === 'highlighter' ? radius * 1.45 : radius;
  if (pts.length === 1) return Math.hypot(nx - pts[0][0], ny - pts[0][1]) <= effectiveR;
  for (let i = 1; i < pts.length; i++) {
    if (pointToSegmentDist(nx, ny, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= effectiveR) {
      return true;
    }
  }
  return false;
}
