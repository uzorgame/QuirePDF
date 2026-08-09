/* The signature dialog.
 *
 * You make a signature once and then place it, which is how signing actually
 * works — nobody wants to redraw their name on page four of a lease. It is kept
 * in this browser's local storage and nowhere else: the whole point of the tool
 * is that a signature is the most personal thing in the document, and it has no
 * business on somebody's server.
 *
 * All three tabs end at the same place, a PNG data URL, so the rest of the
 * editor never learns whether it was drawn, typed or photographed. */

const STORAGE_KEY = 'quire.signature';
const PAD_W = 460;
const PAD_H = 150;

export class SignatureDialog {
  private canvas: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D;
  private drawing = false;
  private strokes = 0;
  private mode: 'draw' | 'type' | 'upload' = 'draw';
  private uploaded: string | null = null;
  private ink = '#111111';
  private onDone: (src: string) => void = () => {};

  constructor(private overlay: HTMLElement) {
    this.canvas = overlay.querySelector('canvas')!;
    this.canvas.width = PAD_W * 2;
    this.canvas.height = PAD_H * 2;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
    this.ctx2d = ctx;
    this.ctx2d.scale(2, 2);
    this.reset();

    this.bindPad();
    this.bindChrome();
  }

  onPlace(fn: (src: string) => void): void { this.onDone = fn; }

  /** The signature from a previous visit, if there is one. */
  static saved(): string | null {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  }

  static forget(): void {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* private mode */ }
  }

  open(): void {
    this.overlay.classList.add('on');
    this.setMode('draw');
  }

  close(): void { this.overlay.classList.remove('on'); }

  /* ── the drawing pad ──────────────────────────────── */

  private reset(): void {
    this.ctx2d.clearRect(0, 0, PAD_W, PAD_H);
    this.ctx2d.lineWidth = 2.6;
    this.ctx2d.lineCap = 'round';
    this.ctx2d.lineJoin = 'round';
    this.ctx2d.strokeStyle = this.ink;
    this.strokes = 0;
  }

  private padPoint(e: PointerEvent): {x: number; y: number} {
    const r = this.canvas.getBoundingClientRect();
    return {x: ((e.clientX - r.left) / r.width) * PAD_W, y: ((e.clientY - r.top) / r.height) * PAD_H};
  }

  private bindPad(): void {
    this.canvas.addEventListener('pointerdown', e => {
      if (this.mode !== 'draw') return;
      this.drawing = true;
      this.strokes++;
      this.canvas.setPointerCapture(e.pointerId);
      const p = this.padPoint(e);
      this.ctx2d.beginPath();
      this.ctx2d.moveTo(p.x, p.y);
      this.hint(false);
    });
    this.canvas.addEventListener('pointermove', e => {
      if (!this.drawing) return;
      const p = this.padPoint(e);
      this.ctx2d.lineTo(p.x, p.y);
      this.ctx2d.stroke();
    });
    for (const ev of ['pointerup', 'pointercancel'] as const) {
      this.canvas.addEventListener(ev, () => { this.drawing = false; });
    }
  }

  private hint(show: boolean): void {
    const el = this.overlay.querySelector<HTMLElement>('.sig-hint');
    if (el) el.hidden = !show;
  }

  /* ── chrome ───────────────────────────────────────── */

  private bindChrome(): void {
    this.overlay.querySelectorAll<HTMLElement>('[data-sigmode]').forEach(btn => {
      btn.addEventListener('click', () => this.setMode(btn.dataset['sigmode'] as typeof this.mode));
    });

    const typed = this.overlay.querySelector<HTMLInputElement>('#sigTyped');
    typed?.addEventListener('input', () => this.renderTyped(typed.value));

    /* Changing the ink redraws whatever is on the pad, so the choice is visible
       immediately rather than only on the next stroke. */
    this.overlay.querySelector('#sigInk')?.addEventListener('click', e => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-ink]');
      if (!btn) return;
      for (const b of this.overlay.querySelectorAll('[data-ink]')) {
        b.setAttribute('aria-pressed', String(b === btn));
      }
      this.ink = btn.dataset['ink']!;
      if (this.mode === 'type') this.renderTyped(typed?.value ?? '');
      else if (this.mode === 'draw') this.reset();
    });

    this.overlay.querySelector('#sigUpload')?.addEventListener('click', () => this.pickFile());
    this.overlay.querySelector('#sigClear')?.addEventListener('click', () => {
      this.reset();
      this.uploaded = null;
      if (typed) typed.value = '';
      this.hint(this.mode === 'draw');
    });

    this.overlay.querySelector('#sigPlace')?.addEventListener('click', () => this.place());
    this.overlay.querySelectorAll('[data-close]').forEach(b =>
      b.addEventListener('click', () => this.close()));
    this.overlay.addEventListener('mousedown', e => { if (e.target === this.overlay) this.close(); });
  }

  private setMode(mode: 'draw' | 'type' | 'upload'): void {
    this.mode = mode;
    for (const b of this.overlay.querySelectorAll<HTMLElement>('[data-sigmode]')) {
      b.setAttribute('aria-pressed', String(b.dataset['sigmode'] === mode));
    }
    const typed = this.overlay.querySelector<HTMLElement>('#sigTypeRow');
    if (typed) typed.hidden = mode !== 'type';
    const upload = this.overlay.querySelector<HTMLElement>('#sigUploadRow');
    if (upload) upload.hidden = mode !== 'upload';
    this.reset();
    this.uploaded = null;
    this.hint(mode === 'draw');
  }

  private renderTyped(value: string): void {
    this.reset();
    if (!value.trim()) { this.hint(false); return; }
    this.ctx2d.fillStyle = this.ink;
    /* A signature face if the system has one, and something cursive-ish if not.
       The list ends in `cursive` so every platform lands somewhere sensible. */
    this.ctx2d.font = `44px "Segoe Script", "Brush Script MT", "Snell Roundhand", cursive`;
    this.ctx2d.textBaseline = 'middle';
    const w = this.ctx2d.measureText(value).width;
    this.ctx2d.fillText(value, Math.max(16, (PAD_W - w) / 2), PAD_H / 2);
    this.strokes = 1;
    this.hint(false);
  }

  private pickFile(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        this.uploaded = String(reader.result);
        const img = new Image();
        img.onload = () => {
          this.reset();
          /* Fit inside the pad without distorting it — a stretched signature
             stops looking like the person's hand. */
          const k = Math.min(PAD_W / img.width, PAD_H / img.height);
          const w = img.width * k, h = img.height * k;
          this.ctx2d.drawImage(img, (PAD_W - w) / 2, (PAD_H - h) / 2, w, h);
          this.strokes = 1;
          this.hint(false);
        };
        img.src = this.uploaded;
      };
      reader.readAsDataURL(f);
    };
    input.click();
  }

  private place(): void {
    if (!this.strokes) return;
    /* An uploaded photo keeps its own bytes; anything drawn or typed is read
       back off the pad. Either way the rest of the editor sees one PNG. */
    const src = this.uploaded ?? this.canvas.toDataURL('image/png');
    try { localStorage.setItem(STORAGE_KEY, src); } catch { /* private mode */ }
    this.close();
    this.onDone(src);
  }
}
