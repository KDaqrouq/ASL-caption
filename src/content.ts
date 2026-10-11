import overlayCss from './overlay.css?raw';
import { GLOSSES, PHRASES, shortPhrase } from './phrases';
import { trimToHands } from './recognition/features';
import { Recognizer } from './recognition/recognizer';
import { Segmenter } from './recognition/segmenter';
import type { Frame, Prediction, Sample } from './recognition/types';
import { CONNECT, type CameraMessage, type ControlMessage } from './messages';
import * as store from './storage';

const HOST_ID = 'asl-meet-captions-host';
const HIGH_CONFIDENCE = 0.66;
const SUBTITLE_MS = 4000;
/** Translate uses a sign that ended at most this long ago. */
const RECENT_SIGN_MS = 4000;
/** Translate pressed mid-sign waits at most this long for the sign to finish. */
const WAIT_FOR_SIGN_MS = 3000;
const COUNTDOWN_STEPS = 3;
const COUNTDOWN_STEP_MS = 600;
const RECORD_TIMEOUT_MS = 6000;
const SUGGESTED_EXAMPLES = 5;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, className = '', title?: string): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  if (title) {
    b.title = title;
    b.setAttribute('aria-label', title);
  }
  return b;
}

/** True when a key press is meant for a text field (also inside shadow roots). */
function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.composedPath()[0];
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || !!t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}

const pct = (c: number) => `${Math.round(c * 100)}%`;

type TeachRow = { count: HTMLElement; record: HTMLButtonElement; undo: HTMLButtonElement };

class MeetCaptionsApp {
  private tracking: 'loading' | 'ready' | 'error' = 'loading';
  private trackingError = '';
  private cameraError: string | null = null;
  private port: MessagePort | null = null;
  private segmenter = new Segmenter();
  private samples: Sample[] = [];
  private model = new Recognizer([], PHRASES.length);
  private settings: store.Settings = { autoCaption: false };

  /** Most recent completed sign, so Translate can caption it after the fact. */
  private lastSign: { frames: Frame[]; endedAt: number; used: boolean } | null = null;
  private pendingTranslateUntil: number | null = null;
  private recording: { phrase: number; until: number } | null = null;
  private countdownTimer: ReturnType<typeof setTimeout> | null = null;

  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private subtitleClearTimer: ReturnType<typeof setTimeout> | null = null;
  private triggerLock = false;

  /** Shadow-tree root; overlays must live here (light-DOM children of the host are not rendered). */
  private uiRoot!: HTMLElement;
  private panel!: HTMLElement;
  private cameraFrame!: HTMLIFrameElement;
  private statusEl!: HTMLElement;
  private subtitleEl!: HTMLElement;
  private subtitleWrap!: HTMLElement;
  private autoCheckbox!: HTMLInputElement;
  private teachBtn!: HTMLButtonElement;
  private teachEl!: HTMLElement;
  private teachRows: TeachRow[] = [];
  private evalEl!: HTMLElement;
  private fallbackEl: HTMLElement | null = null;

  async mount(root: HTMLElement): Promise<void> {
    this.uiRoot = root;
    this.buildUi(root);
    this.setTracking('loading');
    this.setStatus('Loading hand tracking…');
    this.connectCamera();

    const [samples, settings] = await Promise.all([store.loadSamples(), store.loadSettings()]);
    this.samples = samples;
    this.settings = settings;
    this.autoCheckbox.checked = settings.autoCaption;
    this.rebuildModel();
    this.refreshStatus();
    window.addEventListener('keydown', this.onGlobalKeydown, true);
  }

