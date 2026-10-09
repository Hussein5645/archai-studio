/**
 * Text layout. Measurement is injected so commands stay deterministic in tests (monospace) and
 * use real font metrics in the browser (canvas).
 */
export interface TextMeasurer {
  measureWidth(text: string, fontSize: number): number;
}

export const FONT_FAMILY = "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif";
export const LINE_HEIGHT = 1.3;

export interface TextLayout {
  lines: string[];
  height: number;
}

export const monospaceMeasurer: TextMeasurer = {
  measureWidth: (text, fontSize) => text.length * fontSize * 0.6,
};

let canvasContext: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

export const canvasMeasurer: TextMeasurer = {
  measureWidth(text, fontSize) {
    if (!canvasContext) {
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
      canvasContext = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!canvasContext) return monospaceMeasurer.measureWidth(text, fontSize);
    }
    canvasContext.font = `${fontSize}px ${FONT_FAMILY}`;
    return canvasContext.measureText(text).width;
  },
};

function breakLongWord(word: string, fontSize: number, maxWidth: number, measurer: TextMeasurer): string[] {
  const parts: string[] = [];
  let current = '';
  for (const char of word) {
    const candidate = current + char;
    if (current !== '' && measurer.measureWidth(candidate, fontSize) > maxWidth) {
      parts.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current !== '') parts.push(current);
  return parts;
}

/** Greedy word wrap honouring explicit newlines; over-long words are broken by character. */
export function layoutText(text: string, fontSize: number, maxWidth: number, measurer: TextMeasurer): TextLayout {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(' ');
    let current = '';
    for (const word of words) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if (measurer.measureWidth(candidate, fontSize) <= maxWidth || maxWidth <= 0) {
        current = candidate;
        continue;
      }
      if (current !== '') lines.push(current);
      const pieces = measurer.measureWidth(word, fontSize) > maxWidth ? breakLongWord(word, fontSize, maxWidth, measurer) : [word];
      current = pieces.pop() ?? '';
      lines.push(...pieces);
    }
    lines.push(current);
  }
  return { lines, height: Math.max(1, lines.length) * fontSize * LINE_HEIGHT };
}
