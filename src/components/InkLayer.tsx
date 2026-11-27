import { memo, useEffect, useRef, useState } from 'react';
import { db, uid, type InkPoint, type InkStroke, type InkTarget } from '../db/db';
import { appendInkPoint, pointsToSvgPath, renderStrokeWidth, strokeHitsPoint } from '../lib/ink';
import { useReader } from '../store/reader';

interface InkLayerProps {
  docId: string;
  pageIndex: number;
  layer?: InkTarget;
  disabled?: boolean;
  width: number;
  height: number;
  scale: number;
  strokes?: InkStroke[];
}

type SafariTouch = Touch & { touchType?: 'direct' | 'stylus' };

export const InkLayer = memo(function InkLayer({ docId, pageIndex, layer = 'original', disabled = false, width, height, scale, strokes }: InkLayerProps) {
  const inkTool = useReader((s) => s.inkTool);
  const penColor = useReader((s) => s.penColor);
  const hlColor = useReader((s) => s.hlColor);
  const penWidth = useReader((s) => s.penWidth);
  const pencilOnly = useReader((s) => s.pencilOnly);

  const svgRef = useRef<SVGSVGElement>(null);
  const activePointer = useRef<number | null>(null);
  const activePenRef = useRef(false);
  const erasingByStylusBtnRef = useRef(false);
  const draftRef = useRef<InkPoint[]>([]);
  const erasedRef = useRef<Set<string>>(new Set());
  const [draft, setDraft] = useState<InkPoint[] | null>(null);

  const interactive = !disabled && inkTool !== 'none';

  // Cross-platform stylus palm rejection (iPadOS Apple Pencil + Android S-Pen / M-Pencil / Xiaomi Pen):
  // - Safari reports `touch.touchType === 'stylus'` on TouchEvent.
  // - Android Chrome/Edge fires `pointerdown` (`pointerType === 'pen'`) right before `touchstart`,
  //   setting `activePenRef.current = true` so we preventDefault ONLY for stylus touches while
  //   fingers and resting palms keep smooth native scrolling & two-finger pinch-zoom!
  useEffect(() => {
    const el = svgRef.current;
    if (!el || !interactive) return;
    const guardTouch = (e: TouchEvent) => {
      if (pencilOnly) {
        const hasStylus =
          activePenRef.current || Array.from(e.touches).some((t) => (t as SafariTouch).touchType === 'stylus');
        if (hasStylus) e.preventDefault();
        return;
      }
      // Finger-drawing mode: prevent single-finger scroll, still allow 2-finger pinch/scroll
      if (e.touches.length === 1) e.preventDefault();
    };
    el.addEventListener('touchstart', guardTouch, { passive: false });
    el.addEventListener('touchmove', guardTouch, { passive: false });
    return () => {
      el.removeEventListener('touchstart', guardTouch);
      el.removeEventListener('touchmove', guardTouch);
    };
  }, [interactive, pencilOnly]);

  const toNorm = (clientX: number, clientY: number): [number, number] | null => {
    const el = svgRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return [(clientX - rect.left) / rect.width, (clientY - rect.top) / rect.height];
  };

  const eraseAt = (nx: number, ny: number) => {
    if (!strokes?.length) return;
    for (const s of strokes) {
      if (erasedRef.current.has(s.id)) continue;
      if (strokeHitsPoint(s, nx, ny)) {
        erasedRef.current.add(s.id);
        void db.inks.delete(s.id);
      }
    }
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!interactive) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Palm rejection: ignore finger/palm touches when pencilOnly is enabled
    if (pencilOnly && e.pointerType === 'touch') return;
    if (activePointer.current !== null) return;

    const pt = toNorm(e.clientX, e.clientY);
    if (!pt) return;

    e.stopPropagation();
    activePointer.current = e.pointerId;
    activePenRef.current = e.pointerType === 'pen';
    // Support Android S-Pen / stylus side eraser button & tail eraser (`button === 5` or `buttons & 32`)
    const stylusEraser = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0);
    erasingByStylusBtnRef.current = stylusEraser;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore capture failure */
    }

    if (inkTool === 'eraser' || stylusEraser) {
      erasedRef.current = new Set();
      eraseAt(pt[0], pt[1]);
      return;
    }

    const p = e.pointerType === 'pen' ? e.pressure : 0.5;
    const start = appendInkPoint([], pt[0], pt[1], p, 0);
    draftRef.current = start;
    setDraft(start);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (activePointer.current !== e.pointerId) return;
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];

    if (inkTool === 'eraser' || erasingByStylusBtnRef.current) {
      for (const ev of events) {
        const pt = toNorm(ev.clientX, ev.clientY);
        if (pt) eraseAt(pt[0], pt[1]);
      }
      return;
    }

    let next = draftRef.current;
    for (const ev of events) {
      const pt = toNorm(ev.clientX, ev.clientY);
      if (!pt) continue;
      const p = ev.pointerType === 'pen' ? ev.pressure : 0.5;
      next = appendInkPoint(next, pt[0], pt[1], p);
    }
    if (next !== draftRef.current) {
      draftRef.current = next;
      setDraft(next);
    }
  };

  const finishStroke = (e: React.PointerEvent<SVGSVGElement>) => {
    if (activePointer.current !== e.pointerId) return;
    activePointer.current = null;
    activePenRef.current = false;
    const wasStylusEraser = erasingByStylusBtnRef.current;
    erasingByStylusBtnRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (inkTool === 'eraser' || wasStylusEraser) {
      erasedRef.current.clear();
      return;
    }
    const pts = draftRef.current;
    draftRef.current = [];
    setDraft(null);
    if (!pts.length) return;
    const kind = inkTool === 'highlighter' ? 'highlighter' : 'pen';
    const stroke: InkStroke = {
      id: uid(),
      docId,
      pageIndex,
      layer,
      kind,
      color: kind === 'highlighter' ? hlColor : penColor,
      width: kind === 'highlighter' ? 16 : penWidth,
      points: pts,
      createdAt: Date.now(),
    };
    void db.inks.add(stroke);
  };

  const hasSaved = !!strokes?.length;
  if (!interactive && !hasSaved) return null;

  const hlStrokes = (strokes ?? []).filter((s) => s.kind === 'highlighter');
  const penStrokes = (strokes ?? []).filter((s) => s.kind === 'pen');
  const draftStroke =
    draft && draft.length && (inkTool === 'pen' || inkTool === 'highlighter')
      ? {
          kind: inkTool,
          color: inkTool === 'highlighter' ? hlColor : penColor,
          width: inkTool === 'highlighter' ? 16 : penWidth,
          points: draft,
        }
      : null;

  return (
    <svg
      ref={svgRef}
      className={`ink-layer${interactive ? ' active' : ''}${inkTool === 'eraser' ? ' eraser' : ''}${interactive && !pencilOnly ? ' lock-touch' : ''}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishStroke}
      onPointerCancel={finishStroke}
    >
      {/* Highlighter strokes rendered underneath with multiply blend */}
      <g className="ink-hl-group">
        {hlStrokes.map((s) => (
          <path
            key={s.id}
            d={pointsToSvgPath(s.points, width, height)}
            stroke={s.color}
            strokeWidth={renderStrokeWidth(s, scale)}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {draftStroke?.kind === 'highlighter' && (
          <path
            d={pointsToSvgPath(draftStroke.points, width, height)}
            stroke={draftStroke.color}
            strokeWidth={renderStrokeWidth(draftStroke, scale)}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </g>
      {/* Crisp Apple Pencil / pen strokes */}
      <g>
        {penStrokes.map((s) => (
          <path
            key={s.id}
            d={pointsToSvgPath(s.points, width, height)}
            stroke={s.color}
            strokeWidth={renderStrokeWidth(s, scale)}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {draftStroke?.kind === 'pen' && (
          <path
            d={pointsToSvgPath(draftStroke.points, width, height)}
            stroke={draftStroke.color}
            strokeWidth={renderStrokeWidth(draftStroke, scale)}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </g>
    </svg>
  );
});