  /** Opens a private channel to the camera frame once it has loaded. */
  private connectCamera(): void {
    const connect = () => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e: MessageEvent<CameraMessage>) => this.onCameraMessage(e.data);
      this.port?.close();
      this.port = channel.port1;
      this.cameraFrame.contentWindow?.postMessage(CONNECT, new URL(chrome.runtime.getURL('')).origin, [channel.port2]);
    };
    this.cameraFrame.addEventListener('load', connect);
  }

  private onCameraMessage(msg: CameraMessage): void {
    switch (msg.type) {
      case 'frame':
        this.onFrame(msg.frame);
        break;
      case 'camera':
        this.cameraError = msg.ok ? null : (msg.error ?? 'unknown error');
        this.refreshStatus();
        break;
      case 'status':
        this.setTracking(msg.tracking);
        this.trackingError = msg.error ?? '';
        this.refreshStatus();
        break;
    }
  }

  private refreshStatus(): void {
    if (this.cameraError) {
      this.setStatus(`Camera blocked: ${this.cameraError}. Allow the webcam for meet.google.com.`);
    } else if (this.tracking === 'error') {
      this.setStatus(`Hand tracking could not start (${this.trackingError}). Try reloading the page.`);
    } else if (this.tracking === 'loading') {
      this.setStatus('Loading hand tracking…');
    } else {
      this.setIdleStatus();
    }
  }

  private sendControl(msg: ControlMessage): void {
    this.port?.postMessage(msg);
  }

  // ---------------------------------------------------------------- UI

  private buildUi(root: HTMLElement): void {
    this.panel = el('div', 'asl-panel');

    // Webcam preview and hand tracking live in an extension frame (see camera.ts).
    this.cameraFrame = el('iframe', 'asl-camera');
    this.cameraFrame.allow = 'camera';
    this.cameraFrame.title = 'ASL captions camera';
    this.cameraFrame.tabIndex = -1;
    this.cameraFrame.src = chrome.runtime.getURL('camera.html');

    const translateBtn = button('Translate', 'asl-primary', 'Caption the last sign (Space)');
    translateBtn.addEventListener('click', () => void this.onTranslate());
    this.teachBtn = button('Teach', 'asl-secondary', 'Record examples of each phrase');
    this.teachBtn.setAttribute('aria-expanded', 'false');
    this.teachBtn.addEventListener('click', () => this.toggleTeach());
    const row = el('div', 'asl-row');
    row.append(translateBtn, this.teachBtn);

    this.statusEl = el('div', 'asl-status');
    this.statusEl.setAttribute('role', 'status');

    const autoLabel = el('label', 'asl-auto-row');
    this.autoCheckbox = el('input');
    this.autoCheckbox.type = 'checkbox';
    this.autoCheckbox.addEventListener('change', () => {
      this.settings = { ...this.settings, autoCaption: this.autoCheckbox.checked };
      void store.saveSettings(this.settings);
      this.setIdleStatus();
    });
    autoLabel.append(this.autoCheckbox, el('span', '', 'Auto-caption each sign'));

    this.teachEl = this.buildTeachSection();
    this.teachEl.hidden = true;

    this.panel.append(this.cameraFrame, row, this.statusEl, autoLabel, this.teachEl);

    this.subtitleWrap = el('div', 'asl-subtitle-wrap');
    this.subtitleWrap.style.display = 'none';
    this.subtitleEl = el('div', 'asl-subtitle');
    this.subtitleEl.setAttribute('aria-live', 'polite');
    this.subtitleWrap.appendChild(this.subtitleEl);

    root.append(this.panel, this.subtitleWrap);
  }

  private buildTeachSection(): HTMLElement {
    const section = el('div', 'asl-teach');
    section.appendChild(
      el(
        'p',
        'asl-hint',
        `Record each phrase about ${SUGGESTED_EXAMPLES} times: press ●, wait for the countdown, sign once, then lower your hands.`,
      ),
    );

    const list = el('div', 'asl-teach-list');
    PHRASES.forEach((_, i) => {
      const item = el('div', 'asl-teach-row');
      const label = el('span', 'asl-teach-label', shortPhrase(i));
      label.title = `Suggested sign: ${GLOSSES[i]}`;
      const count = el('span', 'asl-count', '0');
      const record = button('●', 'asl-rec', `Record an example of “${shortPhrase(i)}”`);
      record.addEventListener('click', () => this.startRecording(i));
      const undo = button('↶', 'asl-undo', `Delete the last example of “${shortPhrase(i)}”`);
      undo.addEventListener('click', () => this.deleteLastSample(i));
      item.append(label, count, record, undo);
      list.appendChild(item);
      this.teachRows.push({ count, record, undo });
    });
    section.appendChild(list);

    this.evalEl = el('div', 'asl-eval');
    section.appendChild(this.evalEl);

    const tools = el('div', 'asl-tools');
    const selfTest = button('Self-test', '', 'Estimate accuracy by classifying each example against the others');
    selfTest.addEventListener('click', () => this.runSelfTest());
    const exportBtn = button('Export', '', 'Download your examples as a file');
    exportBtn.addEventListener('click', () => this.exportSamples());
    const fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json,.json';
    fileInput.hidden = true;
    fileInput.addEventListener('change', () => void this.importSamples(fileInput));
    const importBtn = button('Import', '', 'Add examples from an exported file');
    importBtn.addEventListener('click', () => fileInput.click());
    const clearBtn = button('Clear', 'asl-danger', 'Delete all examples');
    let armed: ReturnType<typeof setTimeout> | null = null;
    clearBtn.addEventListener('click', () => {
      if (!armed) {
        clearBtn.textContent = 'Sure?';
        armed = setTimeout(() => {
          armed = null;
          clearBtn.textContent = 'Clear';
        }, 3000);
        return;
      }
      clearTimeout(armed);
      armed = null;
      clearBtn.textContent = 'Clear';
      void this.replaceSamples([], 'Deleted all examples.');
    });
    tools.append(selfTest, exportBtn, importBtn, clearBtn, fileInput);
    section.appendChild(tools);
    return section;
  }

  private toggleTeach(): void {
    const open = this.teachEl.hidden !== false;
    this.teachEl.hidden = !open;
    this.panel.classList.toggle('asl-teaching', open);
    this.teachBtn.setAttribute('aria-expanded', String(open));
  }

  private refreshTeachCounts(): void {
    const counts = new Array<number>(PHRASES.length).fill(0);
    for (const s of this.samples) counts[s.phrase]++;
    this.teachRows.forEach((row, i) => {
      row.count.textContent = String(counts[i]);
      row.count.classList.toggle('asl-enough', counts[i] >= SUGGESTED_EXAMPLES);
      row.undo.disabled = counts[i] === 0;
    });
    this.panel.dataset.samples = String(this.samples.length);
    this.evalEl.textContent = '';
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  private setTracking(state: 'loading' | 'ready' | 'error'): void {
    this.tracking = state;
    this.panel.dataset.tracking = state;
  }

  private setIdleStatus(): void {
    if (this.tracking !== 'ready' || this.cameraError) return;
    if (this.model.sampleCount === 0) {
      this.setStatus('No signs taught yet. Click Teach to record your phrases.');
    } else if (this.settings.autoCaption) {
      this.setStatus('Sign a phrase; captions appear automatically.');
    } else {
      this.setStatus('Sign a phrase, then press Space or Translate.');
    }
  }

  // ---------------------------------------------------------------- frame loop

  private onFrame(frame: Frame): void {
    this.panel.dataset.hands = String(frame.hands.length);

    const sign = this.segmenter.push(frame);
    this.panel.classList.toggle('asl-signing', this.segmenter.active);
    if (sign) this.onSign(sign);

    const now = performance.now();
    if (this.recording && now > this.recording.until) {
      const frames = this.segmenter.flush();
      if (frames) this.onSign(frames);
      else this.finishRecording(null);
    }
    if (this.pendingTranslateUntil !== null && now > this.pendingTranslateUntil) {
      this.pendingTranslateUntil = null;
      const frames = this.segmenter.flush();
      if (frames) this.translate(frames, true);
      else this.setStatus("I didn't catch a complete sign. Try again.");
    }
  }

  // ---------------------------------------------------------------- recognition

  private rebuildModel(): void {
    this.model = new Recognizer(this.samples, PHRASES.length);
    this.refreshTeachCounts();
  }

  private onSign(frames: Frame[]): void {
    if (this.recording) {
      this.finishRecording(frames);
      return;
    }
    if (this.countdownTimer) return;
    this.lastSign = { frames, endedAt: performance.now(), used: false };
    if (this.pendingTranslateUntil !== null) {
      this.pendingTranslateUntil = null;
      this.translate(frames, true);
    } else if (this.settings.autoCaption && this.model.sampleCount > 0) {
      this.translate(frames, false);
    } else if (this.model.sampleCount > 0) {
      this.setStatus('Sign captured. Press Space or Translate to caption it.');
    }
  }

  private onGlobalKeydown = (e: KeyboardEvent): void => {
    if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    void this.onTranslate();
  };

  private async onTranslate(): Promise<void> {
    if (this.triggerLock || this.recording || this.countdownTimer) return;
    this.triggerLock = true;
    setTimeout(() => {
      this.triggerLock = false;
    }, 400);
    this.closeFallback();

    if (this.tracking !== 'ready' || this.cameraError) {
      this.setStatus('Hand tracking is not running; choose the phrase instead.');
      this.showFallback(null, null);
      return;
    }
    if (this.model.sampleCount === 0) {
      this.setStatus('No signs taught yet. Click Teach to record your phrases.');
      this.showFallback(null, null);
      return;
    }

    const last = this.lastSign;
    if (last && !last.used && performance.now() - last.endedAt < RECENT_SIGN_MS) {
      this.translate(last.frames, true);
    } else if (this.segmenter.active) {
      this.pendingTranslateUntil = performance.now() + WAIT_FOR_SIGN_MS;
      this.setStatus('Finish the sign…');
    } else {
      const recent = trimToHands(this.segmenter.recent(2500));
      if (recent.filter((f) => f.hands.length > 0).length >= 6) {
        this.translate(recent, true);
      } else {
        this.setStatus("I didn't see a sign. Sign a phrase, then press Space.");
      }
    }
  }

  /** Classifies a sign; `manual` means the user asked (Space/Translate) rather than auto-caption. */
  private translate(frames: Frame[], manual: boolean): void {
    const pred = this.model.classify(frames);
    if (this.lastSign?.frames === frames) this.lastSign.used = true;
    this.panel.dataset.lastPrediction = pred ? `${pred.index}:${pred.confidence.toFixed(2)}` : 'none';

    if (pred && pred.confidence >= HIGH_CONFIDENCE) {
      this.showSubtitle(PHRASES[pred.index]);
      this.setStatus(`Recognised “${shortPhrase(pred.index)}” (${pct(pred.confidence)}).`);
    } else if (manual) {
      this.setStatus('Not sure about that one. Confirm or pick the phrase.');
      this.showFallback(pred, frames);
    } else {
      // Auto mode never interrupts with a dialog; Space reviews the uncertain sign.
      if (this.lastSign?.frames === frames) this.lastSign.used = false;
      this.setStatus(
        pred
          ? `Not sure (maybe “${shortPhrase(pred.index)}”, ${pct(pred.confidence)}). Press Space to review.`
          : 'Sign not recognised.',
      );
    }
  }

  /** Stores a corrected or confirmed sign as a new example, so the model adapts over time. */
  private learn(phrase: number, frames: Frame[] | null): void {
    if (!frames || frames.length === 0) return;
    void this.replaceSamples(store.withSample(this.samples, phrase, frames), `Learned this sign as “${shortPhrase(phrase)}”.`);
  }

  // ---------------------------------------------------------------- teaching

  private startRecording(phrase: number): void {
    if (this.recording || this.countdownTimer) return;
    if (this.tracking !== 'ready' || this.cameraError) {
      this.setStatus('Hand tracking is not running, so examples cannot be recorded.');
      return;
    }
    this.closeFallback();
    this.pendingTranslateUntil = null;
    this.panel.classList.add('asl-recording');
    let n = COUNTDOWN_STEPS;
    const step = () => {
      if (n > 0) {
        this.setStatus(`Get ready to sign “${shortPhrase(phrase)}”… ${n}`);
        n--;
        this.countdownTimer = setTimeout(step, COUNTDOWN_STEP_MS);
        return;
      }
      this.countdownTimer = null;
      this.segmenter.arm();
      this.recording = { phrase, until: performance.now() + RECORD_TIMEOUT_MS };
      this.sendControl({ type: 'recording', on: true });
      this.setStatus(`Sign “${shortPhrase(phrase)}” now, then lower your hands.`);
    };
    step();
  }

  private finishRecording(frames: Frame[] | null): void {
    const rec = this.recording;
    this.recording = null;
    this.panel.classList.remove('asl-recording');
    this.sendControl({ type: 'recording', on: false });
    if (!rec) return;
    if (!frames) {
      this.setStatus("I didn't see a sign. Make sure your hands are in view and try again.");
      return;
    }
    const count = this.samples.filter((s) => s.phrase === rec.phrase).length + 1;
    void this.replaceSamples(
      store.withSample(this.samples, rec.phrase, frames),
      `Saved example ${Math.min(count, store.MAX_SAMPLES_PER_PHRASE)} of “${shortPhrase(rec.phrase)}”.`,
    );
  }

  private deleteLastSample(phrase: number): void {
    let idx = -1;
    this.samples.forEach((s, i) => {
      if (s.phrase === phrase) idx = i;
    });
    if (idx < 0) return;
    void this.replaceSamples(
      this.samples.filter((_, i) => i !== idx),
      `Deleted the last example of “${shortPhrase(phrase)}”.`,
    );
  }

  private async replaceSamples(samples: Sample[], message: string): Promise<void> {
    this.samples = samples;
    this.rebuildModel();
    this.setStatus(message);
    try {
      await store.saveSamples(samples);
    } catch (e) {
      this.setStatus(`Could not save examples: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private runSelfTest(): void {
    const ev = this.model.evaluate();
    if (ev.accuracy === null) {
      this.evalEl.textContent = 'Teach at least two phrases to run a self-test.';
      return;
    }
    const weak = ev.perPhrase
      .map((p, i) => ({ ...p, i }))
      .filter((p) => p.total > 0 && p.correct / p.total < 0.8)
      .map((p) => `“${shortPhrase(p.i)}”`);
    this.evalEl.textContent =
      `Self-test: ${pct(ev.accuracy)} of examples recognised.` +
      (weak.length ? ` Add more examples of ${weak.join(', ')}.` : '');
  }

  private exportSamples(): void {
    const blob = new Blob([store.exportJson(this.samples)], { type: 'application/json' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'asl-meet-captions-examples.json';
    this.uiRoot.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  private async importSamples(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const added = store.importJson(await file.text()).filter((s) => s.phrase < PHRASES.length);
      let merged = this.samples;
      for (const s of added) merged = store.withSample(merged, s.phrase, s.frames);
      await this.replaceSamples(merged, `Imported ${added.length} examples.`);
    } catch (e) {
      this.setStatus(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---------------------------------------------------------------- captions

  private showSubtitle(caption: string): void {
    if (this.fadeTimer) clearTimeout(this.fadeTimer);
    if (this.subtitleClearTimer) clearTimeout(this.subtitleClearTimer);

    this.subtitleEl.classList.remove('asl-fade');
    this.subtitleEl.textContent = caption;
    this.subtitleWrap.style.display = 'block';

    this.fadeTimer = setTimeout(() => {
      this.subtitleEl.classList.add('asl-fade');
    }, SUBTITLE_MS);

    this.subtitleClearTimer = setTimeout(() => {
      this.subtitleEl.textContent = '';
      this.subtitleWrap.style.display = 'none';
      this.subtitleEl.classList.remove('asl-fade');
    }, SUBTITLE_MS + 500);
  }

  private showFallback(pred: Prediction | null, frames: Frame[] | null): void {
    this.closeFallback();
    const card = el('div', 'asl-fallback');
    card.setAttribute('role', 'dialog');

    card.appendChild(el('h3', '', pred ? 'Low confidence' : 'Choose a phrase'));
    if (pred) {
      card.appendChild(el('div', 'asl-guess', `Best guess: ${PHRASES[pred.index]} (${pct(pred.confidence)})`));
      const actions = el('div', 'asl-actions');
      const confirmBtn = button('Confirm', 'confirm');
      confirmBtn.addEventListener('click', () => {
        this.showSubtitle(PHRASES[pred.index]);
        this.closeFallback();
        this.learn(pred.index, frames);
      });
      const retryBtn = button('Retry', 'retry');
      retryBtn.addEventListener('click', () => {
        this.closeFallback();
        this.setStatus('Try again: sign the phrase, then press Space or Translate.');
      });
      actions.append(confirmBtn, retryBtn);
      card.appendChild(actions);
      card.appendChild(el('div', 'asl-guess', 'Or choose a phrase:'));
    }

    const select = el('select');
    PHRASES.forEach((p, i) => {
      const opt = el('option', '', p);
      opt.value = String(i);
      if (pred && i === pred.index) opt.selected = true;
      select.appendChild(opt);
    });

    const chooseRow = el('div', 'choose-row');
    const applyBtn = button('Use selection');
    applyBtn.addEventListener('click', () => {
      const i = Number(select.value);
      this.showSubtitle(PHRASES[i]);
      this.closeFallback();
      this.learn(i, frames);
    });
    const cancelBtn = button('Cancel', 'retry');
    cancelBtn.addEventListener('click', () => this.closeFallback());
    chooseRow.append(applyBtn, cancelBtn);

    card.append(select, chooseRow);
    this.uiRoot.appendChild(card);
    this.fallbackEl = card;
  }

  private closeFallback(): void {
    this.fallbackEl?.remove();
    this.fallbackEl = null;
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onGlobalKeydown, true);
    this.port?.close();
    this.cameraFrame?.remove();
    if (this.fadeTimer) clearTimeout(this.fadeTimer);
    if (this.subtitleClearTimer) clearTimeout(this.subtitleClearTimer);
    if (this.countdownTimer) clearTimeout(this.countdownTimer);
    this.closeFallback();
  }
}

function main(): void {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = overlayCss;
  shadow.appendChild(style);

  const inner = document.createElement('div');
  inner.setAttribute('data-asl-overlay', '1');
  shadow.appendChild(inner);

  const app = new MeetCaptionsApp();
  void app.mount(inner);
}

main();
